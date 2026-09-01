#!/bin/bash
# post-create.sh — the pin symlink, where projectDir sends the whole hook, and the grading of
# every failure path.
#
#   bash features/node-nvmrc/test/post_create_test.sh
#
# Offline: the real install.sh installs into a temp SHARE_DIR, and the real installed hook runs
# against a **fake nvm.sh** that behaves the way the real one does in the two respects this
# Feature depends on — `nvm install` reads `.nvmrc` from its own cwd, and exports NVM_BIN as the
# installed version's bin directory. `sudo` is stubbed on PATH so the node_modules repair is
# observable without root; both stubs log what they were asked to do and from where, which is
# how "the hook ran in the project directory" is measured rather than assumed.
set -uo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

# --- the two stubs ---------------------------------------------------------------------------

BIN="$WORK/bin"
mkdir -p "$BIN"
# `sudo -n chown -R <uid>:<gid> ./node_modules` is relative, so the cwd is half the assertion:
# which node_modules got repaired is exactly what projectDir moves.
cat > "$BIN/sudo" << 'SUDO'
#!/bin/sh
echo "cwd=$PWD args=$*" >> "$SUDO_LOG"
SUDO
chmod +x "$BIN/sudo"

# The real `nvm install` with no arguments resolves .nvmrc from its cwd (walking *up* if it does
# not find one, which is the behavior the hook's own [ -f .nvmrc ] guard exists to forestall),
# and exports NVM_BIN because it runs `nvm use` implicitly. Both are reproduced; the walk-up is
# not, deliberately — the hook must never reach nvm in that case, and the log is what proves it.
NVM_SH="$WORK/nvm.sh"
cat > "$NVM_SH" << 'NVMSH'
# fake nvm for features/node-nvmrc/test/post_create_test.sh
nvm() {
  _cmd="$1"
  shift
  case "$_cmd" in
    install)
      echo "install cwd=$PWD pinned=$(cat .nvmrc 2> /dev/null)" >> "$NVM_LOG"
      if [ "${FAKE_NVM_INSTALL_FAIL:-}" = 1 ]; then
        echo 'fake nvm: install failed' >&2
        return 1
      fi
      _v="$(tr -dc '0-9' < .nvmrc)"
      mkdir -p "$NVM_DIR/versions/node/v$_v.9.9/bin"
      printf '#!/bin/sh\necho v%s.9.9\n' "$_v" > "$NVM_DIR/versions/node/v$_v.9.9/bin/node"
      chmod +x "$NVM_DIR/versions/node/v$_v.9.9/bin/node"
      if [ "${FAKE_NVM_NO_BIN:-}" != 1 ]; then
        NVM_BIN="$NVM_DIR/versions/node/v$_v.9.9/bin"
        export NVM_BIN
      fi
      return 0
      ;;
    current)
      echo "v${_v:-0}.9.9"
      ;;
    alias)
      echo "alias $*" >> "$NVM_LOG"
      if [ "${FAKE_NVM_ALIAS_FAIL:-}" = 1 ]; then
        return 1
      fi
      ;;
  esac
}
NVMSH

# --- harness ---------------------------------------------------------------------------------

# setup <name> [PROJECTDIR=... ...] — a temp SHARE_DIR with the Feature installed into it, a
# workspace, and a private NVM_DIR carrying the fake nvm.sh. Pass NO_NVM=1 for the
# nothing-provides-nvm case.
setup() {
  NAME="$1"; shift
  SHARE="$WORK/$NAME/share"; WS="$WORK/$NAME/ws"; NVMD="$WORK/$NAME/nvm"
  NVM_LOG="$WORK/$NAME/nvm.log"; SUDO_LOG="$WORK/$NAME/sudo.log"
  rm -rf "${WORK:?}/$NAME"
  mkdir -p "$WS" "$NVMD"
  : > "$NVM_LOG"
  : > "$SUDO_LOG"
  local no_nvm=''
  case "${1:-}" in NO_NVM=1) no_nvm=1; shift ;; esac
  [ -n "$no_nvm" ] || cp "$NVM_SH" "$NVMD/nvm.sh"
  env -u PROJECTDIR -u INSTALLONCREATE -u FIXNODEMODULESOWNERSHIP \
    SHARE_DIR="$SHARE" NVMDIR="$NVMD" "$@" \
    sh "$FEATURE_DIR/install.sh" > "$WORK/install.log" 2>&1
  HOOK="$SHARE/post-create.sh"
  PIN="$SHARE/pin/bin"
}

# run_hook [ENV=val ...] — the hook as the CLI runs it: as the remote user, with the workspace
# folder as its cwd. PROJECT_PATH is unset unless a case sets it, because this harness runs
# inside a devcontainer that has one and inheriting it would make every case an override case.
run_hook() {
  # NVM_BIN is unset explicitly: this harness runs inside a devcontainer that has nvm
  # loaded, and inheriting it would make case 7 pass by accident.
  ( cd "$WS" && env -u PROJECT_PATH -u NVM_BIN PATH="$BIN:$PATH" \
      NVM_LOG="$NVM_LOG" SUDO_LOG="$SUDO_LOG" "$@" sh "$HOOK" ) \
    > "$WORK/hook.out" 2> "$WORK/hook.err"
  status=$?
}

# Where the fake nvm was told to install from, and what it read there.
install_cwd() { sed -n 's/^install cwd=\([^ ]*\).*/\1/p' "$NVM_LOG"; }

echo "case 1: the symlink — created, resolving, and pointing where nvm said"
setup c1
echo 20 > "$WS/.nvmrc"
check "before the hook there is no pin/bin" test ! -e "$PIN"
check "and pin/ is an empty directory on PATH" bash -c "[ -z \"\$(ls -A '$SHARE/pin')\" ]"
run_hook
check "the hook succeeds" test "$status" -eq 0
check "pin/bin is a symlink" test -L "$PIN"
check "it resolves to a directory" test -d "$PIN"
check "pointing at the version nvm installed" \
  test "$(readlink "$PIN")" = "$NVMD/versions/node/v20.9.9/bin"
# The point of the whole mechanism: a plain non-interactive shell with only this on PATH finds
# the pinned node. No startup file, no shell language, no interactivity.
check "a non-interactive sh finds node through it" bash -c \
  "[ \"\$(env PATH='$PIN' /bin/sh -c 'node' 2>/dev/null)\" = v20.9.9 ]"
check "nvm was run in the workspace" test "$(install_cwd)" = "$WS"
check "and read the workspace's .nvmrc" grep -q 'pinned=20' "$NVM_LOG"
check "nvm's own default alias was moved to it" grep -qx 'alias default v20.9.9' "$NVM_LOG"
check "the hook says where it pointed the symlink" grep -qF "$PIN -> " "$WORK/hook.out"

echo "case 2: a second run replaces the symlink rather than nesting inside it"
# `ln -sfn`, not `ln -sf`: without -n the second run resolves the existing symlink-to-a-directory
# and creates pin/bin/bin, leaving PATH pointing at a directory with nothing in it.
echo 22 > "$WS/.nvmrc"
run_hook
check "the second run succeeds" test "$status" -eq 0
check "pin/bin is still a symlink" test -L "$PIN"
check "and there is no pin/bin/bin" test ! -e "$PIN/bin"
check "it now points at the new version" \
  test "$(readlink "$PIN")" = "$NVMD/versions/node/v22.9.9/bin"
check "pin/ still holds exactly one entry" bash -c \
  "[ \"\$(ls -A '$SHARE/pin' | tr '\\n' ' ')\" = 'bin ' ]"

echo "case 3: no .nvmrc at the default location — silent, 0, and no symlink"
setup c3
run_hook
check "the hook exits 0" test "$status" -eq 0
check "saying nothing at all" bash -c \
  "[ ! -s '$WORK/hook.out' ] && [ ! -s '$WORK/hook.err' ]"
check "no symlink is created" test ! -e "$PIN"
# The inert case, asserted rather than assumed: a PATH entry naming a directory that does not
# exist is skipped, so lookup falls through to whatever else provides node.
check "so the PATH entry names nothing and is skipped" bash -c \
  "[ ! -e '$PIN' ] && [ \"\$(env PATH='$PIN:$BIN' /bin/sh -c 'command -v sudo')\" = '$BIN/sudo' ]"
check "and nvm was never reached" test ! -s "$NVM_LOG"

echo "case 4: nvm is missing — the existing warning, 0, and no symlink"
setup c4 NO_NVM=1
echo 20 > "$WS/.nvmrc"
run_hook
check "the hook exits 0" test "$status" -eq 0
check "it names the directory it searched" grep -qF "no nvm at $NVMD" "$WORK/hook.err"
check "and points at the node Feature" \
  grep -qF 'ghcr.io/devcontainers/features/node' "$WORK/hook.err"
check "no symlink is created" test ! -e "$PIN"

echo "case 5: installOnCreate false — nothing happens at all"
setup c5 INSTALLONCREATE=false
echo 20 > "$WS/.nvmrc"
run_hook
check "the hook exits 0" test "$status" -eq 0
check "silently" bash -c "[ ! -s '$WORK/hook.out' ] && [ ! -s '$WORK/hook.err' ]"
check "no symlink is created" test ! -e "$PIN"
check "and nvm was never reached" test ! -s "$NVM_LOG"

echo "case 6: nvm install failing is fatal — the one path that is"
setup c6
echo 20 > "$WS/.nvmrc"
run_hook FAKE_NVM_INSTALL_FAIL=1
check "the hook fails" test "$status" -ne 0
check "and leaves no symlink behind" test ! -e "$PIN"

echo "case 7: nvm install succeeding without NVM_BIN is fatal too"
# The link target comes from NVM_BIN outright — no version string is parsed anywhere here — so
# an nvm that stopped exporting it must fail loudly rather than silently link nothing.
setup c7
echo 20 > "$WS/.nvmrc"
run_hook FAKE_NVM_NO_BIN=1
check "the hook fails" test "$status" -ne 0
check "saying why" grep -q 'NVM_BIN is unset' "$WORK/hook.err"
check "and leaves no symlink behind" test ! -e "$PIN"

echo "case 8: a failing 'nvm alias default' warns and still succeeds"
# The PATH entry is authoritative; the alias only keeps nvm's own state from disagreeing with
# it, so it must not be able to fail the create.
setup c8
echo 20 > "$WS/.nvmrc"
run_hook FAKE_NVM_ALIAS_FAIL=1
check "the hook exits 0" test "$status" -eq 0
check "the symlink is still there" test -L "$PIN"
check "and it says the pin still holds" \
  grep -q 'could not set nvm.s default alias' "$WORK/hook.err"

echo "case 9: the node_modules repair — where it fires, and where it does not"
setup c9
echo 20 > "$WS/.nvmrc"
mkdir -p "$WS/node_modules"
run_hook
check "sudo was called once" test "$(wc -l < "$SUDO_LOG")" -eq 1
check "from the workspace" grep -qF "cwd=$WS " "$SUDO_LOG"
check "on ./node_modules, recursively, non-interactively" \
  grep -qF -- '-n chown -R' "$SUDO_LOG"
check "and never on the workspace itself" bash -c \
  "! grep -qF ' $WS\$' '$SUDO_LOG' && grep -qF './node_modules' '$SUDO_LOG'"

setup c9b
echo 20 > "$WS/.nvmrc"
run_hook
check "with no node_modules, no chown is attempted at all" test ! -s "$SUDO_LOG"

setup c9c FIXNODEMODULESOWNERSHIP=false
echo 20 > "$WS/.nvmrc"
mkdir -p "$WS/node_modules"
run_hook
check "and fixNodeModulesOwnership false skips it even when one exists" test ! -s "$SUDO_LOG"

echo "case 10: projectDir — a workspace-relative subdirectory takes the whole hook with it"
setup c10 PROJECTDIR=packages/app
mkdir -p "$WS/packages/app"
echo 20 > "$WS/packages/app/.nvmrc"
run_hook
check "the hook succeeds" test "$status" -eq 0
check "nvm ran in the project directory, not the workspace" \
  test "$(install_cwd)" = "$WS/packages/app"
check "and the symlink was still written" test -L "$PIN"

echo "case 11: the chown follows projectDir — including when both directories exist"
# The case a relocated chown gets wrong silently: with a node_modules at *both* levels, an
# unmoved repair would fire on the workspace root's and look like it worked.
setup c11 PROJECTDIR=packages/app
mkdir -p "$WS/packages/app" "$WS/node_modules" "$WS/packages/app/node_modules"
echo 20 > "$WS/packages/app/.nvmrc"
run_hook
check "sudo was called exactly once" test "$(wc -l < "$SUDO_LOG")" -eq 1
check "with the project directory as its cwd" grep -qF "cwd=$WS/packages/app " "$SUDO_LOG"
check "and not the workspace root" bash -c "! grep -qF 'cwd=$WS ' '$SUDO_LOG'"

echo "case 12: an absolute projectDir is used as-is"
setup c12 "PROJECTDIR=$WORK/c12/elsewhere"
mkdir -p "$WORK/c12/elsewhere"
echo 20 > "$WORK/c12/elsewhere/.nvmrc"
# A .nvmrc at the workspace root too, so "used as-is" is distinguishable from "appended".
echo 18 > "$WS/.nvmrc"
run_hook
check "the hook succeeds" test "$status" -eq 0
check "nvm ran in the absolute directory" test "$(install_cwd)" = "$WORK/c12/elsewhere"
check "and pinned that directory's version" grep -q 'pinned=20' "$NVM_LOG"

echo "case 13: a projectDir that does not exist warns and exits 0 without reaching nvm"
setup c13 PROJECTDIR=packages/nope
echo 20 > "$WS/.nvmrc"
run_hook
check "the hook exits 0" test "$status" -eq 0
check "naming the option and the value" \
  grep -qF "projectDir 'packages/nope' does not exist" "$WORK/hook.err"
check "nvm was never reached" test ! -s "$NVM_LOG"
check "and no symlink was created" test ! -e "$PIN"

echo "case 14: an explicit projectDir with no .nvmrc warns; the default stays silent"
setup c14 PROJECTDIR=packages/app
mkdir -p "$WS/packages/app"
run_hook
check "the hook exits 0" test "$status" -eq 0
check "it says which directory it looked in" \
  grep -qF "no .nvmrc in $WS/packages/app" "$WORK/hook.err"
check "and installed nothing" test ! -s "$NVM_LOG"
setup c14b
run_hook
check "while the default location says nothing" bash -c "[ ! -s '$WORK/hook.err' ]"

echo "case 15: an explicit projectDir does NOT inherit the workspace root's .nvmrc"
# `nvm install` with no arguments walks *up* the tree, so without the [ -f .nvmrc ] guard the
# hook would hand nvm a cwd from which it silently finds the root's pin — the option would look
# like it worked while pinning something else entirely. This is the case that makes that guard
# load-bearing rather than belt-and-braces.
setup c15 PROJECTDIR=packages/app
mkdir -p "$WS/packages/app"
echo 18 > "$WS/.nvmrc"
run_hook
check "the hook declines" test "$status" -eq 0
check "saying the project directory has none" \
  grep -qF "no .nvmrc in $WS/packages/app" "$WORK/hook.err"
check "nvm was never reached, so it could not walk up" test ! -s "$NVM_LOG"
check "and nothing was pinned" test ! -e "$PIN"

echo "case 16: PROJECT_PATH is the workspace root, and projectDir resolves under it"
setup c16 PROJECTDIR=packages/app
OTHER="$WORK/c16/other"
mkdir -p "$OTHER/packages/app"
echo 20 > "$OTHER/packages/app/.nvmrc"
run_hook PROJECT_PATH="$OTHER"
check "the variable is preferred over the cwd" test "$(install_cwd)" = "$OTHER/packages/app"

echo "case 17: the declared-volume mismatch warning — projectDir only"
# This Feature's manifest declares a node_modules volume at the workspace root, and a Feature
# option cannot substitute into that Feature's own mounts (declared-volume-spike, M2), so the
# target cannot follow projectDir. The warning is the whole mitigation, which makes "does it
# actually fire, and only then" worth asserting rather than assuming.
setup c17 PROJECTDIR=packages/app
mkdir -p "$WS/packages/app"
echo 20 > "$WS/packages/app/.nvmrc"
run_hook
check "the hook still succeeds" test "$status" -eq 0
check "it warns that the declared volume is at the workspace root" \
  grep -qF 'declares a node_modules volume at the workspace root' "$WORK/hook.err"
check "naming where this project's node_modules actually is" \
  grep -qF "$WS/packages/app/node_modules and is NOT backed by it" "$WORK/hook.err"
check "and giving a mount line targeting the project directory" \
  grep -qF "target=$WS/packages/app/node_modules" "$WORK/hook.err"
check "the mount line keeps \${devcontainerId} unexpanded for the consumer to paste" \
  grep -qF 'source=node-modules-${devcontainerId}' "$WORK/hook.err"

setup c17b
echo 20 > "$WS/.nvmrc"
run_hook
check "with the default projectDir the declaration is correct, so nothing is said" bash -c \
  "! grep -q 'declares a node_modules volume' '$WORK/hook.err'"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
