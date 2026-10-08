#!/bin/bash
# install.sh end to end, offline — each package group's effect on the resolved set, the `t64`
# name fallback, extraPackages and display/screen validation, and every option's bake into
# xvfb-ensure and post-start.sh.
#
#   bash features/xvfb/test/install_options_test.sh
#
# No Docker, no root, no network: `apt-get` and `apt-cache` are stubbed on PATH ahead of the
# real ones. The apt-get stub records what it was asked for; the apt-cache stub answers
# `apt-cache show <pkg>` from a fixture list of the names one base image knows, which is what
# lets one host stand in for both an Ubuntu 24.04 base (the `t64` names) and a pre-rename one
# (Ubuntu 22.04, Debian bookworm).
set -uo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="$FEATURE_DIR/install.sh"
MANIFEST="$FEATURE_DIR/devcontainer-feature.json"
README="$FEATURE_DIR/README.md"
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

cat > "$STUB_BIN/apt-get" << 'EOF2'
#!/bin/sh
echo "DEBIAN_FRONTEND=${DEBIAN_FRONTEND:-} apt-get $*" >> "$APT_LOG"
exit 0
EOF2
cat > "$STUB_BIN/apt-cache" << 'EOF2'
#!/bin/sh
# Only `apt-cache show <pkg>` is ever asked. Known iff the name is a line of the fixture.
[ "${1:-}" = show ] || exit 2
echo "apt-cache show $2" >> "$APT_LOG"
grep -qxF -- "$2" "$APT_KNOWN" || { echo "E: No packages found" >&2; exit 100; }
EOF2
chmod 755 "$STUB_BIN/apt-get" "$STUB_BIN/apt-cache"

# --- the package lists this harness holds install.sh to ------------------------------------
#
# Spelled out here rather than read back out of install.sh: a harness that derived its
# expectations from the script under test would agree with whatever the script said.
ALWAYS='xvfb xauth x11-utils'
X11='libx11-6 libxext6 libxi6 libxrandr2 libxcursor1 libxinerama1 libxrender1 libxkbcommon0 libfontconfig1'
GL='libgl1 libegl1 libgl1-mesa-dri'
FONTS='fonts-dejavu-core'
VULKAN='libvulkan1 mesa-vulkan-drivers'
TOOLS='imagemagick xdotool'

# What another devcontainer installs today for Aseprite. Must stay covered by a bare `{}`.
ASEPRITE='libx11-6 libfontconfig1 libxcursor1 libgl1 libxext6 libxi6 libxrandr2 xvfb'

# The VS Code / Electron list, and what it must become on each kind of base.
ELECTRON_2404='libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 libxkbfile1 libsecret-1-0 libxshmfence1 libdrm2 libatk-bridge2.0-0t64 libcups2t64'
ELECTRON_PRE='libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxkbfile1 libsecret-1-0 libxshmfence1 libdrm2 libatk-bridge2.0-0 libcups2'

# Fixtures: the names each base knows. Only `t64`-suffixed names are ever looked up, and their
# bare forms when the suffixed one is unknown, so that is all a fixture has to hold.
KNOWN_2404="$WORK/known-2404"
KNOWN_PRE="$WORK/known-pre"
printf '%s\n' libgtk-3-0t64 libasound2t64 libatk-bridge2.0-0t64 libcups2t64 > "$KNOWN_2404"
printf '%s\n' libgtk-3-0 libasound2 libatk-bridge2.0-0 libcups2 > "$KNOWN_PRE"

# run_install <name> [VAR=value ...] — sets $share, $link, $aptlog, $status. Every case gets its
# own SHARE_DIR/link/apt log. $DISPLAY is unset along with the option variables: the `display`
# option arrives under that very name, and this harness may itself be running under a display.
run_install() {
  local name="$1"; shift
  share="$WORK/$name.share"; link="$WORK/$name.bin/xvfb-ensure"; aptlog="$WORK/$name.apt.log"
  : > "$aptlog"
  env -u X11LIBRARIES -u OPENGL -u FONTS -u VULKAN -u TOOLS -u EXTRAPACKAGES -u DISPLAY \
    -u SCREEN -u STARTONCONTAINERSTART \
    PATH="$STUB_BIN:$PATH" SHARE_DIR="$share" XVFB_ENSURE_LINK="$link" APT_LOG="$aptlog" \
    APT_KNOWN="$KNOWN_2404" X11_UNIX_DIR="$WORK/$name.x11-unix" "$@" \
    sh "$INSTALL" > "$WORK/out.log" 2>&1
  status=$?
}

# installed — the packages the one `apt-get install` was asked for, space-separated.
installed() {
  grep ' apt-get install ' "$aptlog" | sed 's/^.* apt-get install //' | tr ' ' '\n' |
    grep -v '^-' | tr '\n' ' ' | sed 's/ $//'
}
has_all() { # has_all "<pkgs>" — every one of them was requested
  local p
  for p in $1; do
    case " $(installed) " in *" $p "*) ;; *) echo "       | missing: $p"; return 1 ;; esac
  done
}
has_none() { # has_none "<pkgs>" — none of them was requested
  local p
  for p in $1; do
    case " $(installed) " in *" $p "*) echo "       | present: $p"; return 1 ;; esac
  done
}
installed_is() { # installed_is "<pkgs>" — exactly these, in this order
  [ "$(installed)" = "$1" ] || { echo "       | got: $(installed)"; return 1; }
}

echo "case 1: a bare {} — Xvfb, the X client libraries, software OpenGL and a font"
run_install c1
check "install.sh succeeds" test "$status" -eq 0
check "the resolved set is exactly always + x11Libraries + openGL + fonts" \
  installed_is "$ALWAYS $X11 $GL $FONTS"
check "the opt-in groups are not installed" has_none "$VULKAN $TOOLS"
check "one apt-get update" test "$(grep -c ' apt-get update' "$aptlog")" -eq 1
check "one apt-get install" test "$(grep -c ' apt-get install ' "$aptlog")" -eq 1
check "the update comes first" bash -c "head -1 '$aptlog' | grep -q ' apt-get update'"
check "without recommends" grep -q ' apt-get install -y --no-install-recommends ' "$aptlog"
check "noninteractive" bash -c "grep ' apt-get install ' '$aptlog' | grep -q '^DEBIAN_FRONTEND=noninteractive '"
check "xvfb-ensure is installed" test -f "$share/bin/xvfb-ensure"
check "and is executable" test -x "$share/bin/xvfb-ensure"
check "the symlink points at it" test "$(readlink "$link")" = "$share/bin/xvfb-ensure"
check "display baked to the default" grep -qx 'DEFAULT_DISPLAY="99"' "$share/bin/xvfb-ensure"
check "screen baked to the default" \
  grep -qx 'DEFAULT_SCREEN="1920x1080x24"' "$share/bin/xvfb-ensure"
check "the baked command still parses as shell" sh -n "$share/bin/xvfb-ensure"
check "post-start.sh is installed" test -f "$share/post-start.sh"
check "and is executable" test -x "$share/post-start.sh"
check "startOnContainerStart baked false" \
  grep -qx 'START_ON_CONTAINER_START_OPT="false"' "$share/post-start.sh"
check "the baked hook still parses as shell" sh -n "$share/post-start.sh"
check "the X socket directory is created sticky and world-writable" \
  test "$(stat -c '%a' "$WORK/c1.x11-unix")" = 1777

echo "case 2: every group off still installs the always-set, and nothing else"
run_install c2 X11LIBRARIES=false OPENGL=false FONTS=false
check "install.sh succeeds" test "$status" -eq 0
check "the resolved set is exactly the always-set" installed_is "$ALWAYS"
check "xvfb-ensure is still installed" test -x "$share/bin/xvfb-ensure"

echo "case 3: each default group turns off on its own"
run_install c3a X11LIBRARIES=false
check "x11Libraries false drops only its packages" installed_is "$ALWAYS $GL $FONTS"
run_install c3b OPENGL=false
check "openGL false drops only its packages" installed_is "$ALWAYS $X11 $FONTS"
run_install c3c FONTS=false
check "fonts false drops only its package" installed_is "$ALWAYS $X11 $GL"

echo "case 4: each opt-in group turns on on its own"
run_install c4a VULKAN=true
check "vulkan adds its packages" installed_is "$ALWAYS $X11 $GL $FONTS $VULKAN"
run_install c4b TOOLS=true
check "tools adds its packages" installed_is "$ALWAYS $X11 $GL $FONTS $TOOLS"

echo "case 5: the Aseprite list is covered by a bare {}"
run_install c5
check "every Aseprite package is in always + x11Libraries + openGL" has_all "$ASEPRITE"
run_install c5b FONTS=false
check "and does not depend on the fonts group" has_all "$ASEPRITE"

echo "case 6: the README's VS Code / Electron extraPackages string resolves on both bases"
# Read out of the README itself, so the recipe a consumer pastes is the string under test.
ELECTRON_CSV="$(grep -o '"extraPackages": "[^"]*libgtk[^"]*"' "$README" | head -1 |
  sed 's/^"extraPackages": "//; s/"$//')"
check "the README carries the recipe" test -n "$ELECTRON_CSV"
check "and it is the list this harness expects" \
  test "$(echo "$ELECTRON_CSV" | tr ',' ' ')" = "$ELECTRON_2404"
run_install c6a "EXTRAPACKAGES=$ELECTRON_CSV" APT_KNOWN="$KNOWN_2404"
check "install.sh succeeds on a 24.04 fixture" test "$status" -eq 0
check "the t64 names are kept where the base knows them" \
  installed_is "$ALWAYS $X11 $GL $FONTS $ELECTRON_2404"
run_install c6b "EXTRAPACKAGES=$ELECTRON_CSV" APT_KNOWN="$KNOWN_PRE"
check "install.sh succeeds on a pre-t64 fixture" test "$status" -eq 0
check "the t64 names fall back to the bare ones" \
  installed_is "$ALWAYS $X11 $GL $FONTS $ELECTRON_PRE"
check "no t64 name reaches apt-get install there" \
  bash -c "! grep ' apt-get install ' '$aptlog' | grep -q 't64'"

echo "case 7: the t64 fallback, one name at a time"
run_install c7a EXTRAPACKAGES=libcups2t64 APT_KNOWN="$KNOWN_2404"
check "suffixed when the suffixed name is known" has_all 'libcups2t64'
check "and the bare name is not added beside it" has_none 'libcups2'
run_install c7b EXTRAPACKAGES=libcups2t64 APT_KNOWN="$KNOWN_PRE"
check "bare when only the bare name is known" has_all 'libcups2'
check "and the suffixed name is dropped" has_none 'libcups2t64'
run_install c7c EXTRAPACKAGES=libnosucht64 APT_KNOWN="$KNOWN_2404"
check "neither known fails the build" test "$status" -ne 0
check_out "naming the suffixed name" 'libnosucht64'
check_out "and the bare one" 'nor libnosuch is'
check "before anything is installed" bash -c "! grep -q ' apt-get install ' '$aptlog'"
check "and nothing of the Feature's is placed" test ! -e "$share/bin/xvfb-ensure"
run_install c7d EXTRAPACKAGES=libnss3 APT_KNOWN="$KNOWN_PRE"
check "a name without the suffix is never looked up" \
  bash -c "! grep -q 'apt-cache show' '$aptlog'"
check "and is passed through as written" has_all 'libnss3'

echo "case 8: extraPackages is split on commas, trimmed, and deduplicated"
run_install c8 'EXTRAPACKAGES= libnss3 , libgbm1,,libnss3, g++-12 ,libstdc++6,xvfb'
check "install.sh succeeds" test "$status" -eq 0
check "entries land once each, after the groups" \
  installed_is "$ALWAYS $X11 $GL $FONTS libnss3 libgbm1 g++-12 libstdc++6"
run_install c8b EXTRAPACKAGES=
check "an empty extraPackages adds nothing" installed_is "$ALWAYS $X11 $GL $FONTS"

echo "case 9: an extraPackages entry that is not a package name fails the build"
for bad in '-o=Dpkg::Options' 'libnss3=1.0' 'Libnss3' 'lib nss3' 'libnss3;id' 'lib$(id)' \
  '../etc' 'libnss3:amd64' '+plus'; do
  run_install "c9.$RANDOM" "EXTRAPACKAGES=libgbm1,$bad"
  check "$(printf '%q' "$bad") fails the build" test "$status" -ne 0
  check_out "naming the option" 'extraPackages entry is not a package name'
  check "before apt-get is touched" test ! -s "$aptlog"
done

echo "case 10: display and screen are validated at build time"
for bad in ':99' '9a' '-1' '99 ' '9;id' '$(id)'; do
  run_install "c10.$RANDOM" "DISPLAY=$bad"
  check "display $(printf '%q' "$bad") fails the build" test "$status" -ne 0
  check_out "naming the option" 'display must be digits only'
  check "before apt-get is touched" test ! -s "$aptlog"
done
for bad in '1920x1080' '1920x1080x12' '1920X1080x24' 'x1080x24' '1920x1080x24 ' \
  '1920x1080x24;id' '1920x1080x24x1'; do
  run_install "c10.$RANDOM" "SCREEN=$bad"
  check "screen $(printf '%q' "$bad") fails the build" test "$status" -ne 0
  check_out "naming the option" 'screen must be <width>x<height>x<depth>'
  check "before apt-get is touched" test ! -s "$aptlog"
done

echo "case 11: display and screen bake into xvfb-ensure"
run_install c11 DISPLAY=42 SCREEN=1280x720x16
check "install.sh succeeds" test "$status" -eq 0
check "display baked" grep -qx 'DEFAULT_DISPLAY="42"' "$share/bin/xvfb-ensure"
check "screen baked" grep -qx 'DEFAULT_SCREEN="1280x720x16"' "$share/bin/xvfb-ensure"
check "no fallback line left behind for either" \
  bash -c "! grep -qE '^DEFAULT_(DISPLAY|SCREEN)=\"\\$\\{' '$share/bin/xvfb-ensure'"
check "the baked command still parses as shell" sh -n "$share/bin/xvfb-ensure"
check_out "the summary line names both" 'display :42, screen 1280x720x16'
for depth in 8 16 24 32; do
  run_install "c11.$depth" "SCREEN=800x600x$depth"
  check "a depth of $depth is accepted" test "$status" -eq 0
done

echo "case 12: startOnContainerStart bakes into post-start.sh"
run_install c12 STARTONCONTAINERSTART=true
check "baked true" grep -qx 'START_ON_CONTAINER_START_OPT="true"' "$share/post-start.sh"
check "the baked hook still parses as shell" sh -n "$share/post-start.sh"

echo "case 13: the baked hook does what the option says"
# The real post-start.sh as install.sh baked it, with a stand-in for xvfb-ensure beside it.
run_install c13off
printf '#!/bin/sh\necho ran >> "%s"\necho '"'"'export DISPLAY=":99"'"'"'\n' "$WORK/c13.ran" \
  > "$share/bin/xvfb-ensure"
sh "$share/post-start.sh" > "$WORK/out.log" 2>&1
check "off: exits 0" test "$?" -eq 0
check_out "off: says it is not starting anything" 'startOnContainerStart is false'
check "off: xvfb-ensure was not run" test ! -e "$WORK/c13.ran"
run_install c13on STARTONCONTAINERSTART=true
printf '#!/bin/sh\necho "ran DISPLAY=${DISPLAY-unset}" >> "%s"\necho '"'"'export DISPLAY=":99"'"'"'\n' \
  "$WORK/c13.ran" > "$share/bin/xvfb-ensure"
DISPLAY=:0 sh "$share/post-start.sh" > "$WORK/out.log" 2>&1
check "on: exits 0" test "$?" -eq 0
check "on: xvfb-ensure was run, with any inherited DISPLAY cleared" \
  grep -qx 'ran DISPLAY=unset' "$WORK/c13.ran"
check_out "on: logs the display it reports" 'virtual display ready at :99'
printf '#!/bin/sh\necho "nothing came up" >&2\nexit 1\n' > "$share/bin/xvfb-ensure"
sh "$share/post-start.sh" > "$WORK/out.log" 2>&1
check "on, and xvfb-ensure fails: still exits 0" test "$?" -eq 0
check_out "and says so" 'could not start a display'
rm -f "$share/bin/xvfb-ensure"
sh "$share/post-start.sh" > "$WORK/out.log" 2>&1
check "on, and xvfb-ensure is missing: still exits 0" test "$?" -eq 0

echo "case 14: the manifest declares what the plan says, and nothing it rules out"
check "no containerEnv — DISPLAY is never set globally" \
  bash -c "! grep -q containerEnv '$MANIFEST'"
check "no mounts" bash -c "! grep -q '\"mounts\"' '$MANIFEST'"
check "no installsAfter" bash -c "! grep -q installsAfter '$MANIFEST'"
check "install.sh names no DEVC_TOOLS_RELEASE — this Feature downloads nothing" \
  bash -c "! grep -q DEVC_TOOLS_RELEASE '$INSTALL'"
check "xvfb-ensure never calls apt-get" \
  bash -c "! grep -v '^ *#' '$FEATURE_DIR/xvfb-ensure' | grep -q 'apt-get'"
check "nor does post-start.sh" \
  bash -c "! grep -v '^ *#' '$FEATURE_DIR/post-start.sh' | grep -q 'apt-get'"

echo "case 15: the manifest and install.sh agree on the fixed paths and the defaults"
SHARE_DEFAULT=/usr/local/share/devc-features/xvfb
check "install.sh defaults SHARE_DIR to the Feature namespace" \
  grep -qF "SHARE_DIR:-$SHARE_DEFAULT" "$INSTALL"
check "the manifest's postStartCommand names where install.sh puts it" \
  grep -qF "\"postStartCommand\": \"bash $SHARE_DEFAULT/post-start.sh\"" "$MANIFEST"
check "install.sh links xvfb-ensure into /usr/local/bin" \
  grep -qF 'XVFB_ENSURE_LINK:-/usr/local/bin/xvfb-ensure' "$INSTALL"
manifest_default() { # manifest_default <option> — its "default", as JSON prints it
  awk -v opt="\"$1\": {" '
    index($0, opt) { on = 1 }
    on && /"default":/ { sub(/^.*"default": */, ""); sub(/,$/, ""); print; exit }
  ' "$MANIFEST"
}
for pair in x11Libraries=true openGL=true fonts=true vulkan=false tools=false \
  'extraPackages=""' 'display="99"' 'screen="1920x1080x24"' startOnContainerStart=false; do
  check "manifest default: $pair" test "$(manifest_default "${pair%%=*}")" = "${pair#*=}"
done
check "xvfb-ensure's unbaked default display matches the manifest's" \
  grep -qx 'DEFAULT_DISPLAY="${DEFAULT_DISPLAY:-99}"' "$FEATURE_DIR/xvfb-ensure"
check "and its unbaked default screen" \
  grep -qx 'DEFAULT_SCREEN="${DEFAULT_SCREEN:-1920x1080x24}"' "$FEATURE_DIR/xvfb-ensure"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
