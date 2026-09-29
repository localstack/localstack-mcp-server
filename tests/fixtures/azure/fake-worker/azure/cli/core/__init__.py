"""A stand-in for azure.cli.core, for the warm-worker tests.

get_default_cli().invoke(argv, out_file) runs one fake command, chosen by argv[0], so the
tests can drive the real worker code (src/lib/azure/worker-script.ts) without azure-cli.
"""
import base64
import json
import logging
import os
import socket
import sys
import time
from urllib.parse import urlsplit

# Like knack: a handler bound at import time to the stderr stream of that moment. The worker
# must capture file descriptor 2, not sys.stderr, or this output would be lost.
_log = logging.getLogger("fake-az")
_log.addHandler(logging.StreamHandler(sys.stderr))
_log.setLevel(logging.INFO)

_count = 0


def _connect(target):
    """A CONNECT through HTTPS_PROXY (the egress guard), with the call tag as the user."""
    proxy = urlsplit(os.environ["HTTPS_PROXY"])
    host, port = target.rsplit(":", 1)
    auth = base64.b64encode(f"{proxy.username}:{proxy.password}".encode()).decode()
    with socket.create_connection((proxy.hostname, proxy.port), timeout=30) as s:
        s.sendall(
            f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n"
            f"Proxy-Authorization: Basic {auth}\r\n\r\n".encode()
        )
        answer = s.recv(200).decode(errors="replace").split("\r\n", 1)[0]
        sys.stderr.write(answer + "\n")
        # Keep going, like an SDK retrying: the fail-fast must end this.
        time.sleep(30)
    return 1


class _Cli:
    def __init__(self):
        # Like az's per-CLI event handlers: `az rest` unregisters the global result transforms
        # (the client-side resourceGroup and friends) on the CLI context it runs in.
        self.transforms = True

    def invoke(self, argv, out_file=None):
        global _count
        cmd, args = argv[0], argv[1:]
        if cmd == "unregister-transforms":
            self.transforms = False
            return 0
        if cmd == "transforms":
            print("on" if self.transforms else "off", file=out_file)
            return 0
        if cmd == "echo":
            print(json.dumps(args), file=out_file)
            return 0
        if cmd == "log":
            _log.warning(" ".join(args))
            return 0
        if cmd == "stderr":
            os.write(2, " ".join(args).encode())
            return 0
        if cmd == "rawfd":
            os.write(1, " ".join(args).encode())
            return 0
        if cmd == "exit":
            raise SystemExit(int(args[0]))
        if cmd == "raise":
            raise RuntimeError("boom")
        if cmd == "prompt":
            print("tty" if sys.stdin.isatty() else "no tty", file=out_file)
            print(repr(sys.stdin.read()), file=out_file)
            return 0
        if cmd == "count":
            _count += 1
            print(_count, file=out_file)
            return 0
        if cmd == "pid":
            print(os.getpid(), file=out_file)
            return 0
        if cmd == "cwd":
            print(os.getcwd(), file=out_file)
            return 0
        if cmd == "env":
            print(os.environ.get(args[0], "<unset>"), file=out_file)
            return 0
        if cmd == "big":
            print("x" * int(args[0]), file=out_file)
            return 0
        if cmd == "sleep":
            time.sleep(float(args[0]))
            return 0
        if cmd == "crash":
            os._exit(9)
        if cmd == "connect":
            return _connect(args[0])
        print(f"unknown fake command {cmd}", file=sys.stderr)
        return 2


def get_default_cli():
    return _Cli()
