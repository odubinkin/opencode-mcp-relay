#!/bin/zsh
set -eu
relay_bundle="${0:A:h}"
exec "$relay_bundle/opencode" "$@"
