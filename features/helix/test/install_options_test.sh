#!/bin/bash
# install.sh end to end, offline — version resolution (latest and a pinned tag), architecture
# mapping, the values that must fail the build, a missing or malformed asset failing with
# nothing installed, the xz self-heal, and the installed layout.
#
#   bash features/helix/test/install_options_test.sh
#
# No Docker, no root, no real network: downloads go through the real curl against local
# file:// fixtures, as godot/test/install_options_test.sh does (a non-redirecting file:// URL's
# %{url_effective} is the URL itself, which stands in for "the releases/latest redirect
# resolved to this tag"). `uname` and `apt-get` are stubbed on PATH ahead of the real ones;
# `tar` and `xz` stay real.
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

cat > "$STUB_BIN/apt-get" << 'EOF'
#!/bin/sh
echo "apt-get $*" >> "$APT_LOG"
exit 0
EOF
chmod 755 "$STUB_BIN/apt-get"

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

# make_release <dir> <tag> — a tarball per architecture in the release's own layout, each `hx`
# echoing its tag and arch, so asserting on the installed binary proves which asset was fetched.
make_release() {
  local dir="$1" tag="$2" arch stage name
  mkdir -p "$dir/download/$tag"
  for arch in x86_64-linux aarch64-linux; do
    name="helix-$tag-$arch"
    stage="$WORK/stage-$tag-$arch"
    rm -rf "$stage"; mkdir -p "$stage/$name/runtime/queries/typescript" "$stage/$name/contrib"
    printf '#!/bin/sh\necho "helix %s %s"\n' "$tag" "$arch" > "$stage/$name/hx"
    chmod 755 "$stage/$name/hx"
    : > "$stage/$name/runtime/queries/typescript/highlights.scm"
    : > "$stage/$name/LICENSE"
    tar -cJf "$dir/download/$tag/$name.tar.xz" -C "$stage" "$name"
  done
}

RELEASE="$WORK/release"
TAG='25.07.1'
make_release "$RELEASE" "$TAG"
make_release "$RELEASE" '24.03'
mkdir -p "$RELEASE/releases/tag"
: > "$RELEASE/releases/tag/$TAG"
LATEST_URL="file://$RELEASE/releases/tag/$TAG"

# run_install <name> [VAR=value ...] — sets $prefix, $link, $aptlog, $status.
run_install() {
  local name="$1"; shift
  prefix="$WORK/$name.lib/helix"; link="$WORK/$name.bin/hx"; aptlog="$WORK/$name.apt.log"
  : > "$aptlog"
  env -u VERSION PATH="$STUB_BIN:$PATH" HELIX_PREFIX="$prefix" HELIX_LINK="$link" \
    APT_LOG="$aptlog" HELIX_RELEASES_LATEST_URL="$LATEST_URL" \
    HELIX_RELEASE_BASE="file://$RELEASE" "$@" \
    sh "$INSTALL" > "$WORK/out.log" 2>&1
  status=$?
}

echo "case 1: a bare {} — version defaults to latest, everything lands"
run_install c1
check "install.sh succeeds" test "$status" -eq 0
check "hx reports the resolved tag and arch" test "$("$prefix/hx")" = "helix $TAG x86_64-linux"
check "the runtime is beside it" test -f "$prefix/runtime/queries/typescript/highlights.scm"
check "and nothing else of the tarball" test ! -e "$prefix/contrib" -a ! -e "$prefix/LICENSE"
check "the symlink points at it" test "$(readlink "$link")" = "$prefix/hx"
check "no staging directory is left" bash -c "! ls -d '$prefix'.tmp.* 2> /dev/null"
check "xz present: apt-get not run" test ! -s "$aptlog"
check_out "names what it installed" "helix: $TAG (x86_64-linux) installed at $link"

echo "case 2: a pinned tag, installed over an existing install"
run_install c2 VERSION=24.03
run_install c2 VERSION=24.03
check "install.sh succeeds twice" test "$status" -eq 0
check "the pinned tag is installed" test "$("$link")" = "helix 24.03 x86_64-linux"

echo "case 3: aarch64 and arm64 both map to aarch64-linux"
for m in aarch64 arm64; do
  stub_uname "$m"
  run_install "c3-$m"
  check "$m installs" test "$status" -eq 0
  check "$m gets the aarch64 asset" test "$("$link")" = "helix $TAG aarch64-linux"
done
stub_uname x86_64

echo "case 4: values that must fail the build"
stub_uname riscv64
run_install c4-arch
check "an unknown arch fails" test "$status" -ne 0
check_out "naming the arch" "unsupported architecture riscv64"
stub_uname x86_64
run_install c4-version VERSION='25.07.1;rm -rf /'
check "a version with shell characters fails" test "$status" -ne 0
check_out "naming the rule" "may not contain characters outside"
check "and installs nothing" test ! -e "$link"
run_install c4-missing VERSION=99.99
check "a tag with no release fails" test "$status" -ne 0
check_out "naming the URL" "download failed: file://$RELEASE/download/99.99/helix-99.99-x86_64-linux.tar.xz"
check "and installs nothing" test ! -e "$prefix" -a ! -e "$link"

echo "case 5: a tarball without hx fails with nothing installed"
BROKEN="$WORK/broken"
mkdir -p "$BROKEN/download/1.0" "$WORK/stage-broken/helix-1.0-x86_64-linux/runtime"
tar -cJf "$BROKEN/download/1.0/helix-1.0-x86_64-linux.tar.xz" -C "$WORK/stage-broken" \
  helix-1.0-x86_64-linux
run_install c5 VERSION=1.0 HELIX_RELEASE_BASE="file://$BROKEN"
check "install.sh fails" test "$status" -ne 0
check_out "naming what is missing" "does not contain helix-1.0-x86_64-linux/hx"
check "and installs nothing" test ! -e "$prefix" -a ! -e "$link"

echo "case 6: no xz — installed with apt-get first"
# A PATH holding only what install.sh needs, minus xz: apt-get's stub then puts it back.
NOXZ="$WORK/noxz-bin"
mkdir -p "$NOXZ"
for t in sh curl tar mktemp rm mkdir mv chmod ln dirname cat; do
  ln -sf "$(command -v "$t")" "$NOXZ/$t"
done
cp "$STUB_BIN/uname" "$NOXZ/uname"
cat > "$NOXZ/apt-get" << EOF
#!/bin/sh
echo "apt-get \$*" >> "\$APT_LOG"
case "\$*" in *install*xz-utils*) ln -sf "$(command -v xz)" "$NOXZ/xz" ;; esac
exit 0
EOF
chmod 755 "$NOXZ/apt-get"
prefix="$WORK/c6.lib/helix"; link="$WORK/c6.bin/hx"; aptlog="$WORK/c6.apt.log"
: > "$aptlog"
env -i PATH="$NOXZ" HELIX_PREFIX="$prefix" HELIX_LINK="$link" APT_LOG="$aptlog" \
  HELIX_RELEASES_LATEST_URL="$LATEST_URL" HELIX_RELEASE_BASE="file://$RELEASE" \
  "$NOXZ/sh" "$INSTALL" > "$WORK/out.log" 2>&1
status=$?
check "install.sh succeeds" test "$status" -eq 0
check "apt-get installed xz-utils" grep -q 'install -y --no-install-recommends xz-utils' "$aptlog"
check "hx is installed" test "$("$prefix/hx")" = "helix $TAG x86_64-linux"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
