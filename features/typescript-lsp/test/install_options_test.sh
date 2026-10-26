#!/bin/bash
# install.sh end to end, offline — option validation before anything lands in BIN_DIR, the
# Node download's architecture mapping and checksum, vtsls installed by `npm ci` from the
# committed lockfile, and both options' bake into the launcher.
#
#   bash features/typescript-lsp/test/install_options_test.sh
#
# No Docker, no root, no network: `curl`, `apt-get`, `tar`, `sha256sum`, `npm` and `uname` are
# stubbed on PATH ahead of the real ones, and SHARE_DIR / BIN_DIR point into a temp directory.
# The curl stub copies a fixture "tarball"; the sha256sum stub vouches for it with install.sh's
# x64 pin only while its bytes are the fixture's; the tar stub lays out <dest>/bin/node (the real
# node on PATH) and <dest>/bin/npm (the npm stub, which records its arguments).
set -uo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="$FEATURE_DIR/install.sh"
MANIFEST="$FEATURE_DIR/devcontainer-feature.json"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}
check_out() { # check_out <desc> <expected-substring>
  local desc="$1" pat="$2"
  if grep -qF -- "$pat" "$WORK/out.log"; then
    echo "  ok   $desc"
  else
    echo "  FAIL $desc (no '$pat' in the output)"; sed 's/^/       | /' "$WORK/out.log"
    fails=$((fails + 1))
  fi
}

command -v node > /dev/null 2>&1 || { echo "install_options_test.sh: needs node on PATH" >&2; exit 2; }

# The x64 pin, spelled out here rather than read back out of install.sh: a harness that took its
# expectation from the script under test would agree with whatever the script said.
NODE_SHA256_X64='eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c'

STUB_BIN="$WORK/stub-bin"
mkdir -p "$STUB_BIN"
GOOD_TGZ="$WORK/node-good.tar.gz"
BAD_TGZ="$WORK/node-bad.tar.gz"
echo 'fixture node tarball' > "$GOOD_TGZ"
echo 'tampered node tarball' > "$BAD_TGZ"

cat > "$STUB_BIN/curl" << 'EOF'
#!/bin/sh
echo "curl $*" >> "$STUB_LOG"
out=''
while [ "$#" -gt 0 ]; do
  case "$1" in -o) out="$2"; shift ;; esac
  shift
done
cp "$NODE_FIXTURE" "$out"
EOF
cat > "$STUB_BIN/apt-get" << 'EOF'
#!/bin/sh
echo "apt-get $*" >> "$STUB_LOG"
EOF
cat > "$STUB_BIN/sha256sum" << EOF
#!/bin/sh
if cmp -s "\$1" "$GOOD_TGZ"; then echo "$NODE_SHA256_X64  \$1"; else echo "0000  \$1"; fi
EOF
cat > "$STUB_BIN/uname" << 'EOF'
#!/bin/sh
[ "$1" = -m ] && { echo "${FAKE_ARCH:-x86_64}"; exit 0; }
exec /bin/uname "$@"
EOF
cat > "$STUB_BIN/tar" << EOF
#!/bin/sh
echo "tar \$*" >> "\$STUB_LOG"
dest=''
while [ "\$#" -gt 0 ]; do
  case "\$1" in -C) dest="\$2"; shift ;; esac
  shift
done
mkdir -p "\$dest/bin" "\$dest/include"
printf '#!/bin/sh\nexec "%s" "\$@"\n' "$(command -v node)" > "\$dest/bin/node"
printf '#!/bin/sh\nNPM_VIA=private exec "%s/npm" "\$@"\n' "$STUB_BIN" > "\$dest/bin/npm"
chmod 755 "\$dest/bin/node" "\$dest/bin/npm"
EOF
cat > "$STUB_BIN/npm" << 'EOF'
#!/bin/sh
echo "npm(${NPM_VIA:-PATH}) $*" >> "$STUB_LOG"
EOF
chmod 755 "$STUB_BIN"/*

# run_install <name> [VAR=value ...] — sets $share, $bin, $log, $status.
run_install() {
  local name="$1"; shift
  share="$WORK/$name.share"; bin="$WORK/$name.bin"; log="$WORK/$name.log"
  : > "$log"
  env -u SERVER -u SETTINGS PATH="$STUB_BIN:$PATH" SHARE_DIR="$share" BIN_DIR="$bin" \
    STUB_LOG="$log" NODE_FIXTURE="$GOOD_TGZ" "$@" \
    sh "$INSTALL" > "$WORK/out.log" 2>&1
  status=$?
}
nothing_in_bin() { [ -z "$(ls -A "$bin" 2> /dev/null)" ]; }
baked_line() { grep "^const $1 = " "$bin/devc-lsp-typescript"; }
baked_value() { # baked_value <name> — the decoded value
  baked_line "$1" | sed "s/^const $1 = '\(.*\)';\$/\1/" | base64 -d
}

# A project for the installed launcher to describe: package.json and no node_modules.
FIXTURE="$WORK/project"
mkdir -p "$FIXTURE"
echo '{}' > "$FIXTURE/package.json"
: > "$FIXTURE/a.ts"
describe_installed() { # sets $out
  out="$(TYPESCRIPT_LSP_SHARE_DIR="$share" node "$bin/devc-lsp-typescript" describe "$FIXTURE/a.ts")"
}
field() { node -e 'const o = JSON.parse(process.argv[1]); console.log(JSON.stringify(eval(process.argv[2])))' "$out" "$1"; }

echo "case 1: a bare {}"
run_install c1
check "install.sh succeeds" test "$status" -eq 0
check "the x64 Node tarball is downloaded" \
  grep -qF 'https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.gz' "$log"
check "and unpacked into SHARE_DIR/node" grep -qF -- "-C $share/node --strip-components=1" "$log"
check "Node's C headers are dropped" test ! -e "$share/node/include"
check "vtsls/package.json is copied" cmp -s "$FEATURE_DIR/vtsls/package.json" "$share/vtsls/package.json"
check "and its lockfile" cmp -s "$FEATURE_DIR/vtsls/package-lock.json" "$share/vtsls/package-lock.json"
check "the launcher is installed" test -f "$bin/devc-lsp-typescript"
check "mode 0755" test "$(stat -c '%a' "$bin/devc-lsp-typescript")" = 755
check "server baked to auto" test "$(baked_value BAKED_SERVER)" = auto
check "settings baked to {}" test "$(baked_value BAKED_SETTINGS)" = '{}'
check "apt-get is not touched when curl is present" bash -c "! grep -q '^apt-get' '$log'"
check "SHARE_DIR is world-readable" test "$(stat -c '%a' "$share/vtsls/package.json")" = 644
describe_installed
check "the installed launcher describes" test "$(field o.protocol)" = 1

echo "case 2: settings that is not a JSON object fails before BIN_DIR"
run_install c2 SETTINGS='[1]'
check "install.sh fails" test "$status" -ne 0
check_out "naming the option" 'settings must be a JSON object'
check "nothing under BIN_DIR" nothing_in_bin
for bad in 'not json' '3' 'null' '"s"'; do
  run_install "c2.$RANDOM" "SETTINGS=$bad"
  check "$bad fails" test "$status" -ne 0
  check "nothing under BIN_DIR" nothing_in_bin
done

echo "case 3: quotes and backslashes survive the bake"
QUOTED='{"a":"it'"'"'s \"q\""}'
run_install c3 "SETTINGS=$QUOTED" SERVER=vtsls
check "install.sh succeeds" test "$status" -eq 0
check "BAKED_SERVER rewritten" test "$(baked_line BAKED_SERVER)" = "const BAKED_SERVER = 'dnRzbHM=';"
check "BAKED_SETTINGS rewritten" bash -c "! grep -qxF \"const BAKED_SETTINGS = '';\" '$bin/devc-lsp-typescript'"
check "and decodes to the value given" test "$(baked_value BAKED_SETTINGS)" = "$QUOTED"
check "the baked launcher still parses" node --check "$bin/devc-lsp-typescript"
describe_installed
check "describe reflects the baked settings" test "$(field o.settings.a)" = '"it'"'"'s \"q\""'
check "and the baked server" test "$(field o.server)" = '"vtsls 0.3.0 (bundled TypeScript 5.9.3)"'

echo "case 4: a 2,000-character settings value bakes onto one line"
LONG="{\"k\":\"$(printf 'x%.0s' $(seq 1 1992))\"}"
check "the value is 2,000 characters" test "${#LONG}" -eq 2000
run_install c4 "SETTINGS=$LONG"
check "install.sh succeeds" test "$status" -eq 0
check "one BAKED_SETTINGS line" test "$(grep -c '^const BAKED_SETTINGS' "$bin/devc-lsp-typescript")" -eq 1
check "the launcher has as many lines as its source" \
  test "$(wc -l < "$bin/devc-lsp-typescript")" -eq "$(wc -l < "$FEATURE_DIR/devc-lsp-typescript")"
check "and it decodes to the value" test "$(baked_value BAKED_SETTINGS)" = "$LONG"
describe_installed
check "describe carries it" test "$(field 'o.settings.k.length')" = 1992

echo "case 5: architectures"
run_install c5a FAKE_ARCH=riscv64
check "riscv64 fails" test "$status" -ne 0
check_out "unsupported architecture" 'unsupported architecture: riscv64'
check "nothing downloaded" bash -c "! grep -q '^curl' '$log'"
check "nothing under BIN_DIR" nothing_in_bin
run_install c5b FAKE_ARCH=aarch64
check "aarch64 downloads the arm64 tarball" \
  grep -qF 'node-v24.22.1-linux-arm64.tar.gz' "$log"
check "and is checked against the arm64 pin (the stub only vouches for x64)" \
  grep -qF 'node checksum mismatch' "$WORK/out.log"
run_install c5c FAKE_ARCH=arm64
check "arm64 downloads the arm64 tarball" grep -qF 'node-v24.22.1-linux-arm64.tar.gz' "$log"

echo "case 6: a Node tarball that does not match its pin"
run_install c6 NODE_FIXTURE="$BAD_TGZ"
check "install.sh fails" test "$status" -ne 0
check_out "node checksum mismatch" 'node checksum mismatch'
check "nothing unpacked" bash -c "! grep -q '^tar' '$log'"
check "npm never runs" bash -c "! grep -q '^npm' '$log'"
check "nothing under BIN_DIR" nothing_in_bin

echo "case 7: vtsls comes from npm ci, with the private Node's npm"
run_install c7
check "npm ran once" test "$(grep -c '^npm' "$log")" -eq 1
check "with ci" grep -qE '^npm\([a-z]+\) ci ' "$log"
check "and --omit=dev" grep -qF -- '--omit=dev' "$log"
check "into SHARE_DIR/vtsls" grep -qF -- "--prefix $share/vtsls" "$log"
check "never npm install" bash -c "! grep -qE '^npm\([a-z]+\) install' '$log'"
check "the private Node's npm, not the image's" grep -q '^npm(private) ' "$log"

echo "case 8: an unknown server fails before BIN_DIR"
run_install c8 SERVER=tsserver
check "install.sh fails" test "$status" -ne 0
check_out "naming the option" 'server must be one of auto, deno, workspace-typescript, vtsls'
check "nothing under BIN_DIR" nothing_in_bin

echo "case 9: the manifest and install.sh agree"
check "SHARE_DIR defaults to the Feature namespace" \
  grep -qF 'SHARE_DIR:-/usr/local/share/devc-features/typescript-lsp' "$INSTALL"
check "BIN_DIR defaults to /usr/local/bin" grep -qF 'BIN_DIR:-/usr/local/bin' "$INSTALL"
check "the launcher's shebang is the private Node" test "$(head -1 "$FEATURE_DIR/devc-lsp-typescript")" = \
  '#!/usr/local/share/devc-features/typescript-lsp/node/bin/node'
check "the launcher's source holds both unbaked lines" bash -c \
  "grep -qxF \"const BAKED_SERVER = '';\" '$FEATURE_DIR/devc-lsp-typescript' &&
   grep -qxF \"const BAKED_SETTINGS = '';\" '$FEATURE_DIR/devc-lsp-typescript'"
check "manifest server default auto" test "$(node -p "require('$MANIFEST').options.server.default")" = auto
check "manifest settings default {}" test "$(node -p "require('$MANIFEST').options.settings.default")" = '{}'
check "vtsls is pinned to 0.3.0" test \
  "$(node -p "require('$FEATURE_DIR/vtsls/package.json').dependencies['@vtsls/language-server']")" = 0.3.0
check "the lockfile agrees" test \
  "$(node -p "require('$FEATURE_DIR/vtsls/package-lock.json').packages['node_modules/@vtsls/language-server'].version")" = 0.3.0
check "and locks the bundled TypeScript at 5.9.3" test \
  "$(node -p "require('$FEATURE_DIR/vtsls/package-lock.json').packages['node_modules/typescript'].version")" = 5.9.3

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
