/**
 * The Python side of the warm az worker. It imports azure-cli once and runs each command
 * in-process with `get_default_cli().invoke(argv)`.
 *
 * Protocol: one JSON line per command on stdin (`{id, argv, cwd, env}`), one JSON line per
 * answer on a private copy of the original stdout (`{id, exitCode, stdout, stderr,
 * truncated}`), after a first `{"ready": true}`. While a command runs, file descriptors 1
 * and 2 point at temp files: az's log handlers keep the stream they were built with, so
 * redirecting `sys.stderr` alone would miss its errors, and nothing az or a child (Bicep)
 * prints can reach the protocol stream. `sys.stdin` is an empty stream meanwhile, so a
 * prompt fails as it does in a subprocess whose stdin is at EOF.
 */
export const WORKER_CODE = String.raw`
import contextlib, io, json, os, sys, tempfile

_proto = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
LIMIT = int(os.environ.get("LOCALSTACK_AZ_WORKER_MAX_BYTES", "10485760"))


def _reply(obj):
    _proto.write(json.dumps(obj) + "\n")
    _proto.flush()


class _Capped(io.TextIOBase):
    """az's out_file: keeps at most LIMIT bytes of UTF-8, like the subprocess runner."""

    encoding = "utf-8"
    errors = "strict"

    def __init__(self):
        self.parts, self.size, self.capped = [], 0, False

    def writable(self):
        return True

    def write(self, s):
        if self.capped:
            return len(s)
        data = s.encode("utf-8", "surrogatepass")
        if self.size + len(data) > LIMIT:
            room = LIMIT - self.size
            self.parts.append(data[:room].decode("utf-8", "ignore"))
            self.size, self.capped = LIMIT, True
        else:
            self.parts.append(s)
            self.size += len(data)
        return len(s)

    def getvalue(self):
        return "".join(self.parts)


def _flush_std():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except Exception:
            pass


@contextlib.contextmanager
def _fd_to_file(fd):
    _flush_std()
    saved = os.dup(fd)
    tmp = tempfile.TemporaryFile(mode="w+b")
    os.dup2(tmp.fileno(), fd)
    try:
        yield tmp
    finally:
        _flush_std()
        os.dup2(saved, fd)
        os.close(saved)


def _read_capped(tmp):
    tmp.seek(0)
    data = tmp.read(LIMIT + 1)
    tmp.close()
    if len(data) > LIMIT:
        return data[:LIMIT].decode("utf-8", "ignore"), True
    return data.decode("utf-8", "replace"), False


def _reset_logging():
    import logging

    try:
        from knack.log import cli_logger_names
    except ImportError:  # the tests' stand-in azure.cli.core comes without knack
        cli_logger_names = []
    for logger in [logging.getLogger(), *(logging.getLogger(n) for n in cli_logger_names)]:
        for handler in list(logger.handlers):
            logger.removeHandler(handler)
            handler.close()


def main():
    from azure.cli.core import get_default_cli

    get_default_cli()  # warms the imports and the config before the first command
    _reply({"ready": True})
    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        for key, value in req.get("env", {}).items():
            os.environ[key] = value
        os.chdir(req["cwd"])
        # A fresh CLI context per command, as a subprocess gets: a command may change its own
        # context, e.g. az rest unregisters the global result transforms, which with one shared
        # context left every later command without resourceGroup. Imports stay warm.
        cli = get_default_cli()
        # knack configures logging only while the root logger has no handlers: drop the
        # previous command's, so each command gets its own level, as a subprocess does.
        _reset_logging()
        out = _Capped()
        rc = 1
        saved_stdin = sys.stdin
        with _fd_to_file(2) as err_file, _fd_to_file(1) as raw_file:
            sys.stdin = io.StringIO("")
            try:
                rc = cli.invoke(req["argv"], out_file=out)
            except SystemExit as e:
                rc = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
            except BaseException as e:
                sys.stderr.write("ERROR: the az worker caught %s: %s\n" % (type(e).__name__, e))
                rc = 1
            finally:
                sys.stdin = saved_stdin
        err, err_capped = _read_capped(err_file)
        raw, raw_capped = _read_capped(raw_file)
        _reply({
            "id": req["id"],
            "exitCode": int(rc or 0),
            "stdout": out.getvalue() + raw,
            "stderr": err,
            "truncated": out.capped or err_capped or raw_capped,
        })


main()
`;
