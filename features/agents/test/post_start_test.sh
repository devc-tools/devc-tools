#!/bin/bash
# agents offline harness — the real post-start.sh, run against a fake $HOME with stub agent CLIs
# in ~/.local/bin and a temp update-tools.conf. No container, no network:
#
#   bash features/agents/test/post_start_test.sh
#
# Each stub reports a version (`<name> v<N>`) from a per-case state file, records every `update`
# call, and can be told to bump its version, exit non-zero, or both. What this cannot cover: that
# the real `claude`/`copilot`/`pi`/`herdr update` commands work unattended, and that
# `devcontainer up` waits for postStartCommand — both need a real container (see the plan's
# Validation and test/scenarios.json's with_update_on_start).
set -uo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$FEATURE_DIR/post-start.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

# setup <case> <conf contents|-> [tool...] — fresh HOME with a stub for each named tool. A conf
# of "-" means no update-tools.conf at all.
setup() {
  local name="$1" conf="$2"; shift 2
  CASE="$WORK/$name"
  H="$CASE/home"
  mkdir -p "$H/.local/bin" "$CASE/state"
  CALLS="$CASE/calls.log"; : > "$CALLS"
  CONF="$CASE/update-tools.conf"
  [ "$conf" = - ] || printf '%s' "$conf" > "$CONF"
  local t
  for t in "$@"; do
    echo 1 > "$CASE/state/$t.ver"
    cat > "$H/.local/bin/$t" << STUB
#!/bin/bash
state="$CASE/state/$t"
if [ "\${1:-}" = --version ]; then echo "$t v\$(cat "\$state.ver")"; exit 0; fi
echo "$t \$*" >> "$CALLS"
[ -e "\$state.bump" ] && echo \$((\$(cat "\$state.ver") + 1)) > "\$state.ver"
exit "\$(cat "\$state.exit" 2> /dev/null || echo 0)"
STUB
    chmod +x "$H/.local/bin/$t"
  done
}

run() { # run [VAR=value ...] — the real script, against this case's HOME and conf
  ( env HOME="$H" UPDATE_TOOLS_CONF="$CONF" "$@" bash "$SCRIPT" > "$CASE/out.log" 2>&1 )
  status=$?
}

out_has() { grep -qxF "$1" "$CASE/out.log"; }

echo "case 1: no update-tools.conf — nothing to update, no stub called"
setup c1 - claude
run
check "exits 0" test "$status" -eq 0
check "prints the nothing-to-update line" \
  out_has "agents: updateToolsOnStart is off or no agent CLI is installed — nothing to update"
check "no stub was called" test ! -s "$CALLS"

echo "case 2: claude's version changes — reported as updated"
setup c2 claude claude
touch "$CASE/state/claude.bump"
run
check "exits 0" test "$status" -eq 0
check "prints before → after" out_has "agents: claude updated: claude v1 → claude v2"
check "the stub saw argv 'update' and nothing else" test "$(cat "$CALLS")" = "claude update"
check "its output went to the per-tool log" test -f "$H/.cache/devc-agents/update-claude.log"

echo "case 3: claude's version does not change — reported as up to date"
setup c3 claude claude
run
check "exits 0" test "$status" -eq 0
check "prints up to date" out_has "agents: claude up to date: claude v1"

echo "case 4: claude update exits 3 — reported, start not failed, next tool still runs"
setup c4 "claude copilot" claude copilot
echo 3 > "$CASE/state/claude.exit"
run
check "exits 0" test "$status" -eq 0
check "prints the failure with its exit code" \
  out_has "agents: claude update failed (exit 3) — see ~/.cache/devc-agents/update-claude.log"
check "copilot still ran" grep -qxF "copilot update" "$CALLS"

echo "case 5: conf lists copilot but no binary exists — skipped"
setup c5 copilot
run
check "exits 0" test "$status" -eq 0
check "prints the not-found line" \
  out_has "agents: copilot not found at ~/.local/bin/copilot — skipping update"

echo "case 6: all four tools — updated in the conf's order"
setup c6 "claude copilot pi herdr" claude copilot pi herdr
# pi needs node; give it a stub so the case does not depend on this machine's toolchain.
mkdir -p "$CASE/nodebin"
printf '#!/bin/sh\nexit 0\n' > "$CASE/nodebin/node"
chmod +x "$CASE/nodebin/node"
run PATH="$CASE/nodebin:$PATH"
check "exits 0" test "$status" -eq 0
check "calls ran claude, copilot, pi, herdr in that order" \
  test "$(cut -d' ' -f1 "$CALLS" | paste -sd' ')" = "claude copilot pi herdr"
check "pi was called with no target (pi alone, not its packages)" grep -qxF "pi update" "$CALLS"

echo "case 7: herdr is updated without --handoff"
setup c7 herdr herdr
run
check "exits 0" test "$status" -eq 0
check "herdr saw exactly 'update'" test "$(cat "$CALLS")" = "herdr update"

echo "case 8: each update is capped at 120 seconds"
setup c8 claude claude
mkdir -p "$CASE/tbin"
cat > "$CASE/tbin/timeout" << STUB
#!/bin/sh
echo "\$1" >> "$CASE/timeout.log"
shift
exec "\$@"
STUB
chmod +x "$CASE/tbin/timeout"
run PATH="$CASE/tbin:$PATH"
check "exits 0" test "$status" -eq 0
check "timeout was invoked with 120" test "$(cat "$CASE/timeout.log" 2> /dev/null)" = 120
check "and claude still ran through it" test "$(cat "$CALLS")" = "claude update"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
