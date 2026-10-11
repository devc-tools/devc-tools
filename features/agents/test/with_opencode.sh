#!/bin/bash
# Scenario `with_opencode` — installOpencodeCli: true. The default scenario (test.sh) already
# asserts opencode stays absent when the option is left at its default; this is the other half,
# and the only scenario that runs opencode's real installer — which puts the binary in
# ~/.opencode/bin, not ~/.local/bin, and leaves install.sh to link it across.
set -e

source dev-container-features-test-lib

check "opencode is on PATH" bash -c "command -v opencode"
check "opencode is executable by the remote user" test -x "$(command -v opencode)"

# The link is what puts opencode on PATH for a non-interactive shell (the installer's own PATH
# line goes in ~/.bashrc, which only an interactive one sources) and what post-start.sh updates
# through. A link, not a copy: `opencode upgrade` rewrites ~/.opencode/bin/opencode, and a copy
# in ~/.local/bin would stay on the old version.
check "~/.local/bin/opencode is a symlink" test -L "$HOME/.local/bin/opencode"
check "to the installer's own copy in ~/.opencode/bin" \
  test "$(readlink -f "$HOME/.local/bin/opencode")" = "$HOME/.opencode/bin/opencode"
check "opencode runs through the link" "$HOME/.local/bin/opencode" --version

# updateToolsOnStart is at its default true, so the start-time update covers opencode — with its
# own `upgrade` spelling. Exit 0 and one line whether or not the upgrade reaches the network.
SHARE=/usr/local/share/devc-features/agents
check "update-tools.conf lists claude then opencode" \
  bash -c "[ \"\$(cat $SHARE/update-tools.conf)\" = 'claude opencode' ]"
out="$(bash "$SHARE/post-start.sh" 2>&1)"
echo "$out"
check "one agents: line for opencode" \
  bash -c "[ \"\$(printf '%s\n' \"\$1\" | grep -cE '^agents: opencode (updated|up to date|update failed)')\" -eq 1 ]" \
  _ "$out"

# The Claude CLI still installs alongside it — the install options are independent.
check "claude is still on PATH too" bash -c "command -v claude"

reportResults
