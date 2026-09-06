#!/bin/bash
# install.sh end to end, offline — version resolution (latest/pinned/-stable), architecture
# mapping, checksum verification, the unzip self-heal, installDependencies, and every option's
# bake into post-create.sh.
#
#   bash features/godot/test/install_options_test.sh
#
# No Docker, no root, no real network: downloads go through the real curl against local
# file:// fixtures (the same technique devc-bridge/test/install_download_test.sh uses — file://
# needs no server, and %{url_effective} on a non-redirecting file:// URL is just the URL you
# asked for, which is exactly what stands in for "the releases/latest redirect resolved to
# this tag" without needing an HTTP server). `uname` and `apt-get` are stubbed on PATH ahead of
# the real ones: uname so both architectures are reachable from one host, apt-get so nothing is
# actually installed. `unzip` and `sha512sum` are left real.
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
check_out() { # check_out <desc> <expected-substring> [<file>]
  local desc="$1" pat="$2" file="${3:-$WORK/out.log}"
  if grep -qF -- "$pat" "$file"; then
    echo "  ok   $desc"
  else
    echo "  FAIL $desc (no '$pat' in $file)"; sed 's/^/       | /' "$file"
    fails=$((fails + 1))
  fi
}

STUB_BIN="$WORK/stub-bin"
mkdir -p "$STUB_BIN"

REAL_UNZIP="$(command -v unzip)"

cat > "$STUB_BIN/apt-get" << EOF
#!/bin/sh
echo "apt-get \$*" >> "\$APT_LOG"
case "\$*" in
  *install*unzip*) ln -sf "$REAL_UNZIP" "$STUB_BIN/unzip" ;;
esac
exit 0
EOF
chmod 755 "$STUB_BIN/apt-get"

# `uname -m` stub, so both architectures are reachable from one (real) host. Everything else on
# PATH stays real.
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

# make_release <dir> <tag> — a release directory with a zip per architecture (each unzipping to
# one flat file that echoes its own tag+arch, so asserting on the *installed* binary proves
# which asset was fetched) and a SHA512-SUMS.txt in the release's own format: two-space
# separated, no `sha512sum -b`-style `*` prefix.
make_release() {
  local dir="$1" tag="$2" arch stage
  mkdir -p "$dir/download/$tag"
  for arch in x86_64 arm64; do
    stage="$WORK/stage-$tag-$arch"
    rm -rf "$stage"; mkdir -p "$stage"
    printf '#!/bin/sh\necho "godot %s %s"\n' "$tag" "$arch" \
      > "$stage/Godot_v${tag}_linux.${arch}"
    chmod 755 "$stage/Godot_v${tag}_linux.${arch}"
    ( cd "$stage" && zip -q "$dir/download/$tag/Godot_v${tag}_linux.${arch}.zip" \
      "Godot_v${tag}_linux.${arch}" )
  done
  ( cd "$dir/download/$tag" && sha512sum ./*.zip | sed 's|\./||' > SHA512-SUMS.txt )
}

RELEASE="$WORK/release"
TAG='4.7.2-stable'
make_release "$RELEASE" "$TAG"

# The "releases/latest" redirect probe: `curl -w '%{url_effective}'` against a URL that does
# NOT redirect just reports back the URL it was given — so a fixture file whose *path* ends in
# the tag we want stands in for "GitHub redirected here", no HTTP server required.
mkdir -p "$RELEASE/releases/tag"
: > "$RELEASE/releases/tag/$TAG"
LATEST_URL="file://$RELEASE/releases/tag/$TAG"

# run_install <name> [VAR=value ...] — sets $share (SHARE_DIR), $link (GODOT_LINK), $aptlog,
# $status. Every case gets its own SHARE_DIR/link/apt log.
run_install() {
  local name="$1"; shift
  share="$WORK/$name.share"; link="$WORK/$name.bin/godot"; aptlog="$WORK/$name.apt.log"
  mkdir -p "$(dirname "$link")"
  : > "$aptlog"
  env -u VERSION -u INSTALLDEPENDENCIES -u PROJECTDIR -u FIXGODOTDIROWNERSHIP \
    PATH="$STUB_BIN:$PATH" SHARE_DIR="$share" GODOT_LINK="$link" APT_LOG="$aptlog" \
    GODOT_RELEASES_LATEST_URL="$LATEST_URL" GODOT_RELEASE_BASE="file://$RELEASE" "$@" \
    sh "$INSTALL" > "$WORK/out.log" 2>&1
  status=$?
}

echo "case 1: a bare {} — version defaults to latest, everything lands"
run_install c1
check "install.sh succeeds" test "$status" -eq 0
check "the binary is installed" test -x "$share/bin/godot"
check "the fake binary reports the resolved tag and arch" \
  test "$("$share/bin/godot")" = "godot $TAG x86_64"
check "the symlink points at it" test "$(readlink "$link")" = "$share/bin/godot"
check "and runs through the link too" test "$("$link")" = "godot $TAG x86_64"
check "no temp file left beside the binary" \
  bash -c "! ls '$share/bin/'godot.tmp.* >/dev/null 2>&1"
check "post-create.sh is installed" test -f "$share/post-create.sh"
check "and is executable" test -x "$share/post-create.sh"
check "projectDir baked empty — the workspace root" \
  grep -qx 'PROJECT_DIR=""' "$share/post-create.sh"
check "fixGodotDirOwnership baked true" \
  grep -qx 'FIX_GODOT_DIR_OWNERSHIP="true"' "$share/post-create.sh"
check "the baked script still parses as shell" sh -n "$share/post-create.sh"
check_out "the summary line names the tag, arch and link" "godot: $TAG (x86_64) installed at $link"
check "installDependencies defaults on: fontconfig was requested" \
  grep -q 'install.*fontconfig' "$aptlog"

echo "case 2: a bare version and its -stable tag resolve to the same asset"
run_install c2a VERSION=4.7.2
check "install.sh succeeds" test "$status" -eq 0
check "the bare version resolved to the -stable tag" \
  test "$("$share/bin/godot")" = "godot $TAG x86_64"
run_install c2b VERSION=4.7.2-stable
check "the full tag installs the same asset" \
  test "$("$share/bin/godot")" = "godot $TAG x86_64"

echo "case 3: architecture mapping — arm64 and aarch64 both select the arm64 asset"
stub_uname arm64
run_install c3a
check "install.sh succeeds" test "$status" -eq 0
check "the arm64 asset was fetched" test "$("$share/bin/godot")" = "godot $TAG arm64"
stub_uname aarch64
run_install c3b
check "aarch64 is the same machine as arm64" \
  test "$("$share/bin/godot")" = "godot $TAG arm64"
stub_uname x86_64

echo "case 4: an unsupported architecture fails before any download"
stub_uname riscv64
run_install c4
check "install.sh fails" test "$status" -ne 0
check_out "naming the architecture" "unsupported architecture riscv64"
check "nothing was installed" test ! -e "$share/bin/godot"
stub_uname x86_64

echo "case 5: version validation rejects characters outside [A-Za-z0-9_.-]"
for bad in '4.7.2; rm -rf /' '4.7.2 stable' '4.7.2$(x)' '4.7.2`x`'; do
  run_install "c5.$RANDOM" "VERSION=$bad"
  check "'$bad' fails the build" test "$status" -ne 0
  check_out "naming the option" "version may not contain characters" "$WORK/out.log"
  check "and installs nothing" test ! -e "$share/bin/godot"
done

echo "case 6: a checksum mismatch aborts with nothing installed"
BAD="$WORK/release-bad"
cp -r "$RELEASE" "$BAD"
printf 'not the asset you asked for' > "$BAD/download/$TAG/Godot_v${TAG}_linux.x86_64.zip"
run_install c6 GODOT_RELEASE_BASE="file://$BAD" GODOT_RELEASES_LATEST_URL="$LATEST_URL"
check "install.sh fails" test "$status" -ne 0
check_out "says checksum mismatch" "checksum mismatch"
check_out "says nothing was installed" "nothing was installed"
check "no binary installed" test ! -e "$share/bin/godot"
check "no symlink created" test ! -e "$link"

echo "case 7: an asset missing from SHA512-SUMS.txt aborts"
NOSUM="$WORK/release-nosum"
cp -r "$RELEASE" "$NOSUM"
grep -v 'linux.x86_64' "$NOSUM/download/$TAG/SHA512-SUMS.txt" \
  > "$NOSUM/download/$TAG/SHA512-SUMS.txt.new"
mv "$NOSUM/download/$TAG/SHA512-SUMS.txt.new" "$NOSUM/download/$TAG/SHA512-SUMS.txt"
run_install c7 GODOT_RELEASE_BASE="file://$NOSUM" GODOT_RELEASES_LATEST_URL="$LATEST_URL"
check "install.sh fails" test "$status" -ne 0
check_out "names the missing entry" "SHA512-SUMS.txt has no entry"
check "no binary installed" test ! -e "$share/bin/godot"

echo "case 8: a missing asset aborts"
GONE="$WORK/release-gone"
cp -r "$RELEASE" "$GONE"
rm "$GONE/download/$TAG/Godot_v${TAG}_linux.x86_64.zip"
run_install c8 GODOT_RELEASE_BASE="file://$GONE" GODOT_RELEASES_LATEST_URL="$LATEST_URL"
check "install.sh fails" test "$status" -ne 0
check_out "says the download failed" "download failed"
check "no binary installed" test ! -e "$share/bin/godot"

echo "case 9: unzip missing is self-healed via apt-get, not a hard failure"
# Not exercised dynamically: this devcontainer's own PATH already has a real unzip on it, and
# hiding one command from `command -v` without also hiding every other tool install.sh needs
# (sha512sum, curl, mv, ...) isn't possible through PATH ordering alone when they all live
# alongside it in /usr/bin. Asserted at the source level instead — that install.sh reaches for
# apt-get only when `command -v unzip` fails, and names the right package.
check "install.sh checks for unzip before reaching for apt-get" \
  grep -q 'have unzip ||' "$INSTALL"
check "and installs the unzip package, not something else" \
  bash -c "grep -A2 'have unzip ||' '$INSTALL' | grep -q 'install -y --no-install-recommends unzip'"

echo "case 10: installDependencies false skips the fontconfig install"
run_install c10 INSTALLDEPENDENCIES=false
check "install.sh succeeds" test "$status" -eq 0
check "no apt-get call was made at all" test ! -s "$aptlog"
check "fixGodotDirOwnership baked true" \
  grep -qx 'FIX_GODOT_DIR_OWNERSHIP="true"' "$share/post-create.sh"

echo "case 11: projectDir bakes through, including values a sed bake would corrupt"
run_install c11 PROJECTDIR=games/app
check "projectDir baked" grep -qx 'PROJECT_DIR="games/app"' "$share/post-create.sh"
run_install c11b 'PROJECTDIR=a & b|c'
check "an & and a | survive verbatim" \
  grep -qxF 'PROJECT_DIR="a & b|c"' "$share/post-create.sh"
check "and the result still parses as shell" sh -n "$share/post-create.sh"
run_install c11c PROJECTDIR=
check "an explicitly empty projectDir stays empty, not a fallback default" \
  grep -qx 'PROJECT_DIR=""' "$share/post-create.sh"

echo "case 12: fixGodotDirOwnership false bakes through"
run_install c12 FIXGODOTDIROWNERSHIP=false
check "baked false" grep -qx 'FIX_GODOT_DIR_OWNERSHIP="false"' "$share/post-create.sh"

echo "case 13: a projectDir that would break the baked quoting is refused, loudly"
for bad in 'a"b' 'a`b' 'a$b' 'a\b' 'a
b'; do
  run_install "c13.$RANDOM" "PROJECTDIR=$bad"
  check "projectDir containing $(printf '%q' "$bad") fails the build" test "$status" -ne 0
  check_out "naming the option" "projectDir"
  check "and installs no hook" test ! -e "$share/post-create.sh"
done
run_install c13x 'PROJECTDIR=a"; touch '"$WORK"'/PWNED; :"'
check "the quote-escape injection fails the build" test "$status" -ne 0
check "and nothing was executed" test ! -e "$WORK/PWNED"

echo "case 14: no DEVC_TOOLS_RELEASE-style pin — this Feature tracks upstream, not a devc-tools release"
check "install.sh names no DEVC_TOOLS_RELEASE" bash -c "! grep -q DEVC_TOOLS_RELEASE '$INSTALL'"

echo "case 15: no installsAfter — nothing else to order behind"
check "the manifest declares no installsAfter" bash -c "! grep -q installsAfter '$MANIFEST'"

echo "case 16: the manifest, install.sh and post-create.sh agree on the fixed paths"
SHARE_DEFAULT=/usr/local/share/devc-features/godot
check "install.sh defaults SHARE_DIR to the Feature namespace" \
  grep -qF "SHARE_DIR:-$SHARE_DEFAULT" "$INSTALL"
check "the manifest's postCreateCommand names where install.sh puts it" \
  grep -qF "$SHARE_DEFAULT/post-create.sh" "$MANIFEST"
check "the manifest declares the .godot volume at the workspace root" \
  grep -qF '"target": "${containerWorkspaceFolder}/.godot"' "$MANIFEST"
check "keyed on \${devcontainerId}, not the workspace basename" \
  grep -qF '"source": "godot-project-cache-${devcontainerId}"' "$MANIFEST"
check "post-create.sh warns when projectDir moves the project off that target" \
  grep -qF 'declares cannot follow it' "$FEATURE_DIR/post-create.sh"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
