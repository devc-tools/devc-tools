#!/bin/bash
# install.sh end to end, offline — version resolution (latest and a pinned version, with or
# without its `v`), architecture mapping, the values that must fail the build, a missing asset,
# a checksum mismatch or a tarball without `micro` failing with nothing installed, and the
# installed binary.
#
#   bash features/micro/test/install_options_test.sh
#
# No Docker, no root, no real network: downloads go through the real curl against local
# file:// fixtures, as godot/test/install_options_test.sh does (a non-redirecting file:// URL's
# %{url_effective} is the URL itself, which stands in for "the releases/latest redirect
# resolved to this tag"). `uname` is stubbed on PATH ahead of the real one; `tar` and
# `sha256sum` stay real.
set -uo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="$FEATURE_DIR/install.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}
check_out() { # check_out <desc> <expected-substring>
  local desc="$1" pat="$2" file="$WORK/out.log"
  if grep -qF -- "$pat" "$file"; then
    echo "  ok   $desc"
  else
    echo "  FAIL $desc (no '$pat' in $file)"; sed 's/^/       | /' "$file"
    fails=$((fails + 1))
  fi
}

STUB_BIN="$WORK/stub-bin"
mkdir -p "$STUB_BIN"

stub_uname() { # stub_uname <machine>
  cat > "$STUB_BIN/uname" << EOF
#!/bin/sh
case "\${1:-}" in
  -m) echo "$1" ;;
  *) exec /usr/bin/uname "\$@" ;;
esac
EOF
  chmod 755 "$STUB_BIN/uname"
}
stub_uname x86_64

# --- the fixture release -----------------------------------------------------------------

# make_release <dir> <version> — a tarball and its `.sha` per architecture in the release's own
# layout, each `micro` echoing its version and arch, so asserting on the installed binary proves
# which asset was fetched.
make_release() {
  local dir="$1" ver="$2" arch stage asset
  mkdir -p "$dir/download/v$ver"
  for arch in linux64-static linux-arm64; do
    asset="micro-$ver-$arch.tar.gz"
    stage="$WORK/stage-$ver-$arch"
    rm -rf "$stage"; mkdir -p "$stage/micro-$ver"
    printf '#!/bin/sh\necho "micro %s %s"\n' "$ver" "$arch" > "$stage/micro-$ver/micro"
    chmod 755 "$stage/micro-$ver/micro"
    : > "$stage/micro-$ver/LICENSE"
    tar -czf "$dir/download/v$ver/$asset" -C "$stage" "micro-$ver"
    (cd "$dir/download/v$ver" && sha256sum "$asset" > "$asset.sha")
  done
}

RELEASE="$WORK/release"
VER='2.0.15'
make_release "$RELEASE" "$VER"
make_release "$RELEASE" '2.0.13'
mkdir -p "$RELEASE/releases/tag"
: > "$RELEASE/releases/tag/v$VER"
LATEST_URL="file://$RELEASE/releases/tag/v$VER"

# run_install <name> [VAR=value ...] — sets $bin, $status.
run_install() {
  local name="$1"; shift
  bin="$WORK/$name.bin/micro"
  env -u VERSION PATH="$STUB_BIN:$PATH" MICRO_BIN="$bin" \
    MICRO_RELEASES_LATEST_URL="$LATEST_URL" MICRO_RELEASE_BASE="file://$RELEASE" "$@" \
    sh "$INSTALL" > "$WORK/out.log" 2>&1
  status=$?
}

echo "case 1: a bare {} — version defaults to latest"
run_install c1
check "install.sh succeeds" test "$status" -eq 0
check "micro reports the resolved version and arch" test "$("$bin")" = "micro $VER linux64-static"
check "it is executable" test -x "$bin"
check "no staging file is left" bash -c "! ls '$bin'.tmp.* 2> /dev/null"
check_out "names what it installed" "micro: $VER (linux64-static) installed at $bin"

echo "case 2: a pinned version, with or without its v, installed over an existing install"
run_install c2 VERSION=2.0.13
check "a bare version installs" test "$status" -eq 0
check "the pinned version is installed" test "$("$bin")" = "micro 2.0.13 linux64-static"
run_install c2 VERSION=v2.0.15
check "a v-prefixed version installs over it" test "$status" -eq 0
check "and replaces it" test "$("$bin")" = "micro 2.0.15 linux64-static"

echo "case 3: aarch64 and arm64 both map to linux-arm64"
for m in aarch64 arm64; do
  stub_uname "$m"
  run_install "c3-$m"
  check "$m installs" test "$status" -eq 0
  check "$m gets the arm64 asset" test "$("$bin")" = "micro $VER linux-arm64"
done
stub_uname x86_64

echo "case 4: values that must fail the build"
stub_uname riscv64
run_install c4-arch
check "an unknown arch fails" test "$status" -ne 0
check_out "naming the arch" "unsupported architecture riscv64"
stub_uname x86_64
run_install c4-version VERSION='2.0.15;rm -rf /'
check "a version with shell characters fails" test "$status" -ne 0
check_out "naming the rule" "may not contain characters outside"
check "and installs nothing" test ! -e "$bin"
run_install c4-missing VERSION=9.9.9
check "a version with no release fails" test "$status" -ne 0
check_out "naming the URL" "download failed: file://$RELEASE/download/v9.9.9/micro-9.9.9-linux64-static.tar.gz"
check "and installs nothing" test ! -e "$bin"

echo "case 5: a checksum mismatch fails with nothing installed"
TAMPERED="$WORK/tampered"
cp -R "$RELEASE" "$TAMPERED"
echo "0000000000000000000000000000000000000000000000000000000000000000  micro-$VER-linux64-static.tar.gz" \
  > "$TAMPERED/download/v$VER/micro-$VER-linux64-static.tar.gz.sha"
run_install c5 MICRO_RELEASE_BASE="file://$TAMPERED"
check "install.sh fails" test "$status" -ne 0
check_out "naming the mismatch" "checksum mismatch for micro-$VER-linux64-static.tar.gz"
check "and installs nothing" test ! -e "$bin"

echo "case 6: a tarball without micro fails with nothing installed"
BROKEN="$WORK/broken"
mkdir -p "$BROKEN/download/v1.0" "$WORK/stage-broken/micro-1.0"
: > "$WORK/stage-broken/micro-1.0/LICENSE"
tar -czf "$BROKEN/download/v1.0/micro-1.0-linux64-static.tar.gz" -C "$WORK/stage-broken" micro-1.0
(cd "$BROKEN/download/v1.0" && sha256sum micro-1.0-linux64-static.tar.gz > micro-1.0-linux64-static.tar.gz.sha)
run_install c6 VERSION=1.0 MICRO_RELEASE_BASE="file://$BROKEN"
check "install.sh fails" test "$status" -ne 0
check_out "naming what is missing" "does not contain micro-1.0/micro"
check "and installs nothing" test ! -e "$bin"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
