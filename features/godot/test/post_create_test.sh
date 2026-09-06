#!/bin/bash
# post-create.sh — the .godot chown when projectDir is empty, the warn-with-mount-line when it
# isn't, and both being no-ops when there is no .godot to act on.
#
#   bash features/godot/test/post_create_test.sh
#
# Offline: the real install.sh installs the real post-create.sh into a temp SHARE_DIR (with
# curl/apt-get/unzip never reached — VERSION is pinned and GODOT_LINK/SHARE_DIR point at temp
# paths, but the actual download would still hit the network, so this harness bakes the hook
# directly rather than running install.sh's download path — see setup() below), then the
# installed hook runs against a temp workspace with `sudo` stubbed so the chown is observable
# without root.
set -uo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

BIN="$WORK/bin"
mkdir -p "$BIN"
cat > "$BIN/sudo" << 'SUDO'
#!/bin/sh
echo "cwd=$PWD args=$*" >> "$SUDO_LOG"
SUDO
chmod +x "$BIN/sudo"

# A PATH with no `sudo` on it at all, built from real binaries by name rather than by directory
# — the real sudo very likely shares a directory with the coreutils the hook also needs, so
# excluding a directory would take those with it (and env's own PATH-based lookup of the "sh"
# to exec would fail outright with anything less targeted).
NOSUDO="$WORK/nosudo-path"
mkdir -p "$NOSUDO"
for tool in sh id chown mkdir dirname cat pwd env true false; do
  p="$(command -v "$tool" 2> /dev/null)" || continue
  ln -sf "$p" "$NOSUDO/$tool"
done

# setup <name> [PROJECTDIR=... FIXGODOTDIROWNERSHIP=...] — a temp SHARE_DIR carrying
# post-create.sh baked exactly the way install.sh's own bake() would, and a temp workspace.
# Baked directly (a copy + sed-free rewrite matching install.sh's own bake format) rather than
# by running the real install.sh end to end, since that would also need a real Godot release to
# download — this Feature has no build-time/create-time split for the *download*, only for the
# chown/warn logic post-create.sh itself owns, which is all this harness needs to exercise.
setup() {
  local name="$1"; shift
  local project_dir='' fix='true' kv k v
  for kv in "$@"; do
    k="${kv%%=*}"; v="${kv#*=}"
    case "$k" in
      PROJECTDIR) project_dir="$v" ;;
      FIXGODOTDIROWNERSHIP) fix="$v" ;;
    esac
  done
  SHARE="$WORK/$name/share"; WS="$WORK/$name/ws"; SUDO_LOG="$WORK/$name/sudo.log"
  rm -rf "${WORK:?}/$name"
  mkdir -p "$SHARE" "$WS"
  : > "$SUDO_LOG"
  cp "$FEATURE_DIR/post-create.sh" "$SHARE/post-create.sh"
  # The same two-line rewrite install.sh's bake() performs, verified against the real
  # install.sh's own behavior in install_options_test.sh — this harness only needs the result.
  sed -i \
    -e "s|^PROJECT_DIR=.*|PROJECT_DIR=\"$project_dir\"|" \
    -e "s|^FIX_GODOT_DIR_OWNERSHIP=.*|FIX_GODOT_DIR_OWNERSHIP=\"$fix\"|" \
    "$SHARE/post-create.sh"
  chmod 0755 "$SHARE/post-create.sh"
  HOOK="$SHARE/post-create.sh"
}

# run_hook [ENV=val ...] — the hook as the CLI runs it: as the remote user, with the workspace
# folder as its cwd. PROJECT_PATH is unset unless a case sets it, matching node-nvmrc's own
# harness reasoning: this harness runs inside a devcontainer that has one, and inheriting it
# would make every case an override case.
run_hook() {
  ( cd "$WS" && env -u PROJECT_PATH PATH="$BIN:$PATH" SUDO_LOG="$SUDO_LOG" "$@" sh "$HOOK" ) \
    > "$WORK/hook.out" 2> "$WORK/hook.err"
  status=$?
}

echo "case 1: projectDir empty, .godot exists — the chown fires"
setup c1
mkdir -p "$WS/.godot"
run_hook
check "the hook succeeds" test "$status" -eq 0
check "it says nothing" bash -c "[ ! -s '$WORK/hook.out' ] && [ ! -s '$WORK/hook.err' ]"
check "sudo was called once" test "$(wc -l < "$SUDO_LOG")" -eq 1
check "from the workspace" grep -qF "cwd=$WS " "$SUDO_LOG"
check "on ./.godot, recursively, non-interactively" grep -qF -- '-n chown -R' "$SUDO_LOG"
check "targeting ./.godot specifically" grep -qF './.godot' "$SUDO_LOG"
check "and never the workspace itself" bash -c "! grep -qF ' $WS\$' '$SUDO_LOG'"

echo "case 2: projectDir empty, no .godot — no-op, no sudo call"
setup c2
run_hook
check "the hook succeeds" test "$status" -eq 0
check "silently" bash -c "[ ! -s '$WORK/hook.out' ] && [ ! -s '$WORK/hook.err' ]"
check "sudo was never called" test ! -s "$SUDO_LOG"

echo "case 3: fixGodotDirOwnership false — no-op even when .godot exists"
setup c3 FIXGODOTDIROWNERSHIP=false
mkdir -p "$WS/.godot"
run_hook
check "the hook succeeds" test "$status" -eq 0
check "sudo was never called" test ! -s "$SUDO_LOG"

echo "case 4: no sudo on PATH — best-effort, never fails the create"
setup c4
mkdir -p "$WS/.godot"
run_hook PATH="$NOSUDO"
check "the hook still succeeds" test "$status" -eq 0

echo "case 5: projectDir set — warns instead of chowning, and gives the mount line"
setup c5 PROJECTDIR=games/app
mkdir -p "$WS/.godot"
run_hook
check "the hook succeeds" test "$status" -eq 0
check "it warns the declared volume cannot follow projectDir" \
  grep -qF "projectDir is set to 'games/app'" "$WORK/hook.err"
check "and gives the exact mount line to paste" \
  grep -qF 'target=${containerWorkspaceFolder}/games/app/.godot' "$WORK/hook.err"
check "keeping \${devcontainerId} unexpanded for the consumer to paste" \
  grep -qF 'source=godot-project-cache-${devcontainerId}' "$WORK/hook.err"
check "and no chown was attempted" test ! -s "$SUDO_LOG"

echo "case 6: projectDir set but no .godot at the workspace root — still warns"
# The warning is about the declared volume's target, not about whether anything is there to
# chown — it fires regardless, since the whole point is telling the consumer the mount is wrong.
setup c6 PROJECTDIR=games/app
run_hook
check "the hook succeeds" test "$status" -eq 0
check "it still warns" grep -qF "projectDir is set to 'games/app'" "$WORK/hook.err"
check "and still made no chown attempt" test ! -s "$SUDO_LOG"

echo "case 7: PROJECT_PATH is preferred over the caller's cwd"
setup c7
OTHER="$WORK/c7/other"
mkdir -p "$OTHER/.godot"
run_hook PROJECT_PATH="$OTHER"
check "the hook succeeds" test "$status" -eq 0
check "sudo ran from PROJECT_PATH, not the caller's cwd" grep -qF "cwd=$OTHER " "$SUDO_LOG"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
