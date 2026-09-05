#!/bin/bash
# Exercises the herdr-seed prune+link block from the real post-create.sh against temp dirs, no
# container involved — the same technique devc/tests/seed_link_test.sh uses for the claude-seed
# block, adapted for this one's own fence and its own two variables (HERDR_SEED,
# HERDR_CONFIG_DIR). Kept in this Feature's own test/ rather than devc/tests: unlike
# devc:seed-link, devc:herdr-seed-link has no second copy anywhere else to test against — see
# post-create.sh's own comment on why it is a separate block rather than a shared function.
#
#   bash features/agents/test/herdr_seed_link_test.sh
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/post-create.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

BLOCK="$WORK/block.sh"
awk '/# devc:herdr-seed-link \(start\)/{f=1;next} /# devc:herdr-seed-link \(end\)/{f=0} f' \
  "$SCRIPT" > "$BLOCK"
grep -q 'ln -sfn' "$BLOCK" || { echo "FAIL: could not extract herdr-seed-link block"; exit 1; }

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

run_block() { # run_block <seed dir> <herdr config dir>
  ( sed -e "s#^HERDR_SEED=.*#HERDR_SEED=$1#" -e "s#^HERDR_CONFIG_DIR=.*#HERDR_CONFIG_DIR=$2#" \
      "$BLOCK" > "$WORK/run.sh"
    warn() { :; }
    export -f warn
    bash "$WORK/run.sh" > "$WORK/out.log" 2>&1 ) || {
      echo "  FAIL block exited nonzero"; cat "$WORK/out.log"; fails=$((fails + 1)); }
}

echo "case 1: config.toml linked, a subdirectory in the seed is ignored"
S="$WORK/c1/seed"; H="$WORK/c1/herdr"; mkdir -p "$S/plugins"
printf '[ui]\ntab_bar_right = []\n' > "$S/config.toml"
echo "not a plugin config" > "$S/plugins/inner.toml"
run_block "$S" "$H"
check "config.toml is a symlink into the seed" test "$(readlink "$H/config.toml")" = "$S/config.toml"
check "seed directory NOT linked" test ! -e "$H/plugins"

echo "case 2: removed seed file is pruned on the next run"
rm "$S/config.toml"
run_block "$S" "$H"
check "stale link removed" test ! -e "$H/config.toml"

echo "case 3: non-seed state survives the prune"
S="$WORK/c3/seed"; H="$WORK/c3/herdr"; mkdir -p "$S" "$H/plugins/config"
echo '{"k":1}' > "$H/plugins/config/bridge-keepawake.json"
printf '[ui]\n' > "$S/config.toml"
run_block "$S" "$H"
check "plugin config directory survives" test -d "$H/plugins/config"
check "seed file linked" test -L "$H/config.toml"

echo "case 4: an empty (or absent) seed links nothing and is not an error"
H="$WORK/c4/herdr"
run_block "$WORK/c4/no-such-seed" "$H"
check "the config dir was still created" test -d "$H"
check "nothing was linked" test -z "$(ls -A "$H")"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
