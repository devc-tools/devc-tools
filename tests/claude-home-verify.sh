#!/bin/bash
# Manual verification driver for the ~/.claude home/seed work (agents 0.5.0 and 0.6.0).
#
#   bash tests/claude-home-verify.sh scenarios   # Feature scenarios via the test harness
#   bash tests/claude-home-verify.sh row1        # bind by default, no seed   (+ skills ownership)
#   bash tests/claude-home-verify.sh row2        # bind + claudeSeed: true
#   bash tests/claude-home-verify.sh row3        # volume replaces the bind
#   bash tests/claude-home-verify.sh row4        # volume + claudeSeed: true
#   bash tests/claude-home-verify.sh upgrade     # 0.4.1 -> local: no dangling seed links
#   bash tests/claude-home-verify.sh all         # every one of the above, in order
#   bash tests/claude-home-verify.sh clean       # remove containers, volume and scratch dirs
#
# Needs Docker and a network. Everything it touches is throwaway: the host side lives under
# $CLAUDE_HOME_VERIFY_DIR (default ~/devc-claude-test) and the project under /tmp. It never
# touches your real ~/.config/devc/.claude — deliberately, since row2 exists to prove the seed
# will not overwrite a real file, and proving that against your own config is not a test worth
# running.
#
# The Feature is copied from this working tree into the scratch project as a *local* Feature
# (`"./agents"`), the same shape tests/fixtures/mount-substitution uses, so nothing has to be
# published to ghcr.io first. `upgrade` is the one case that pulls a published version, because
# its whole point is coming from an older one.
set -uo pipefail

HOST_DIR="${CLAUDE_HOME_VERIFY_DIR:-$HOME/devc-claude-test}"
PROJECT="${CLAUDE_HOME_VERIFY_PROJECT:-/tmp/claude-home-test}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
VOLUME=claude-home-verify
TARGET=/home/vscode/.claude
SEED_TARGET=/usr/local/share/devc-features/agents/claude-seed

# --- the devcontainer CLI, same four rungs as each Feature's own test/run-features-test.sh -----
# Resolved lazily: `clean` drives docker directly and the usage text needs nothing at all, so
# neither should be blocked by a missing CLI.
CLI=()
resolve_cli() {
  if [ -n "${DEVCONTAINER_CLI:-}" ]; then
    read -r -a CLI <<< "$DEVCONTAINER_CLI"
  elif command -v devcontainer > /dev/null 2>&1; then
    CLI=(devcontainer)
  elif [ -n "${DEVC_BIN:-}" ]; then
    read -r -a CLI <<< "$DEVC_BIN"
    CLI+=(__devcontainer)
  elif command -v devc > /dev/null 2>&1; then
    CLI=(devc __devcontainer)
  else
    echo "no devcontainer CLI found. Any one of these fixes it:" >&2
    echo "  - source scripts/bash_aliases.sh — exports \$DEVC_BIN, runs devc from source" >&2
    echo "  - install devc, or npm install --global @devcontainers/cli" >&2
    echo "  - set DEVCONTAINER_CLI (may be multi-word)" >&2
    exit 1
  fi
}

pass=0
fail=0
check() { # check <description> <command...>
  local what="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    printf '  \033[32mPASS\033[0m  %s\n' "$what"
    pass=$((pass + 1))
  else
    printf '  \033[31mFAIL\033[0m  %s\n' "$what"
    fail=$((fail + 1))
  fi
}
banner() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }
note() { printf '  ...   %s\n' "$1"; }

inc() { "${CLI[@]}" exec --workspace-folder "$PROJECT" bash -lc "$1"; }

# Write the scratch project. $1 = the features object, $2 = the ~/.claude mount line.
write_project() {
  mkdir -p "$PROJECT/.devcontainer"
  rm -rf "$PROJECT/.devcontainer/agents"
  cp -R "$REPO/features/agents" "$PROJECT/.devcontainer/agents"
  rm -rf "$PROJECT/.devcontainer/agents/test"
  cat > "$PROJECT/.devcontainer/devcontainer.json" << EOF
{
  "name": "claude-home-verify",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": $1,
  "mounts": [
    "$2",
    "type=bind,source=$HOST_DIR/claude-seed,target=$SEED_TARGET,consistency=cached,readonly",
    "type=bind,source=$HOST_DIR/skills/probe,target=$TARGET/skills/probe"
  ]
}
EOF
}

BIND_MOUNT="type=bind,source=$HOST_DIR/claude,target=$TARGET,consistency=cached"
VOLUME_MOUNT="type=volume,source=$VOLUME,target=$TARGET"

# `--remove-existing-container` so every row is a real rebuild rather than a reattach — without
# it a row's option change would silently not take effect and the row would test the row before.
#
# The container id comes from `up`'s own JSON rather than from a
# `--filter label=devcontainer.local_folder=$PROJECT` lookup: on macOS /tmp is a symlink to
# /private/tmp, so the label holds the resolved path and a filter on $PROJECT matches nothing.
CONTAINER_ID=""
up() {
  local out
  out="$("${CLI[@]}" up --workspace-folder "$PROJECT" --remove-existing-container 2> /dev/null)" ||
    return 1
  CONTAINER_ID="$(printf '%s' "$out" | grep -o '"containerId":"[^"]*"' | head -1 | cut -d'"' -f4)"
  [ -n "$CONTAINER_ID" ]
}

host_owner() { ls -ld "$1" 2> /dev/null | awk '{print $3}'; }

ensure_host_dirs() { mkdir -p "$HOST_DIR/claude" "$HOST_DIR/claude-seed" "$HOST_DIR/skills/probe"; }

# --- the rows ----------------------------------------------------------------------------------

do_scenarios() {
  banner "Feature scenarios (harness)"
  local w="$REPO/features/agents/test/run-features-test.sh"
  # with_agent_browser_chrome is deliberately not run: Chrome for Testing publishes no Linux
  # ARM64 build, so it fails on Apple Silicon for reasons that predate this work.
  check "bare {} (autogenerated test.sh)" bash "$w" --skip-scenarios
  check "with_declared_volume" bash "$w" --skip-autogenerated --filter with_declared_volume
  check "with_mismatched_home" bash "$w" --skip-autogenerated --filter with_mismatched_home
  check "with_seed + with_seed_disabled" bash "$w" --skip-autogenerated --filter with_seed
}

do_row1() {
  banner "Row 1 — bind by default, no seed"
  ensure_host_dirs
  rm -f "$HOST_DIR/claude"/* 2> /dev/null
  echo '# written on the host' > "$HOST_DIR/claude/CLAUDE.md"
  write_project '{ "./agents": {} }' "$BIND_MOUNT"
  if ! up; then
    echo "  devcontainer up FAILED — rerun by hand to see why:" >&2
    echo "    ${CLI[*]} up --workspace-folder $PROJECT" >&2
    fail=$((fail + 1))
    return
  fi
  # The pipe runs inside the container, so `check` only ever invokes `inc` — no subshell that
  # would have to re-find a shell function.
  check "~/.claude is the host bind, not a volume" \
    inc "findmnt -no SOURCE $TARGET | grep -qv /docker/volumes"
  check "no seed symlinks in ~/.claude" inc "[ -z \"\$(find $TARGET -maxdepth 1 -type l)\" ]"
  check "CLAUDE_CONFIG_DIR is $TARGET" inc "[ \"\$CLAUDE_CONFIG_DIR\" = $TARGET ]"
  check "no sibling ~/.claude.json" inc '[ ! -e "$HOME/.claude.json" ]'
  check "~/.claude is writable by the remote user" inc "touch $TARGET/.probe && rm $TARGET/.probe"
  check "a host-written CLAUDE.md is readable in the container" \
    inc "grep -q 'written on the host' $TARGET/CLAUDE.md"
  check "a container-written file lands on the host" inc "echo container > $TARGET/FROM-CONTAINER"
  check "  ...and is visible there" test -f "$HOST_DIR/claude/FROM-CONTAINER"

  banner "Row 1 — nested skills mountpoint ownership (the unmeasured one)"
  # Two directories, not one. Docker creates BOTH `skills/` and `skills/probe/` inside the bind
  # to hold the nested mount, and they can differ: the leaf came out owned by the user while the
  # intermediate did not, which surfaced only as `clean` failing with EACCES — removing the leaf
  # needs write permission on its parent, not on itself.
  local me leaf mid
  me="$(id -un)"
  mid="$(host_owner "$HOST_DIR/claude/skills")"
  leaf="$(host_owner "$HOST_DIR/claude/skills/probe")"
  note "host owner of claude/skills:       ${mid:-<missing>} (you are $me)"
  note "host owner of claude/skills/probe: ${leaf:-<missing>}"
  check "the skills mountpoint is owned by you, not root" test "$leaf" = "$me"
  check "its parent skills/ is too — else you cannot remove it without sudo" test "$mid" = "$me"
  check "  ...and the parent is writable, so cleanup needs no sudo" test -w "$HOST_DIR/claude/skills"
}

do_row2() {
  banner "Row 2 — bind + claudeSeed: true"
  ensure_host_dirs
  echo '# from the seed' > "$HOST_DIR/claude-seed/SEED-ONLY.md"
  rm -f "$HOST_DIR/claude/SEED-ONLY.md"
  write_project '{ "./agents": { "claudeSeed": true } }' "$BIND_MOUNT"
  up || { echo "  up failed" >&2; fail=$((fail + 1)); return; }
  check "a seed-only name is linked into ~/.claude" inc "[ -L $TARGET/SEED-ONLY.md ]"
  check "  ...and reads through to the seed" inc "grep -q 'from the seed' $TARGET/SEED-ONLY.md"

  banner "Row 2 — never-overwrite (the data-loss guard)"
  # Replace the link with a real host file of the same name, then rebuild: the seed must skip it
  # and leave the host file exactly as it is.
  rm -f "$HOST_DIR/claude/SEED-ONLY.md"
  echo 'mine' > "$HOST_DIR/claude/SEED-ONLY.md"
  up || { echo "  up failed" >&2; fail=$((fail + 1)); return; }
  check "a real host file of the same name is NOT replaced" \
    test "$(cat "$HOST_DIR/claude/SEED-ONLY.md")" = mine
  check "  ...and is still a regular file, not a symlink" test ! -L "$HOST_DIR/claude/SEED-ONLY.md"
}

do_row3() {
  banner "Row 3 — a volume at the same target replaces the bind"
  ensure_host_dirs
  write_project '{ "./agents": {} }' "$VOLUME_MOUNT"
  up || { echo "  up failed" >&2; fail=$((fail + 1)); return; }
  check "~/.claude is the volume, not the host bind" \
    inc "findmnt -no SOURCE $TARGET | grep -q volumes"
  local n
  n="$(docker inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' \
    "$CONTAINER_ID" 2> /dev/null | grep -c "^$TARGET\$")"
  note "mounts targeting exactly $TARGET: ${n:-?} (expect 1)"
  check "exactly one mount reaches Docker for that target" test "$n" = 1
}

do_row4() {
  banner "Row 4 — volume + claudeSeed: true (today's shape)"
  ensure_host_dirs
  echo '# from the seed' > "$HOST_DIR/claude-seed/SEED-ONLY.md"
  write_project '{ "./agents": { "claudeSeed": true } }' "$VOLUME_MOUNT"
  up || { echo "  up failed" >&2; fail=$((fail + 1)); return; }
  check "seed files are linked into the volume" inc "[ -L $TARGET/SEED-ONLY.md ]"
  check "CLAUDE_CONFIG_DIR still points at $TARGET" inc "[ \"\$CLAUDE_CONFIG_DIR\" = $TARGET ]"
}

do_upgrade() {
  banner "Upgrade — published 0.4.1, then this working tree"
  ensure_host_dirs
  echo '# from the seed' > "$HOST_DIR/claude-seed/SEED-ONLY.md"
  rm -f "$HOST_DIR/claude/SEED-ONLY.md"
  # 0.4.1 seeds unconditionally and has no claudeSeed option, so `{}` is the only valid form.
  write_project '{ "ghcr.io/devc-tools/features/agents:0.4.1": {} }' "$BIND_MOUNT"
  up || { echo "  up on 0.4.1 failed" >&2; fail=$((fail + 1)); return; }
  check "0.4.1 left a seed symlink in the host dir" test -L "$HOST_DIR/claude/SEED-ONLY.md"

  write_project '{ "./agents": {} }' "$BIND_MOUNT"
  up || { echo "  up on the local Feature failed" >&2; fail=$((fail + 1)); return; }
  check "the stale seed symlink is GONE, not dangling" test ! -e "$HOST_DIR/claude/SEED-ONLY.md"
  check "no dangling symlink of any name remains in ~/.claude" \
    inc "[ -z \"\$(find $TARGET -maxdepth 1 -xtype l)\" ]"
  check "  ...nor on the host" \
    bash -c "[ -z \"\$(find '$HOST_DIR/claude' -maxdepth 1 -type l 2>/dev/null)\" ]"
}

do_clean() {
  banner "clean"
  # Both spellings of the project path — see up() on macOS /tmp vs /private/tmp.
  local real ids
  real="$(cd "$PROJECT" 2> /dev/null && pwd -P)"
  ids="$(docker ps -aq \
    --filter "label=devcontainer.local_folder=$PROJECT" \
    --filter "label=devcontainer.local_folder=${real:-$PROJECT}" 2> /dev/null | sort -u)"
  [ -n "$ids" ] && docker rm -f $ids > /dev/null 2>&1
  docker volume rm "$VOLUME" > /dev/null 2>&1
  rm -rf "$PROJECT" 2> /dev/null
  # Reported honestly rather than assumed: Docker creates the nested skills mountpoint
  # directories inside the bind, and if it owns one of them this rm fails with EACCES. Claiming
  # success there leaves the next run reusing dirt it was told had been removed.
  if rm -rf "$HOST_DIR" 2> /dev/null && [ ! -e "$HOST_DIR" ]; then
    echo "  removed containers, the $VOLUME volume, $PROJECT and $HOST_DIR"
  else
    echo "  removed containers, the $VOLUME volume and $PROJECT"
    echo "  COULD NOT remove $HOST_DIR — Docker owns a directory in it:" >&2
    ls -ld "$HOST_DIR"/claude/skills* 2> /dev/null >&2
    echo "    sudo rm -rf $HOST_DIR" >&2
    return 1
  fi
}

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

# Validate the command name first, then resolve the CLI — otherwise a typo reports a missing
# devcontainer CLI, which is true but not the problem.
case "${1:-}" in
  -h | --help | help | '') usage; exit 0 ;;
  clean) ;;
  scenarios | row1 | row2 | row3 | row4 | upgrade | all) resolve_cli ;;
  *)
    echo "unknown command: $1" >&2
    usage >&2
    exit 1
    ;;
esac

case "${1:-}" in
  scenarios) do_scenarios ;;
  row1) do_row1 ;;
  row2) do_row2 ;;
  row3) do_row3 ;;
  row4) do_row4 ;;
  upgrade) do_upgrade ;;
  all) do_scenarios; do_row1; do_row2; do_row3; do_row4; do_upgrade ;;
  clean) do_clean; exit $? ;;
esac

banner "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
