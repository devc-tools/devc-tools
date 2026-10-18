#!/bin/bash
# `devcontainer features test` default scenario — runs INSIDE a container built from this
# Feature with **no options** (`"helix": {}`) on mcr.microsoft.com/devcontainers/base:ubuntu.
#
# It is the bare-`{}` case every Feature in this collection has to survive (see
# .plans/design/devc-feature-split.md): "latest" resolves for real, `hx` is on PATH and runs as
# the remote user, and it finds its runtime (grammars and queries) without any config.
set -e

source dev-container-features-test-lib

PREFIX=/usr/local/lib/helix

check "hx is installed" test -x "$PREFIX/hx"
check "with its runtime beside it" test -d "$PREFIX/runtime/queries"
check "and prebuilt grammars" bash -c "ls $PREFIX/runtime/grammars/*.so > /dev/null"
check "hx is on PATH as a symlink to it" bash -c \
  "[ \"\$(readlink \"\$(command -v hx)\")\" = $PREFIX/hx ]"
check "HELIX_RUNTIME names the runtime" test "$HELIX_RUNTIME" = "$PREFIX/runtime"
check "EDITOR is left alone" bash -c '[ "${EDITOR:-}" != hx ]'

# The scenario runs as the remote user, which is the point: it is who runs the editor.
check "hx --version runs" bash -c 'hx --version | grep -q "^helix "'
check "hx --health runs" hx --health
check "and finds the runtime" bash -c \
  "hx --health 2>&1 | grep -q 'Runtime directories:.*$PREFIX/runtime'"
check "TypeScript highlighting is available" bash -c \
  "hx --health typescript 2>&1 | grep -q 'Highlight queries: .*✓'"

reportResults
