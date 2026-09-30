# Argv fidelity through a real Python (runner.test.ts): the arguments
# come back as ASCII-escaped JSON, so the pipe's code page cannot distort them.
import json
import sys

print(json.dumps(sys.argv[1:]))
