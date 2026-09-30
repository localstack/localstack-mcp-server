#!/usr/bin/env python3
"""Generate the file-argument table the Azure command policy uses.

Why this exists
---------------
The policy's file rule must know which `az` arguments take a local path, so it can keep those
paths inside the workdir. A hand-maintained list drifts and misses short aliases and output
flags. Instead we load az's own command table and record, per command, every argument
that az itself treats as a file:

  * its `type` is `azure.cli.core.commands.parameters.file_type` (it calls os.path.expanduser); or
  * its completer is argcomplete's FilesCompleter or DirectoriesCompleter.

For each such argument we keep every `options_list` string (long and short), whether it is
"greedy" (nargs '+' or '*', so it consumes several path values), and whether it is positional
(the `acr build`/`acr run` source; the policy treats that specially).

This does NOT capture path arguments that az fails to annotate (e.g. `storage blob
download-batch --destination`, `webapp deploy --src-path`); those live in a small reviewed
supplement inside policy.ts (EXTRA_FILE_ARGS), documented there.

It also does NOT need to capture the arguments az opens a file for only when the value happens
to name an existing path -- the AAZ structured arguments (`--tags`, `--settings`, ... : their
`_decode_value` does `os.path.exists(...)` then `get_file_json/yaml`) and the
`validate_file_or_dict` arguments. There are ~1,500 of them, and az gives them no file marker.
Rather than list them, policy.ts mirrors az's own gate at runtime: any argument value that
resolves to an existing file must pass the workdir/protected check (the "safety net").
So this table only needs the arguments that are ALWAYS a path (including write targets, which may
not exist yet and so must be checked unconditionally).

How to run (offline; never touches the real ~/.azure)
-----------------------------------------------------
    AZURE_CONFIG_DIR=<a fresh throwaway dir> \
        python scripts/gen-az-file-args.py > src/lib/azure/az-file-args.generated.json

The image pins azure-cli 2.90 plus 26 curated extensions (docker/azure-extensions.txt). Whoever
regenerates on a pin move should install those extensions first, so extension
commands (cdn/afd, k8s-*, fleet, ...) are covered too. On the machine that produced the checked-in
copy only the built-in modules were present; the JSON metadata records that.
"""
import datetime
import json
import os
import platform
import sys
import tempfile


def _fail(message: str) -> "None":
    sys.stderr.write(message + "\n")
    raise SystemExit(1)


def _ensure_safe_config_dir() -> str:
    """Never load az against the user's real profile: force a throwaway AZURE_CONFIG_DIR."""
    cfg = os.environ.get("AZURE_CONFIG_DIR", "")
    base = os.path.basename(cfg.rstrip("\\/")) if cfg else ""
    if not cfg or base == ".azure" or ".azure" in cfg.replace("\\", "/").split("/"):
        # Refuse to run without an explicit, non-.azure config dir.
        cfg = tempfile.mkdtemp(prefix="az-file-args-")
        os.environ["AZURE_CONFIG_DIR"] = cfg
        sys.stderr.write(f"AZURE_CONFIG_DIR was unsafe or unset; using throwaway {cfg}\n")
    os.environ.setdefault("AZURE_CORE_COLLECT_TELEMETRY", "no")
    # A closed loopback port, so any stray outbound call fails fast instead of reaching the network.
    os.environ.setdefault("HTTPS_PROXY", "http://127.0.0.1:9")
    os.environ.setdefault("HTTP_PROXY", "http://127.0.0.1:9")
    return os.environ["AZURE_CONFIG_DIR"]


def main() -> "None":
    _ensure_safe_config_dir()

    try:
        from azure.cli.core import get_default_cli
        from azure.cli.core.file_util import create_invoker_and_load_cmds_and_args
        from azure.cli.core.commands.parameters import file_type
        from argcomplete.completers import FilesCompleter, DirectoriesCompleter
    except Exception as exc:  # pragma: no cover - environment problem
        _fail(f"could not import azure-cli: {exc}")

    import azure.cli.core as core

    cli = get_default_cli()
    create_invoker_and_load_cmds_and_args(cli)
    parser = cli.invocation.parser

    commands: "dict[str, dict]" = {}
    file_arg_count = 0
    for name, subparser in parser.subparser_map.items():
        flags: "list[str]" = []
        greedy: "list[str]" = []
        positional_file = False
        for action in subparser._actions:
            is_file = action.type is file_type or isinstance(
                getattr(action, "completer", None), (FilesCompleter, DirectoriesCompleter)
            )
            if not is_file:
                continue
            file_arg_count += 1
            if not action.option_strings:
                # A positional path (acr build/run source). The policy handles those by name.
                positional_file = True
                continue
            multi = action.nargs in ("+", "*")
            for option in action.option_strings:
                if option not in flags:
                    flags.append(option)
                if multi and option not in greedy:
                    greedy.append(option)
        if flags or positional_file:
            entry: "dict[str, object]" = {"flags": sorted(flags)}
            if greedy:
                entry["greedy"] = sorted(greedy)
            if positional_file:
                entry["positional"] = True
            commands[name] = entry

    extensions = []
    try:
        from azure.cli.core.extension import get_extensions

        extensions = sorted(e.name for e in get_extensions())
    except Exception:  # pragma: no cover - best effort
        extensions = []

    document = {
        "_metadata": {
            "generator": "scripts/gen-az-file-args.py",
            "description": (
                "Per-command file-taking arguments, from az's command table: every argument whose "
                "type is file_type or whose completer completes files/directories, with all its "
                "option strings. Consumed by src/lib/azure/policy.ts. Regenerated on an az pin move."
            ),
            "az_version": core.__version__,
            "python_version": platform.python_version(),
            "platform": sys.platform,
            "generated_utc": datetime.datetime.now(datetime.timezone.utc)
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z"),
            "command_count": len(parser.subparser_map),
            "file_command_count": len(commands),
            "file_argument_count": file_arg_count,
            "extensions_installed": extensions,
            "note": (
                "The production image pins azure-cli 2.90 and 26 curated extensions "
                "(docker/azure-extensions.txt). This table was generated with azure-cli "
                f"{core.__version__} and the extensions listed in extensions_installed "
                "(empty here means only built-in command modules were present). DR4 regenerates "
                "it with the pinned az and the installed extensions. Path arguments az does not "
                "annotate (e.g. storage blob download-batch --destination, webapp deploy "
                "--src-path) are covered by EXTRA_FILE_ARGS in policy.ts, not by this file."
            ),
        },
        "commands": dict(sorted(commands.items())),
    }

    sys.stdout.write(json.dumps(document, indent=2, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stderr.write(
        f"az {core.__version__}: {len(parser.subparser_map)} commands, "
        f"{len(commands)} with file args, {file_arg_count} file arguments\n"
    )


if __name__ == "__main__":
    main()
