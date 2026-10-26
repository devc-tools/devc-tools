#!/bin/bash
# devc-lsp-typescript, offline — root detection, server choice, settings and option handling,
# against fixture projects built in a temp directory.
#
#   bash features/typescript-lsp/test/launcher_test.sh
#
# Needs `node` (>= 20.19 or 22.7, which run an extensionless ES module) and `git` on PATH; no
# Docker, no network, no real TypeScript. A fixture's `node_modules/typescript` is a bare
# package.json with a version in it, which is all `describe` reads. The launcher runs with a PATH
# of only `node` and `git` (plus a fake `deno` where a row wants one), so a real deno on this
# machine can't stand in for a missing one.
set -uo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCHER="$FEATURE_DIR/devc-lsp-typescript"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Fixture paths are compared against what git prints, which resolves symlinks (a macOS /tmp).
WORK="$(cd "$WORK" && pwd -P)"

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

for tool in node git; do
  command -v "$tool" > /dev/null 2>&1 || { echo "launcher_test.sh: needs $tool on PATH" >&2; exit 2; }
done
ARCH="$(node -p process.arch)"

# PATHs for the launcher: node and git only, and the same with a fake deno ahead of them.
BASE_BIN="$WORK/bin"
DENO_BIN="$WORK/deno-bin"
mkdir -p "$BASE_BIN" "$DENO_BIN"
ln -s "$(command -v node)" "$BASE_BIN/node"
ln -s "$(command -v git)" "$BASE_BIN/git"
printf '#!/bin/sh\necho "deno 2.9.8 (stable, release, x86_64-unknown-linux-gnu)"\necho "v8 14.0"\n' \
  > "$DENO_BIN/deno"
chmod 755 "$DENO_BIN/deno"
NO_DENO="$BASE_BIN"
WITH_DENO="$DENO_BIN:$BASE_BIN"

b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

# run <PATH> <launcher> <args...> — sets $out, $err, $status.
run() {
  local path="$1" launcher="$2"; shift 2
  out="$(env PATH="$path" node "$launcher" "$@" 2> "$WORK/err")"
  status=$?
  err="$(cat "$WORK/err")"
}
describe() { # describe <PATH> <args...> — the unbaked launcher
  local path="$1"; shift
  run "$path" "$LAUNCHER" describe "$@"
}
# field <js expression over o> — evaluated against the last $out.
field() {
  node -e 'const o = JSON.parse(process.argv[1]); const v = eval(process.argv[2]);
    process.stdout.write(typeof v === "string" ? v : JSON.stringify(v) ?? "undefined")' \
    "$out" "$1" 2> /dev/null
}
is() { # is <js expression> <expected>
  local got
  got="$(field "$1")"
  [ "$got" = "$2" ] && return 0
  echo "       | $1 = $got (expected $2)"
  [ -n "$err" ] && echo "       | stderr: $err"
  return 1
}
exits() { # exits <code>
  [ "$status" -eq "$1" ] && return 0
  echo "       | exit $status (expected $1); stdout: $out; stderr: $err"
  return 1
}
err_has() { # err_has <substring>
  case "$err" in *"$1"*) return 0 ;; esac
  echo "       | stderr: $err"
  return 1
}
one_line() { [ "$(printf '%s\n' "$err" | grep -c .)" -eq 1 ] || { echo "       | stderr: $err"; return 1; }; }

repo() { # repo <dir> — a fresh git repo
  mkdir -p "$1"
  git -C "$1" init -q
}
typescript() { # typescript <project dir> <version> [native] — a stand-in node_modules/typescript
  mkdir -p "$1/node_modules/typescript"
  printf '{"name":"typescript","version":"%s"}\n' "$2" > "$1/node_modules/typescript/package.json"
  if [ "${3:-}" = native ]; then
    mkdir -p "$1/node_modules/@typescript/typescript-linux-$ARCH"
    printf '{"name":"@typescript/typescript-linux-%s","version":"%s"}\n' "$ARCH" "$2" \
      > "$1/node_modules/@typescript/typescript-linux-$ARCH/package.json"
  fi
}
touch_file() { mkdir -p "$(dirname "$1")"; : > "$1"; }

# --- fixtures ---------------------------------------------------------------------------------

MONO="$WORK/mono"
repo "$MONO"
echo '{}' > "$MONO/package.json"
mkdir -p "$MONO/packages/a"
echo '{}' > "$MONO/packages/a/tsconfig.json"
typescript "$MONO" 5.6.3
touch_file "$MONO/packages/a/src/x.tsx"

TS7="$WORK/ts7"
repo "$TS7"
echo '{}' > "$TS7/package.json"
typescript "$TS7" 7.0.2 native
touch_file "$TS7/src/x.ts"

TS7X="$WORK/ts7-no-native"
repo "$TS7X"
echo '{}' > "$TS7X/package.json"
typescript "$TS7X" 7.0.2
touch_file "$TS7X/src/x.ts"

BARE="$WORK/bare"
repo "$BARE"
echo '{}' > "$BARE/package.json"
touch_file "$BARE/a.js"

DENO="$WORK/deno"
repo "$DENO"
echo '{}' > "$DENO/deno.json"
mkdir -p "$DENO/pkg"
echo '{}' > "$DENO/pkg/deno.json"
touch_file "$DENO/pkg/x.ts"

BUN="$WORK/deno-with-bun"
repo "$BUN"
echo '{}' > "$BUN/deno.json"
mkdir -p "$BUN/tools/bun-app"
echo '{}' > "$BUN/tools/bun-app/package.json"
: > "$BUN/tools/bun-app/bun.lock"
typescript "$BUN/tools/bun-app" 7.0.2 native
touch_file "$BUN/tools/bun-app/index.ts"

NODE_DENO="$WORK/node-with-deno"
repo "$NODE_DENO"
echo '{}' > "$NODE_DENO/package.json"
mkdir -p "$NODE_DENO/deno-pkg"
echo '{}' > "$NODE_DENO/deno-pkg/deno.json"
touch_file "$NODE_DENO/deno-pkg/mod.ts"

BOTH="$WORK/both"
repo "$BOTH"
echo '{}' > "$BOTH/deno.json"
echo '{}' > "$BOTH/package.json"
touch_file "$BOTH/x.ts"

NOREPO="$WORK/norepo/project"
mkdir -p "$NOREPO/src"
echo '{}' > "$NOREPO/tsconfig.json"
touch_file "$NOREPO/src/x.ts"

# A copy of the launcher with BAKED_SERVER / BAKED_SETTINGS rewritten the way install.sh does.
baked() { # baked <name> <server> <settings> — prints the copy's path
  local copy="$WORK/$1"
  sed -e "s|^const BAKED_SERVER = '';\$|const BAKED_SERVER = '$(b64 "$2")';|" \
    -e "s|^const BAKED_SETTINGS = '';\$|const BAKED_SETTINGS = '$(b64 "$3")';|" \
    "$LAUNCHER" > "$copy"
  echo "$copy"
}

# --- rows ------------------------------------------------------------------------------------

echo "a monorepo with per-package tsconfig and TypeScript 5.6.3"
describe "$NO_DENO" "$MONO/packages/a/src/x.tsx"
check "exits 0" exits 0
check "protocol 1" is o.protocol 1
check "root is the repo (the topmost Node marker)" is o.root "$MONO"
check "typescriptreact" is o.languageId typescriptreact
check "vtsls on the workspace TypeScript" is o.server 'vtsls 0.3.0 (TypeScript 5.6.3)'
check "tsdk is the workspace TypeScript's lib" is o.settings.typescript.tsdk \
  "$MONO/node_modules/typescript/lib"
check "autoUseWorkspaceTsdk" is o.settings.vtsls.autoUseWorkspaceTsdk true
check "initializationOptions {}" is o.initializationOptions '{}'
check "stdout is one line" test "$(printf '%s\n' "$out" | wc -l)" -eq 1

echo "a workspace TypeScript 7.0.2 with its linux-$ARCH binary"
describe "$NO_DENO" "$TS7/src/x.ts"
check "exits 0" exits 0
check "TS 7 from the workspace" is o.server 'TypeScript 7.0.2 (workspace)'
check "no tsdk" is 'o.settings.typescript' undefined
check "settings {}" is o.settings '{}'

echo "package.json and no node_modules"
describe "$NO_DENO" "$BARE/a.js"
check "exits 0" exits 0
check "javascript" is o.languageId javascript
check "vtsls on its bundled TypeScript" is o.server 'vtsls 0.3.0 (bundled TypeScript 5.9.3)'
check "no tsdk" is o.settings '{}'

echo "deno.json at the top and in pkg/, deno on PATH"
describe "$WITH_DENO" "$DENO/pkg/x.ts"
check "exits 0" exits 0
check "root is the repo (topmost Deno marker)" is o.root "$DENO"
check "deno with its version" is o.server 'deno 2.9.8'
check "initializationOptions.enable" is o.initializationOptions.enable true
check "initializationOptions.lint" is o.initializationOptions.lint true
check "settings.deno.enable" is o.settings.deno.enable true

echo "the same, without deno on PATH"
describe "$NO_DENO" "$DENO/pkg/x.ts"
check "exits 3" exits 3
check "says deno is missing" err_has 'deno.json found but deno is not on PATH'

echo "a .py file"
describe "$WITH_DENO" "$MONO/packages/a/src/x.py"
check "exits 3" exits 3
check "not a TypeScript or JavaScript file" err_has 'not a TypeScript or JavaScript file'

echo "every extension's languageId"
for pair in ts=typescript mts=typescript cts=typescript tsx=typescriptreact js=javascript \
  mjs=javascript cjs=javascript jsx=javascriptreact TS=typescript; do
  describe "$NO_DENO" "$MONO/packages/a/src/y.${pair%%=*}"
  check ".${pair%%=*} is ${pair#*=}" is o.languageId "${pair#*=}"
done

echo "baked settings merge next to the computed tsdk"
COPY="$(baked baked-memory '' '{"typescript":{"tsserver":{"maxTsServerMemory":1}}}')"
run "$NO_DENO" "$COPY" describe "$MONO/packages/a/src/x.tsx"
check "exits 0" exits 0
check "maxTsServerMemory merged in" is o.settings.typescript.tsserver.maxTsServerMemory 1
check "tsdk kept beside it" is o.settings.typescript.tsdk "$MONO/node_modules/typescript/lib"

echo "a Bun app inside a Deno repo"
describe "$WITH_DENO" "$BUN/tools/bun-app/index.ts"
check "exits 0" exits 0
check "root is the Bun app (nearest is Node, stops before the Deno top)" is o.root \
  "$BUN/tools/bun-app"
check "TS 7 from the workspace, marked Bun" is o.server 'TypeScript 7.0.2 (workspace, Bun)'

echo "a Deno package inside a Node repo"
describe "$WITH_DENO" "$NODE_DENO/deno-pkg/mod.ts"
check "exits 0" exits 0
check "root is the Deno package" is o.root "$NODE_DENO/deno-pkg"
check "deno" is o.server 'deno 2.9.8'

echo "deno.json beside package.json"
describe "$WITH_DENO" "$BOTH/x.ts"
check "Deno wins" is o.server 'deno 2.9.8'
check "root is that directory" is o.root "$BOTH"

echo "--root below the detected root"
describe "$NO_DENO" "$MONO/packages/a/src/x.tsx" --root "$MONO/packages/a"
check "exits 0" exits 0
check "root is the one given" is o.root "$MONO/packages/a"
check "TypeScript still found walking up" is o.server 'vtsls 0.3.0 (TypeScript 5.6.3)'
describe "$NO_DENO" "$MONO/packages/a/src/x.tsx" --root "$MONO/packages/a/"
check "a trailing slash is dropped" is o.root "$MONO/packages/a"

echo "--root elsewhere"
describe "$NO_DENO" "$MONO/packages/a/src/x.tsx" --root /elsewhere
check "exits 3" exits 3
check "root does not contain the file" err_has 'root does not contain the file'
describe "$NO_DENO" "$MONO/packages/a/src/x.tsx" --root "$MONO/packages/a/sr"
check "a sibling sharing a prefix is not an ancestor" exits 3

echo "--options server vtsls on the TS 7 fixture"
describe "$NO_DENO" "$TS7/src/x.ts" --options "$(b64 '{"server":"vtsls"}')"
check "exits 0" exits 0
check "vtsls on its bundled TypeScript (TS 7 has no tsserver)" is o.server \
  'vtsls 0.3.0 (bundled TypeScript 5.9.3)'
check "no tsdk" is o.settings '{}'

echo "--options server deno without deno on PATH"
describe "$NO_DENO" "$TS7/src/x.ts" --options "$(b64 '{"server":"deno"}')"
check "exits 3" exits 3

echo "--options server deno with deno, on a Node project"
describe "$WITH_DENO" "$TS7/src/x.ts" --options "$(b64 '{"server":"deno"}')"
check "deno" is o.server 'deno 2.9.8'

echo "--options server workspace-typescript with only TypeScript 5"
describe "$NO_DENO" "$MONO/packages/a/src/x.tsx" --options "$(b64 '{"server":"workspace-typescript"}')"
check "exits 3" exits 3

echo "TS 7 without its linux-$ARCH binary"
describe "$NO_DENO" "$TS7X/src/x.ts"
check "exits 0" exits 0
check "falls back to vtsls on its bundled TypeScript" is o.server \
  "vtsls 0.3.0 (bundled TypeScript 5.9.3; no linux-$ARCH TypeScript 7 binary)"
check "one stderr line" one_line
check "naming the missing package" err_has "@typescript/typescript-linux-$ARCH"

echo "the same, with server workspace-typescript"
describe "$NO_DENO" "$TS7X/src/x.ts" --options "$(b64 '{"server":"workspace-typescript"}')"
check "exits 3" exits 3
check "names the missing package" err_has \
  "@typescript/typescript-linux-$ARCH is not installed; run npm install in the container"

echo "a per-project settings object replaces the baked one"
COPY="$(baked baked-a '' '{"a":{"b":1}}')"
run "$NO_DENO" "$COPY" describe "$BARE/a.js" --options "$(b64 '{"settings":{"a":{"c":2}}}')"
check "exits 0" exits 0
check "a.c from the project" is o.settings.a.c 2
check "no a.b from the Feature" is o.settings.a.b undefined
run "$NO_DENO" "$COPY" describe "$BARE/a.js"
check "without --options the baked one applies" is o.settings.a.b 1

echo "a baked server applies, and the project's replaces it"
COPY="$(baked baked-server vtsls '{}')"
run "$NO_DENO" "$COPY" describe "$TS7/src/x.ts"
check "baked vtsls" is o.server 'vtsls 0.3.0 (bundled TypeScript 5.9.3)'
run "$NO_DENO" "$COPY" describe "$TS7/src/x.ts" --options "$(b64 '{"server":"auto"}')"
check "project auto wins" is o.server 'TypeScript 7.0.2 (workspace)'

echo "invalid --options"
for bad in '!!!' "$(b64 '[1]')" "$(b64 '{"server":"x"}')" "$(b64 '{"settings":3}')"; do
  describe "$NO_DENO" "$BARE/a.js" --options "$bad"
  check "$bad exits 1" exits 1
  check "with a one-line reason" one_line
done

echo "an unknown option is ignored, with one stderr line"
describe "$NO_DENO" "$BARE/a.js" --options "$(b64 '{"python":"/usr/bin/python3"}')"
check "exits 0" exits 0
check "says so" err_has 'ignoring unknown option python'

echo "the options subcommand"
run "$NO_DENO" "$LAUNCHER" options
check "exits 0" exits 0
check "protocol 1" is o.protocol 1
check "keys server and settings" is 'o.options.map((x) => x.key).join()' 'server,settings'
check "server is an enum" is o.options[0].type enum
check "of the four servers" is 'o.options[0].enum.join()' 'auto,deno,workspace-typescript,vtsls'
check "defaulting to auto" is o.options[0].default auto
check "settings is json" is o.options[1].type json
check "defaulting to {}" is o.options[1].default '{}'
COPY="$(baked baked-options vtsls '{"a":1}')"
run "$NO_DENO" "$COPY" options
check "defaults are the baked values" is 'o.options[0].default + JSON.stringify(o.options[1].default)' \
  'vtsls{"a":1}'

echo "not a git repo, with tsconfig.json"
describe "$NO_DENO" "$NOREPO/src/x.ts"
check "exits 0" exits 0
check "root is that directory" is o.root "$NOREPO"

echo "not a git repo, no marker"
touch_file "$WORK/loose/dir/x.js"
describe "$NO_DENO" "$WORK/loose/dir/x.js"
check "root is the file's directory" is o.root "$WORK/loose/dir"

echo "a git repo with no marker"
repo "$WORK/plain"
touch_file "$WORK/plain/a/b.js"
describe "$NO_DENO" "$WORK/plain/a/b.js"
check "root is the repo top" is o.root "$WORK/plain"

echo "serve"
run "$NO_DENO" "$LAUNCHER" serve
check "without --root exits 1" exits 1
# A fake deno that echoes its arguments and cwd, standing in for the server: serve must run it
# for a Deno root, with nothing of its own on stdout, and exit with its code.
SERVE_BIN="$WORK/serve-bin"
mkdir -p "$SERVE_BIN"
cat > "$SERVE_BIN/deno" << 'EOF'
#!/bin/sh
[ "$1" = --version ] && { echo "deno 2.9.8 (fake)"; exit 0; }
echo "args=$* cwd=$(pwd)"
exit 7
EOF
chmod 755 "$SERVE_BIN/deno"
run "$SERVE_BIN:$BASE_BIN" "$LAUNCHER" serve --root "$DENO"
check "runs deno lsp in the root, its stdout the server's alone" \
  test "$out" = "args=lsp cwd=$DENO"
check "exits with the server's code" exits 7

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
