#!/bin/bash
# install.sh end to end, offline — every option's journey into the baked post-create.sh, the
# values that must fail the build, and the fact that no startup file is touched at all.
#
#   bash features/node-nvmrc/test/install_options_test.sh
#
# No Docker and no root: _REMOTE_USER_HOME and SHARE_DIR point at temp directories, which are
# the only things install.sh writes to. _REMOTE_USER is left unset so the chown of pin/ is
# skipped — it is best-effort here and a scenario under Docker is what can actually exercise it.
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

# run_install <name> [VAR=value ...] — sets $H, $share, $status. $H is a temp HOME that nothing
# in this Feature should ever write into as of 0.2.0; every case checks that it stayed empty.
run_install() {
  local name="$1"; shift
  H="$WORK/$name"; share="$WORK/$name.share"
  mkdir -p "$H"
  env -u NVMDIR -u PROJECTDIR -u INSTALLONCREATE -u FIXNODEMODULESOWNERSHIP \
    SHARE_DIR="$share" _REMOTE_USER_HOME="$H" HOME="$H" "$@" \
    sh "$INSTALL" > "$WORK/out.log" 2>&1
  status=$?
}

echo "case 1: a bare {} — the script, the baked defaults, the empty pin/"
run_install c1
check "install.sh succeeds" test "$status" -eq 0
check "post-create.sh is installed" test -f "$share/post-create.sh"
check "and is executable" test -x "$share/post-create.sh"
check "nvmDir baked to the upstream node Feature's location" \
  grep -qx 'NVM_DIR="/usr/local/share/nvm"' "$share/post-create.sh"
# The empty default is what tells a silent miss from a warned one at create time, so it has to
# survive the bake as an actual empty string.
check "projectDir baked empty" grep -qx 'PROJECT_DIR=""' "$share/post-create.sh"
check "installOnCreate baked true" \
  grep -qx 'INSTALL_ON_CREATE="true"' "$share/post-create.sh"
check "fixNodeModulesOwnership baked true" \
  grep -qx 'FIX_NODE_MODULES_OWNERSHIP="true"' "$share/post-create.sh"
# The hook cannot discover where it was installed — the manifest calls it by absolute path — so
# the directory it creates the symlink under is baked too.
check "SHARE_DIR baked to where it was installed" \
  grep -qxF "SHARE_DIR=\"$share\"" "$share/post-create.sh"
check "pin/ exists" test -d "$share/pin"
check "and is empty — the symlink is create-time work" bash -c \
  "[ -z \"\$(ls -A '$share/pin')\" ]"
check "the baked script still parses as shell" sh -n "$share/post-create.sh"

echo "case 2: no startup file is written, anywhere, under any option combination"
# This is the whole of what 0.2.0 removed. A block in ~/.bashrc reaches only interactive bash,
# which is measurably not the audience — if one ever comes back, it comes back here first.
for opts in '' 'PROJECTDIR=packages/app' 'INSTALLONCREATE=false' \
  'FIXNODEMODULESOWNERSHIP=false' 'NVMDIR=/opt/nvm'; do
  # shellcheck disable=SC2086
  run_install "c2$RANDOM" $opts
  check "with '${opts:-no options}': install succeeds" test "$status" -eq 0
  check "  no ~/.bashrc is created" test ! -e "$H/.bashrc"
  check "  no ~/.profile is created" test ! -e "$H/.profile"
  check "  no ~/.bash_profile is created" test ! -e "$H/.bash_profile"
  check "  the home directory is untouched entirely" bash -c \
    "[ -z \"\$(ls -A '$H')\" ]"
  check "  and no node-nvmrc marker is written anywhere in it" bash -c \
    "! grep -rqF 'node-nvmrc' '$H' 2> /dev/null"
done
# An existing ~/.bashrc is left byte-identical, which the empty-directory check above cannot say.
run_install c2b
printf '%s\n' 'alias existing=1' > "$H/.bashrc"
cp "$H/.bashrc" "$WORK/bashrc-before"
run_install c2b
check "an existing ~/.bashrc is byte-identical afterwards" \
  cmp -s "$WORK/bashrc-before" "$H/.bashrc"

echo "case 3: every option reaches the baked script"
run_install c3 NVMDIR=/opt/nvm PROJECTDIR=packages/app INSTALLONCREATE=false \
  FIXNODEMODULESOWNERSHIP=false
check "nvmDir" grep -qx 'NVM_DIR="/opt/nvm"' "$share/post-create.sh"
check "projectDir" grep -qx 'PROJECT_DIR="packages/app"' "$share/post-create.sh"
check "installOnCreate" grep -qx 'INSTALL_ON_CREATE="false"' "$share/post-create.sh"
check "fixNodeModulesOwnership" \
  grep -qx 'FIX_NODE_MODULES_OWNERSHIP="false"' "$share/post-create.sh"
check "and each was rewritten exactly once" bash -c \
  "[ \"\$(grep -c '^NVM_DIR=' '$share/post-create.sh')\" = 1 ] &&
   [ \"\$(grep -c '^PROJECT_DIR=' '$share/post-create.sh')\" = 1 ]"
# `export NVM_DIR` further down the file starts with `export`, not `NVM_DIR=`, so the bake must
# leave it alone — otherwise nvm is never exported to the shell that sources nvm.sh.
check "the later 'export NVM_DIR' line survives" \
  grep -qx 'export NVM_DIR' "$share/post-create.sh"

echo "case 4: an explicitly empty projectDir stays empty"
# `${VAR-default}`, not `${VAR:-default}`. An empty projectDir means the workspace root; if it
# fell back to a default this would silently pin somewhere else, and the warn/silent distinction
# at create time would invert.
run_install c4 PROJECTDIR=
check "PROJECT_DIR is the empty string" grep -qx 'PROJECT_DIR=""' "$share/post-create.sh"
check "and not a default that crept in" bash -c \
  "! grep -q '^PROJECT_DIR=\".\\+\"$' '$share/post-create.sh'"
check "the baked file's own fallback is \${PROJECT_DIR-}, not \${PROJECT_DIR:-}" \
  grep -qxF 'PROJECT_DIR="${PROJECT_DIR-}"' "$FEATURE_DIR/post-create.sh"

echo "case 5: values a sed bake would corrupt survive verbatim"
# The bake goes through awk -v rather than sed: in a sed replacement an `&` back-references the
# whole match and a `|` ends the expression. This case fails against the 0.1.0 code.
run_install c5 'NVMDIR=/opt/nvm & co' 'PROJECTDIR=pkgs/a|b'
check "an & in nvmDir is data, not a back-reference" \
  grep -qxF 'NVM_DIR="/opt/nvm & co"' "$share/post-create.sh"
check "a | in projectDir does not end anything" \
  grep -qxF 'PROJECT_DIR="pkgs/a|b"' "$share/post-create.sh"
check "and the result still parses as shell" sh -n "$share/post-create.sh"
check "with the values readable back out of it" bash -c \
  "eval \"\$(grep -m1 '^NVM_DIR=' '$share/post-create.sh')\"
   eval \"\$(grep -m1 '^PROJECT_DIR=' '$share/post-create.sh')\"
   [ \"\$NVM_DIR\" = '/opt/nvm & co' ] && [ \"\$PROJECT_DIR\" = 'pkgs/a|b' ]"
run_install c5b 'PROJECTDIR=a b/c-d.e'
check "spaces and punctuation survive the round trip" \
  grep -qxF 'PROJECT_DIR="a b/c-d.e"' "$share/post-create.sh"

echo "case 6: an option that would break the quoting is refused, loudly"
# Both values are pasted into a double-quoted shell assignment. Unvalidated, an nvmDir of
#   /opt/n"; touch /tmp/PWNED; :"
# bakes to a line that runs that command — and passes a verify grep built from the same
# unescaped value. A failed build is the only acceptable outcome.
for opt in NVMDIR PROJECTDIR; do
  name_of_opt=nvmDir; [ "$opt" = PROJECTDIR ] && name_of_opt=projectDir
  for bad in 'a"b' 'a`b' 'a$b' 'a\b' 'a
b'; do
    run_install "c6.$RANDOM" "$opt=$bad"
    check "$name_of_opt containing $(printf '%q' "$bad") fails the build" test "$status" -ne 0
    check "  naming the option" grep -q "$name_of_opt" "$WORK/out.log"
    check "  and installs no hook" test ! -e "$share/post-create.sh"
  done
done
# The specific injection the validation exists for.
run_install c6x 'NVMDIR=/opt/n"; touch '"$WORK"'/PWNED; :"'
check "the quote-escape injection fails the build" test "$status" -ne 0
check "and nothing was executed" test ! -e "$WORK/PWNED"

echo "case 7: a bake that cannot take fails the build rather than half-wiring an option"
# The failure mode this exists for: a rename or reformat upstream leaves the option unwired and
# the `${VAR:-default}` fallback quietly stands in for whatever the consumer asked for.
BROKEN="$WORK/broken"
mkdir -p "$BROKEN"
cp "$FEATURE_DIR/install.sh" "$BROKEN/install.sh"
sed 's/^PROJECT_DIR=/PROJECT_DIRECTORY=/' "$FEATURE_DIR/post-create.sh" \
  > "$BROKEN/post-create.sh"
out="$(env -u PROJECTDIR SHARE_DIR="$WORK/broken.share" _REMOTE_USER_HOME="$WORK/broken.home" \
  sh "$BROKEN/install.sh" 2>&1)"
check "a renamed assignment fails the build" test $? -ne 0
check "  naming the variable" bash -c "printf %s \"\$1\" | grep -q 'could not bake PROJECT_DIR'" _ "$out"

echo "case 8: the four files agree on one literal path"
# /usr/local/share/devc-features/node-nvmrc appears in the manifest twice (the containerEnv PATH
# entry and the postCreateCommand), in install.sh's SHARE_DIR default and in post-create.sh's.
# Nothing but this catches a rename.
SHARE_DEFAULT=/usr/local/share/devc-features/node-nvmrc
MANIFEST="$FEATURE_DIR/devcontainer-feature.json"
check "install.sh defaults SHARE_DIR to the Feature namespace" \
  grep -qF "SHARE_DIR:-$SHARE_DEFAULT" "$INSTALL"
check "post-create.sh agrees" grep -qF "SHARE_DIR:-$SHARE_DEFAULT" "$FEATURE_DIR/post-create.sh"
check "the manifest's postCreateCommand names where install.sh puts it" \
  grep -qF "$SHARE_DEFAULT/post-create.sh" "$MANIFEST"
check "and its containerEnv PATH entry names pin/bin under the same directory" \
  grep -qF "$SHARE_DEFAULT/pin/bin:\${PATH}" "$MANIFEST"
check "post-create.sh links into \$SHARE_DIR/pin/bin" \
  grep -qF 'ln -sfn "$NVM_BIN" "$SHARE_DIR/pin/bin"' "$FEATURE_DIR/post-create.sh"
check "install.sh creates that same pin/ directory" \
  grep -qF 'mkdir -p "$SHARE_DIR/pin"' "$INSTALL"

echo "case 9: what 0.2.0 removed stays removed"
check "no autoUseOnCd option in the manifest" bash -c "! grep -q autoUseOnCd '$MANIFEST'"
check "install.sh never mentions it" bash -c "! grep -q AUTOUSEONCD '$INSTALL'"
# The Feature's own files, not test/ — this harness names the fence itself in order to look
# for it.
check "no devc:nvm-use fence in any shipped file" bash -c \
  "! grep -q 'devc:nvm-use' '$INSTALL' '$FEATURE_DIR/post-create.sh' '$MANIFEST' \
     '$FEATURE_DIR/README.md'"
check "no cd() override is written" bash -c "! grep -q 'builtin cd' '$INSTALL'"
check "and nvm_use_test.sh is gone" test ! -e "$FEATURE_DIR/test/nvm_use_test.sh"
check "the manifest is 0.1.0" grep -qF '"version": "0.1.0"' "$MANIFEST"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
