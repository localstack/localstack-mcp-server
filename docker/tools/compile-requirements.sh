#!/bin/sh
# Regenerates the hashed requirements.txt lockfiles for the Python CLIs in the image.
# Dependabot (pip-compile, Python 3.11 from the header) normally does this; run it by hand
# after editing a requirements.in. Python 3.11 on Debian bookworm matches the image's python3.
set -eu
cd "$(dirname "$0")"
for tool in sam snowflake; do
  docker run --rm -v "$PWD/$tool:/w" -w /w python:3.11-slim-bookworm sh -c '
    pip install --quiet --root-user-action=ignore pip-tools==7.7.0 &&
    pip-compile --quiet --generate-hashes --allow-unsafe --strip-extras \
      --output-file=requirements.txt requirements.in'
done
