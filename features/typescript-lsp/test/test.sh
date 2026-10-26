#!/bin/bash
# `devcontainer features test` default scenario — runs INSIDE a container built from this
# Feature with **no options** (`"typescript-lsp": {}`) on mcr.microsoft.com/devcontainers/base:ubuntu,
# which has no Node of its own.
#
# The bare-`{}` case: the private Node and vtsls are installed, the launcher is on PATH,
# `describe` answers for a generated TypeScript project, and `serve --root` really starts vtsls
# and answers an `initialize` frame. with_settings covers the `settings` bake.
set -e

source dev-container-features-test-lib

SHARE=/usr/local/share/devc-features/typescript-lsp
NODE="$SHARE/node/bin/node"

check "the private Node runs" bash -c "'$NODE' --version | grep -qx v24.22.1"
check "the image's PATH has no node from this Feature" bash -c \
  "! command -v node > /dev/null || [ \"\$(command -v node)\" != '$NODE' ]"
check "vtsls is installed" test -f "$SHARE/vtsls/node_modules/@vtsls/language-server/bin/vtsls.js"
check "with its bundled TypeScript 5.9.3" bash -c \
  "grep -q '\"version\": \"5.9.3\"' '$SHARE/vtsls/node_modules/typescript/package.json'"
check "the launcher is on PATH" bash -c 'command -v devc-lsp-typescript'
check "server baked to auto" grep -qxF "const BAKED_SERVER = 'YXV0bw==';" /usr/local/bin/devc-lsp-typescript

PROJECT="$(mktemp -d)"
git -C "$PROJECT" init -q
echo '{"name":"probe","private":true}' > "$PROJECT/package.json"
mkdir -p "$PROJECT/src"
printf 'export const answer: number = 42;\n' > "$PROJECT/src/index.ts"

DESC="$(devc-lsp-typescript describe "$PROJECT/src/index.ts")"
echo "describe: $DESC"
field() { echo "$DESC" | "$NODE" -e 'let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => console.log(JSON.parse(s)[process.argv[1]]))' "$1"; }
check "describe returns protocol 1" test "$(field protocol)" = 1
check "rooted at the project" test "$(field root)" = "$PROJECT"
check "vtsls on its bundled TypeScript" test "$(field server)" = 'vtsls 0.3.0 (bundled TypeScript 5.9.3)'

# serve --root, fed one initialize frame on stdin; the first frame back must be its result.
cat > "$PROJECT/initialize.cjs" << 'JS'
const { spawn } = require('node:child_process');
const root = process.argv[2];
const child = spawn('devc-lsp-typescript', ['serve', '--root', root], { stdio: ['pipe', 'pipe', 'inherit'] });
const body = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { processId: null, rootUri: `file://${root}`, capabilities: {} },
});
child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
let buf = '';
const timer = setTimeout(() => { console.error('no initialize result within 30 s'); child.kill(); process.exit(1); }, 30000);
child.stdout.on('data', (c) => {
  buf += c;
  const h = buf.indexOf('\r\n\r\n');
  if (h < 0) return;
  const len = +/Content-Length: (\d+)/i.exec(buf.slice(0, h))[1];
  if (Buffer.byteLength(buf.slice(h + 4)) < len) return;
  const msg = JSON.parse(buf.slice(h + 4, h + 4 + len));
  clearTimeout(timer);
  console.log(msg.result?.serverInfo?.name ?? JSON.stringify(msg));
  child.kill('SIGTERM');
  process.exit(0);
});
JS
check "serve answers initialize as vtsls within 30 s" bash -c \
  "[ \"\$('$NODE' '$PROJECT/initialize.cjs' '$PROJECT')\" = vtsls ]"
check "and wrote nothing into the project" bash -c \
  "[ \"\$(cd '$PROJECT' && find . -path ./.git -prune -o -type f -print | sort | tr '\n' ' ')\" = './initialize.cjs ./package.json ./src/index.ts ' ]"

reportResults
