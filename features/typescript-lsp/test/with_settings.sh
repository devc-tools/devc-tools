#!/bin/bash
# Scenario `with_settings` — the `settings` option, baked at build time, shows up in what
# `describe` gives devc web.
set -e

source dev-container-features-test-lib

NODE=/usr/local/share/devc-features/typescript-lsp/node/bin/node

PROJECT="$(mktemp -d)"
echo '{}' > "$PROJECT/package.json"
: > "$PROJECT/index.ts"

DESC="$(devc-lsp-typescript describe "$PROJECT/index.ts")"
echo "describe: $DESC"
check "maxTsServerMemory reaches describe's settings" bash -c "echo '$DESC' | '$NODE' -e '
  let s = \"\"; process.stdin.on(\"data\", (c) => (s += c)).on(\"end\", () =>
    process.exit(JSON.parse(s).settings.typescript.tsserver.maxTsServerMemory === 8192 ? 0 : 1))'"
check "and the options subcommand reports it as the default" bash -c \
  "devc-lsp-typescript options | grep -qF '\"maxTsServerMemory\":8192'"

reportResults
