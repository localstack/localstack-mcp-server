# Argv fidelity through a real Python (runner case 2): the arguments
# come back as ASCII-escaped JSON, so the pipe's code page cannot distort them.
import json
import sys

print(json.dumps(sys.argv[1:]))
