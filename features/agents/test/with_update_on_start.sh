#!/bin/bash
# Scenario `with_update_on_start` — installCopilotCli and installHerdr on, updateToolsOnStart at
# its default true. Pins what install.sh hands post-start.sh, and that post-start.sh itself runs
# cleanly against the real CLIs: one line per tool, exit 0 whether or not the update succeeds
# (so this also passes on a runner with no network).
set -e

source dev-container-features-test-lib

SHARE=/usr/local/share/devc-features/agents

check "update-tools.conf lists the three installed CLIs in order" \
  bash -c "[ \"\$(cat $SHARE/update-tools.conf)\" = 'claude copilot herdr' ]"
check "post-start.sh is executable" test -x "$SHARE/post-start.sh"
check "and owned by root" bash -c "[ \"\$(stat -c '%U:%G' $SHARE/post-start.sh)\" = 'root:root' ]"

out="$(bash "$SHARE/post-start.sh" 2>&1)"
echo "$out"
check "post-start.sh exits 0" bash "$SHARE/post-start.sh"
for t in claude copilot herdr; do
  check "one agents: line for $t" \
    bash -c "[ \"\$(printf '%s\n' \"\$1\" | grep -cE '^agents: $t (updated|up to date|update failed)')\" -eq 1 ]" \
    _ "$out"
done

reportResults
