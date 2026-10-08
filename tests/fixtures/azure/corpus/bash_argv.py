"""The independent argv oracle. Feed each extracted command to GNU bash's `printf '%s\\0'` BUILTIN.

Safety: only commands that pass a static guard are sent (no backtick, no unescaped `$` outside
single quotes, no unquoted ; & | < > ( ) or newline), so bash cannot expand or run anything; bash
also runs under `env -i` with PATH pointing at an empty directory, --noprofile --norc, in an empty
working directory, so even a guard bug could not reach an external program (az included).

Input: extracted.json, output: bash.json, both in CORPUS_WORK_DIR (default: next to this file).
Runs with Git Bash on Windows and with the system bash elsewhere (DR8's weekly job is Linux).
"""
import json
import os
import pathlib
import shutil
import subprocess

HERE = pathlib.Path(__file__).parent
WORK = pathlib.Path(os.environ.get("CORPUS_WORK_DIR", str(HERE)))
WORK.mkdir(parents=True, exist_ok=True)
EMPTY = WORK / "empty_cwd"
EMPTY.mkdir(exist_ok=True)
EMPTY_BIN = WORK / "empty_bin"
EMPTY_BIN.mkdir(exist_ok=True)

if os.name == "nt":
    GIT_USR_BIN = r"C:\Program Files\Git\usr\bin"
    ENV = os.path.join(GIT_USR_BIN, "env.exe")
    BASH = os.path.join(GIT_USR_BIN, "bash.exe")
    CYGPATH = os.path.join(GIT_USR_BIN, "cygpath.exe")

    def to_bash_path(p):
        return subprocess.run([CYGPATH, "-u", str(p)], capture_output=True, text=True).stdout.strip()

else:
    ENV = shutil.which("env") or "/usr/bin/env"
    BASH = shutil.which("bash") or "/bin/bash"

    def to_bash_path(p):
        return str(p)


def guard(cmd):
    """Return None if safe for bash printf, else the reason."""
    i, n = 0, len(cmd)
    q = None
    while i < n:
        c = cmd[i]
        if q == "'":
            if c == "'":
                q = None
            i += 1
            continue
        if c == "\\":
            i += 2
            continue
        if c == "`":
            return "backtick"
        if c == "$":
            return "dollar outside single quotes"
        if q == '"':
            if c == '"':
                q = None
            i += 1
            continue
        if c in "'\"":
            q = c
            i += 1
            continue
        if c in ";&|<>()\n":
            return f"unquoted {c!r}"
        i += 1
    if q:
        return "unterminated quote"
    return None


def main():
    data = json.loads((WORK / "extracted.json").read_text(encoding="utf-8"))
    cmds = data["commands"]
    lines = ["set +o histexpand 2>/dev/null"]
    sent = []
    refused = {}
    for idx, c in enumerate(cmds):
        why = guard(c["command"])
        if why:
            refused[idx] = why
            continue
        sent.append(idx)
        lines.append(f"printf '%s\\0' {c['command']}")
        lines.append("printf '\\036'")
    script = WORK / "oracle.sh"
    script.write_bytes(("\n".join(lines) + "\n").encode("utf-8"))
    proc = subprocess.run(
        [ENV, "-i", f"PATH={to_bash_path(EMPTY_BIN)}", BASH, "--noprofile", "--norc", to_bash_path(script)],
        cwd=EMPTY,
        capture_output=True,
        timeout=120,
    )
    records = proc.stdout.split(b"\x1e")
    if records and records[-1] == b"":
        records = records[:-1]
    out = {}
    if len(records) != len(sent):
        raise SystemExit(f"record count mismatch: {len(records)} vs {len(sent)}; stderr={proc.stderr[:500]!r}")
    for idx, rec in zip(sent, records):
        parts = rec.split(b"\x00")
        if parts and parts[-1] == b"":
            parts = parts[:-1]
        out[idx] = [p.decode("utf-8") for p in parts]
    (WORK / "bash.json").write_text(
        json.dumps(
            {
                "bash": subprocess.run([BASH, "--version"], capture_output=True, text=True).stdout.splitlines()[0],
                "exit_code": proc.returncode,
                "stderr": proc.stderr.decode("utf-8", "replace")[:2000],
                "argv": out,
                "refused": refused,
            }
        ),
        encoding="utf-8",
    )
    print(f"sent {len(sent)}, refused by guard {len(refused)}, bash exit {proc.returncode}, stderr {proc.stderr[:300]!r}")
    print("empty_cwd still empty:", not any(EMPTY.iterdir()))


if __name__ == "__main__":
    main()
