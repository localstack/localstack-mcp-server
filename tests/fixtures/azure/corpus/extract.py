"""C06 step 1: statically extract every `az` invocation from the sample shell scripts.

A small bash lexer (quotes, escapes, line continuations, comments, heredocs, $VAR, ${...}, $(...),
backticks, $((...)), <(...), arrays, `eval`-style helper strings). Every simple command is
collected, recursively inside substitutions; a command whose name word is `az` becomes a corpus
entry. Words are "rendered": the source text with the quoting kept, continuations removed and
every expansion replaced by a deterministic placeholder word, so the rendered command is what a
model would send, and bash splits it into the argv the sample passes to az (modulo values).

Nothing is executed. Output: extracted.json next to this file.
"""
import bisect
import collections
import json
import os
import pathlib
import re
import subprocess

# The localstack-azure-samples checkout to scan (C06 used commit 4193d67). Set
# AZURE_SAMPLES_DIR so DR8's weekly job can point it at any pinned checkout; the default is
# a sibling checkout of this repository.
ROOT = pathlib.Path(
    os.environ.get(
        "AZURE_SAMPLES_DIR",
        str(pathlib.Path(__file__).resolve().parents[4].parent / "localstack-azure-samples"),
    )
)
# extracted.json goes to CORPUS_WORK_DIR (DR8 uses a temp dir), by default next to this file.
OUT = pathlib.Path(os.environ.get("CORPUS_WORK_DIR", str(pathlib.Path(__file__).parent))) / "extracted.json"

# Raw mention detector, used only to reconcile the parser against the text.
RAW_AZ = re.compile(r"(?<![A-Za-z0-9_./-])az(?=[ \t]+[-a-z])")
PREFIX_WORDS = {"if", "then", "elif", "else", "do", "while", "until", "!", "time", "{", "}"}
NON_COMMAND_STARTS = {"for", "case", "select", "[[", "[", "function", "test"}
ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=")
ARRAY_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=$")
OPS = [";;&", "<<<", "<<-", "&>>", "||", "&&", "|&", ";;", ";&", "<<", ">>", "<&", ">&", "<>", ">|",
       "&>", "|", "&", ";", "<", ">"]
REDIRECT_OPS = {"<", ">", ">>", "<<", "<<-", "<<<", "&>", "&>>", "<&", ">&", "<>", ">|"}
SPECIAL_PARAMS = {"@": "x_at", "*": "x_star", "#": "x_argc", "?": "x_status", "$": "x_pid",
                  "!": "x_bgpid", "-": "x_flags"}
WORD_END = set(" \t\n;&|()<>")


class ParseError(Exception):
    pass


def bash_unquote(w):
    """Quote removal for ONE rendered word (no expansions left in it), bash rules."""
    out = []
    i, n = 0, len(w)
    while i < n:
        c = w[i]
        if c == "\\":
            if i + 1 < n:
                if w[i + 1] != "\n":
                    out.append(w[i + 1])
                i += 2
            else:
                out.append(c)
                i += 1
            continue
        if c == "'":
            j = w.index("'", i + 1)
            out.append(w[i + 1:j])
            i = j + 1
            continue
        if c == '"':
            i += 1
            while w[i] != '"':
                if w[i] == "\\" and i + 1 < n and w[i + 1] in '$`"\\\n':
                    if w[i + 1] != "\n":
                        out.append(w[i + 1])
                    i += 2
                    continue
                out.append(w[i])
                i += 1
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


class Word:
    __slots__ = ("rendered", "start", "end", "line", "flags")

    def __init__(self, rendered, start, end, line, flags):
        self.rendered, self.start, self.end, self.line, self.flags = rendered, start, end, line, flags


class Sink:
    def __init__(self):
        self.commands = []
        self.skipped = collections.Counter()
        self.skipped_examples = collections.defaultdict(list)
        self.mentions = collections.Counter()
        self.mention_examples = collections.defaultdict(list)
        self.tracked_vars = []
        self.heredocs = []


class Parser:
    def __init__(self, text, rel, sink, line_base=0, via="direct", tracked=None, origin=None, file_parser=True):
        self.s = text
        self.n = len(text)
        self.rel = rel
        self.sink = sink
        self.nl = [i for i, c in enumerate(text) if c == "\n"]
        self.line_base = line_base
        self.via_stack = [via]
        self.tracked = tracked if tracked is not None else {}
        self.pending_heredocs = []
        self.origin = origin  # outer Word for eval/backtick sub-parsers
        self.file_parser = file_parser
        # reconciliation bookkeeping (file parser only)
        self.az_positions = set()
        self.covered_spans = []

    # ------------------------------------------------------------------ helpers
    def line_of(self, i):
        return bisect.bisect_left(self.nl, i) + 1 + self.line_base

    def cover(self, a, b):
        if self.file_parser:
            self.covered_spans.append((a, b))
        elif self.origin is not None and self.origin[0] is not None:
            self.origin[0].covered_spans.append(self.origin[1])

    def match_op(self, i):
        for op in OPS:
            if self.s.startswith(op, i):
                return op
        return None

    def skip_blanks(self, i):
        s, n = self.s, self.n
        while i < n:
            if s[i] in " \t":
                i += 1
            elif s[i] == "\\" and i + 1 < n and s[i + 1] == "\n":
                i += 2
            else:
                break
        return i

    # ------------------------------------------------------------------ lists
    def parse_all(self):
        i = self.parse_list(0, None)
        if i < self.n:
            raise ParseError(f"stopped at {i} of {self.n}")

    def parse_list(self, i, term):
        s, n = self.s, self.n
        words, redirects = [], []
        depth = 0

        def finish():
            if words or redirects:
                self.emit(list(words), list(redirects))
            words.clear()
            redirects.clear()

        while i < n:
            c = s[i]
            if c in " \t":
                i += 1
                continue
            if c == "\\" and i + 1 < n and s[i + 1] == "\n":
                i += 2
                continue
            if c == "\n":
                finish()
                i += 1
                if self.pending_heredocs:
                    i = self.read_heredocs(i)
                continue
            if c == "#":
                j = s.find("\n", i)
                j = n if j < 0 else j
                self.comment(i, j)
                i = j
                continue
            if c == ")":
                if depth > 0:
                    depth -= 1
                    finish()
                    i += 1
                    continue
                if term == ")":
                    finish()
                    return i + 1
                finish()
                i += 1
                continue
            if c == "(" :
                finish()
                depth += 1
                i += 1
                continue
            if c in "<>" and i + 1 < n and s[i + 1] == "(":
                w, i = self.read_word(i)
                words.append(w)
                continue
            op = self.match_op(i)
            if op:
                start = i
                i += len(op)
                if op in REDIRECT_OPS:
                    i = self.skip_blanks(i)
                    if i < n and s[i] not in "\n;&|()<>":
                        target, i = self.read_word(i)
                    else:
                        target = None
                    if op in ("<<", "<<-") and target is not None:
                        raw = target.rendered
                        quoted = any(ch in raw for ch in "'\"\\")
                        self.pending_heredocs.append((bash_unquote(raw), op == "<<-", quoted, target.line))
                    redirects.append((op, target.rendered if target else None, start))
                else:
                    finish()
                continue
            w, i = self.read_word(i)
            if w.rendered.isdigit() and i < n and s[i] in "<>" and not (i + 1 < n and s[i + 1] == "("):
                continue  # IO number (e.g. the 2 of 2>/dev/null): part of the redirection
            if ARRAY_ASSIGN_RE.match(w.rendered) and i < n and s[i] == "(":
                w, i = self.read_array(w, i)
            words.append(w)
        finish()
        return i

    def read_array(self, w, i):
        s, n = self.s, self.n
        i += 1
        elems = []
        while i < n:
            c = s[i]
            if c in " \t\n":
                i += 1
                continue
            if c == "\\" and i + 1 < n and s[i + 1] == "\n":
                i += 2
                continue
            if c == "#":
                j = s.find("\n", i)
                j = n if j < 0 else j
                self.comment(i, j)
                i = j
                continue
            if c == ")":
                i += 1
                break
            e, i = self.read_word(i)
            elems.append(e)
        flags = set(w.flags)
        for e in elems:
            flags |= e.flags
            self.scan_mentions(e, "array-element")
        return Word(w.rendered + "(" + " ".join(e.rendered for e in elems) + ")", w.start, i, w.line, flags | {"array_literal"}), i

    def read_heredocs(self, i):
        s, n = self.s, self.n
        for delim, strip, quoted, line in self.pending_heredocs:
            body_start = i
            body_end = i
            while i < n:
                j = s.find("\n", i)
                j = n if j < 0 else j
                ln = s[i:j]
                chk = ln.lstrip("\t") if strip else ln
                if chk == delim:
                    body_end = i
                    i = j + 1
                    break
                i = j + 1
                body_end = i
            body = s[body_start:body_end]
            k = len(RAW_AZ.findall(body))
            has_subst = (not quoted) and ("$(" in body or "`" in body)
            self.sink.heredocs.append({"file": self.rel, "line": line, "delimiter": delim, "quoted": quoted,
                                       "az_mentions": k, "has_command_substitution": has_subst})
            if k:
                self.sink.mentions["heredoc-body"] += k
            self.cover(body_start, body_end)
        self.pending_heredocs = []
        return i

    def comment(self, a, b):
        text = self.s[a:b]
        k = len(RAW_AZ.findall(text))
        if k:
            self.sink.mentions["comment"] += k
            if len(self.sink.mention_examples["comment"]) < 6:
                self.sink.mention_examples["comment"].append(f"{self.rel}:{self.line_of(a)}: {text.strip()[:140]}")
        for key, pat in (("lstk az", r"\blstk az\b"), ("azlocal", r"\bazlocal\b"), ("azd", r"\bazd\b")):
            m = len(re.findall(pat, text))
            if m:
                self.sink.skipped[f"{key} (in a comment)"] += m
                if len(self.sink.skipped_examples[f"{key} (in a comment)"]) < 4:
                    self.sink.skipped_examples[f"{key} (in a comment)"].append(f"{self.rel}:{self.line_of(a)}: {text.strip()[:140]}")
        self.cover(a, b)

    # ------------------------------------------------------------------ words
    def read_word(self, i):
        s, n = self.s, self.n
        start = i
        out = []
        flags = set()
        if s[i] in "<>" and i + 1 < n and s[i + 1] == "(":
            self.via_stack.append("procsub")
            end = self.parse_list(i + 2, ")")
            self.via_stack.pop()
            flags.add("procsub")
            return Word("x_procsub", start, end, self.line_of(start), flags), end
        while i < n:
            c = s[i]
            if c in WORD_END:
                break
            if c == "\\":
                if i + 1 < n and s[i + 1] == "\n":
                    i += 2
                    continue
                out.append(s[i:i + 2])
                flags.add("backslash_unquoted")
                i += 2
                continue
            if c == "'":
                j = s.find("'", i + 1)
                if j < 0:
                    raise ParseError(f"unterminated ' at line {self.line_of(i)}")
                out.append(s[i:j + 1])
                flags.add("single_quoted")
                if "\n" in s[i:j + 1]:
                    flags.add("multiline_single_quote")
                i = j + 1
                continue
            if c == '"':
                seg, i = self.read_dquote(i, flags)
                out.append(seg)
                flags.add("double_quoted")
                continue
            if c == "`":
                seg, i = self.read_backtick(i, flags)
                out.append(seg)
                continue
            if c == "$":
                seg, i = self.read_dollar(i, flags, quoted=False)
                out.append(seg)
                continue
            if c in "*?[":
                flags.add("glob_chars_unquoted")
            if c == "~" and (not out or "".join(out).endswith(("=", ":"))):
                flags.add("tilde_unquoted")
            if c == "{":
                flags.add("brace_unquoted")
            if ord(c) > 127:
                flags.add("non_ascii")
            out.append(c)
            i += 1
        rendered = "".join(out)
        if "brace_unquoted" in flags and not re.search(r"\{[^{}]*(,|\.\.)[^{}]*\}", rendered):
            flags.discard("brace_unquoted")
        return Word(rendered, start, i, self.line_of(start), flags), i

    def read_dquote(self, i, flags):
        s, n = self.s, self.n
        out = ['"']
        i += 1
        while i < n:
            c = s[i]
            if c == '"':
                out.append('"')
                return "".join(out), i + 1
            if c == "\\" and i + 1 < n:
                nx = s[i + 1]
                if nx == "\n":
                    i += 2
                    continue
                if nx in '$`"\\':
                    out.append(s[i:i + 2])
                    flags.add("dq_escape_" + {"$": "dollar", "`": "backtick", '"': "quote", "\\": "backslash"}[nx])
                    i += 2
                    continue
                out.append("\\")
                flags.add("dq_literal_backslash")
                i += 1
                continue
            if c == "$":
                seg, i = self.read_dollar(i, flags, quoted=True)
                out.append(seg)
                continue
            if c == "`":
                seg, i = self.read_backtick(i, flags)
                out.append(seg)
                continue
            if c == "\n":
                flags.add("multiline_double_quote")
            if ord(c) > 127:
                flags.add("non_ascii")
            out.append(c)
            i += 1
        raise ParseError(f'unterminated " starting line {self.line_of(i)}')

    def read_backtick(self, i, flags):
        s, n = self.s, self.n
        j = i + 1
        buf = []
        while j < n and s[j] != "`":
            if s[j] == "\\" and j + 1 < n and s[j + 1] in "`\\$":
                buf.append(s[j + 1])
                j += 2
                continue
            buf.append(s[j])
            j += 1
        if j >= n:
            raise ParseError(f"unterminated backtick at line {self.line_of(i)}")
        flags.add("backtick_subst")
        sub = Parser("".join(buf), self.rel, self.sink, line_base=self.line_of(i) - 1, via="backtick",
                     tracked=self.tracked, origin=(self if self.file_parser else None, (i, j + 1)),
                     file_parser=False)
        sub.parse_all()
        self.cover(i, j + 1)
        return "x_subst", j + 1

    def read_dollar(self, i, flags, quoted):
        s, n = self.s, self.n
        nx = s[i + 1] if i + 1 < n else ""
        if nx == "(":
            if s.startswith("$((", i):
                j, depth = i + 1, 0
                while j < n:
                    if s[j] == "(":
                        depth += 1
                    elif s[j] == ")":
                        depth -= 1
                        if depth == 0:
                            break
                    j += 1
                flags.add("arith")
                return "x_arith", j + 1
            self.via_stack.append("cmd_subst")
            end = self.parse_list(i + 2, ")")
            self.via_stack.pop()
            flags.add("cmd_subst")
            if not quoted:
                flags.add("expansion_unquoted")
            return "x_subst", end
        if nx == "{":
            j = self.match_brace(i + 1)
            inner = s[i + 2:j]
            m = re.match(r"(#?)([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])", inner)
            name = m.group(2) if m else "expr"
            ph = SPECIAL_PARAMS.get(name) or ("x_" + name.lower())
            if m and m.group(1) == "#" and len(inner) > 1:
                ph = "x_len_" + name.lower()
            if re.search(r"\[[@*]\]", inner) and not inner.startswith("#"):
                flags.add("array_expansion")
            flags.add("var")
            if not quoted:
                flags.add("expansion_unquoted")
            return ph, j + 1
        if nx == "'" and not quoted:
            j = i + 2
            while j < n and s[j] != "'":
                j += 2 if s[j] == "\\" else 1
            flags.add("ansi_c_quote")
            return s[i:j + 1], j + 1
        if nx == '"' and not quoted:
            flags.add("locale_quote")
            return self.read_dquote(i + 1, flags)
        m = re.match(r"[A-Za-z_][A-Za-z0-9_]*", s[i + 1:i + 200])
        if m:
            name = m.group(0)
            flags.add("var")
            if not quoted:
                flags.add("expansion_unquoted")
            return "x_" + name.lower(), i + 1 + len(name)
        if nx.isdigit():
            flags.add("var")
            if not quoted:
                flags.add("expansion_unquoted")
            return "x_" + nx, i + 2
        if nx in SPECIAL_PARAMS:
            flags.add("var")
            if nx in "@*":
                flags.add("array_expansion")
            if not quoted:
                flags.add("expansion_unquoted")
            return SPECIAL_PARAMS[nx], i + 2
        flags.add("literal_dollar")
        return "$", i + 1

    def match_brace(self, i):
        s, n = self.s, self.n
        depth = 0
        j = i
        while j < n:
            c = s[j]
            if c == "\\":
                j += 2
                continue
            if c == "'":
                j = s.index("'", j + 1) + 1
                continue
            if c == '"':
                _, j = self.read_dquote(j, set())
                continue
            if c == "$" and s.startswith("$(", j):
                self.via_stack.append("cmd_subst")
                j = self.parse_list(j + 2, ")")
                self.via_stack.pop()
                continue
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return j
            j += 1
        raise ParseError(f"unterminated ${{ at line {self.line_of(i)}")

    # ------------------------------------------------------------------ commands
    def scan_mentions(self, w, kind):
        try:
            value = bash_unquote(w.rendered)
        except Exception:
            value = w.rendered
        k = len(RAW_AZ.findall(value))
        if k:
            self.sink.mentions[kind] += k
            if len(self.sink.mention_examples[kind]) < 6:
                self.sink.mention_examples[kind].append(f"{self.rel}:{w.line}: {value.strip()[:140]}")
        for key, pat in (("lstk az", r"\blstk az\b"), ("azlocal", r"\bazlocal\b"), ("azd", r"\bazd\b")):
            m = len(re.findall(pat, value))
            if m:
                self.sink.skipped[f"{key} (in a string)"] += m
        self.cover(w.start, w.end)

    def track_assignment(self, w):
        m = ASSIGN_RE.match(w.rendered)
        name = w.rendered[: m.end()].rstrip("=+").split("[")[0]
        value_raw = w.rendered[m.end():]
        try:
            value = bash_unquote(value_raw)
        except Exception:
            value = value_raw
        if re.match(r"az\s+[a-z]", value):
            self.tracked[name] = value
            self.sink.tracked_vars.append({"file": self.rel, "line": w.line, "name": name, "value": value})
            self.sink.mentions["assignment (az-valued variable)"] += len(RAW_AZ.findall(value))
            self.cover(w.start, w.end)
        else:
            self.scan_mentions(w, "assignment")

    def emit(self, words, redirects):
        if not words:
            return
        k = 0
        while k < len(words):
            w = words[k].rendered
            if w in PREFIX_WORDS:
                k += 1
                continue
            if ASSIGN_RE.match(w):
                self.track_assignment(words[k])
                k += 1
                continue
            break
        if k >= len(words):
            return
        first = words[0].rendered
        name = words[k].rendered
        if first in NON_COMMAND_STARTS or name in NON_COMMAND_STARTS:
            for w in words[k:]:
                self.scan_mentions(w, "string (for/case/test word)")
            return
        if name == "az":
            self.add_az(words[k], words[k + 1:], redirects)
            for w in words[k + 1:]:
                v = bash_unquote(w.rendered)
                if RAW_AZ.search(v):
                    self.sink.mentions["inside an az argument"] += len(RAW_AZ.findall(v))
            return
        if name in ("azlocal", "azd"):
            self.sink.skipped[f"{name} (command)"] += 1
            self.sink.skipped_examples[f"{name} (command)"].append(f"{self.rel}:{words[k].line}")
            return
        if name == "lstk" and k + 1 < len(words) and words[k + 1].rendered == "az":
            self.sink.skipped["lstk az (command)"] += 1
            self.sink.skipped_examples["lstk az (command)"].append(f"{self.rel}:{words[k].line}")
            return
        if name in ("check", "check_output") and k + 2 < len(words):
            self.eval_word(words[k + 2], f"{name} (evals its 2nd argument)")
            for j, w in enumerate(words[k:], start=k):
                if j != k + 2:
                    self.scan_mentions(w, "string (echo/printf/helper text)")
            return
        if name == "eval" and k + 1 < len(words):
            if len(words) - k - 1 == 1:
                self.eval_word(words[k + 1], "eval")
            else:
                raise ParseError(f"multi-word eval at {self.rel}:{words[k].line}")
            return
        for w in words[k:]:
            self.scan_mentions(w, "string (echo/printf/helper text)")

    def eval_word(self, w, how):
        value = bash_unquote(w.rendered)
        expanded_from = None
        for name, val in self.tracked.items():
            ph = "x_" + name.lower()
            if value == ph or value.startswith(ph + " "):
                value = val + value[len(ph):]
                expanded_from = name
        if not RAW_AZ.match(value.lstrip()) and not value.lstrip().startswith("az "):
            self.scan_mentions(w, "string (echo/printf/helper text)")
            return
        sub = Parser(value, self.rel, self.sink, line_base=w.line - 1,
                     via="eval" + (f" (${expanded_from})" if expanded_from else ""),
                     tracked=self.tracked, origin=(self if self.file_parser else None, (w.start, w.end)),
                     file_parser=False)
        sub.eval_how = how
        sub.parse_all()
        self.cover(w.start, w.end)

    def add_az(self, azw, args, redirects):
        via = self.via_stack[-1]
        flags = set()
        for a in args:
            flags |= a.flags
        last_end = args[-1].end if args else azw.end
        mid = [r for r in redirects if r[2] < last_end and r[2] > azw.start]
        if mid and self.file_parser:
            flags.add("redirect_between_args")
        rec = {
            "file": self.rel,
            "line": azw.line if self.file_parser else self.line_base + 1,
            "line_end": self.line_of(last_end) if self.file_parser else self.line_base + 1,
            "pos": azw.start if self.file_parser else (self.origin[1][0] if self.origin else 0),
            "via": via if self.file_parser else via,
            "command": " ".join(a.rendered for a in args),
            "flags": sorted(flags),
            "redirects": [r[0] + (r[1] or "") for r in redirects],
        }
        if not self.file_parser:
            rec["eval_how"] = getattr(self, "eval_how", via)
        self.sink.commands.append(rec)
        if self.file_parser:
            self.az_positions.add(azw.start)


def main():
    files = sorted((ROOT / "samples").rglob("*.sh"))
    sink = Sink()
    recon = []
    parse_errors = []
    for f in files:
        rel = f.relative_to(ROOT).as_posix()
        text = f.read_text(encoding="utf-8")
        p = Parser(text, rel, sink)
        before = len(sink.commands)
        try:
            p.parse_all()
        except ParseError as e:
            parse_errors.append(f"{rel}: {e}")
            continue
        raw = [m.start() for m in RAW_AZ.finditer(text)]
        unaccounted = []
        for pos in raw:
            if pos in p.az_positions:
                continue
            if any(a <= pos < b for a, b in p.covered_spans):
                continue
            unaccounted.append(pos)
        recon.append({"file": rel, "raw_mentions": len(raw), "commands": len(sink.commands) - before,
                      "unaccounted": [f"{p.line_of(x)}: {text[x:x+80].splitlines()[0]}" for x in unaccounted]})
    commit = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    sink.commands.sort(key=lambda r: (r["file"], r["line"], r["pos"]))
    OUT.write_text(json.dumps({
        "source_commit": commit,
        "files": len(files),
        "parse_errors": parse_errors,
        "commands": sink.commands,
        "skipped": dict(sink.skipped),
        "skipped_examples": dict(sink.skipped_examples),
        "mentions": dict(sink.mentions),
        "mention_examples": dict(sink.mention_examples),
        "tracked_vars": sink.tracked_vars,
        "heredocs": sink.heredocs,
        "reconciliation": recon,
    }, indent=1), encoding="utf-8")
    print("files", len(files), "commands", len(sink.commands), "parse_errors", len(parse_errors))
    for e in parse_errors:
        print("  PARSE ERROR", e)
    print("via", collections.Counter(c["via"] for c in sink.commands))
    print("skipped", dict(sink.skipped))
    print("mentions", dict(sink.mentions))
    tot_un = sum(len(r["unaccounted"]) for r in recon)
    print("raw mentions", sum(r["raw_mentions"] for r in recon), "unaccounted", tot_un)
    for r in recon:
        for u in r["unaccounted"][:5]:
            print("  UNACCOUNTED", r["file"], u)


if __name__ == "__main__":
    main()
