#!/bin/bash
# `devcontainer features test` default scenario — runs INSIDE a container built from this
# Feature with **no options** (`"micro": {}`) on mcr.microsoft.com/devcontainers/base:ubuntu.
#
# It is the bare-`{}` case every Feature in this collection has to survive (see
# .plans/design/devc-feature-split.md): "latest" resolves for real, and `micro` is on PATH and
# runs as the remote user.
set -e

source dev-container-features-test-lib

check "micro is installed" test -x /usr/local/bin/micro
check "and is the micro on PATH" bash -c '[ "$(command -v micro)" = /usr/local/bin/micro ]'
check "EDITOR is left alone" bash -c '[ "${EDITOR:-}" != micro ]'

# The scenario runs as the remote user, which is the point: it is who runs the editor.
check "micro -version runs" bash -c 'micro -version | grep -q "^Version: "'

reportResults
