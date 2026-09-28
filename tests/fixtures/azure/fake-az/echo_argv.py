# Argv fidelity through a real Python (plan task 2.4, U10 case 2): the arguments
# come back as ASCII-escaped JSON, so the pipe's code page cannot distort them.
import json
import sys

print(json.dumps(sys.argv[1:]))
