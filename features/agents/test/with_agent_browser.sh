#!/bin/bash
# Scenario `with_agent_browser` — installAgentBrowser: true, agentBrowserChrome: "none",
# alongside a node Feature. The default scenario (test.sh) already asserts agent-browser stays
# absent when the option is left at its default; this is the other half, and — with
# agentBrowserChrome pinned to "none" — isolates the CLI install from the Chrome download, which
# `with_agent_browser_chrome` covers separately.
set -e

source dev-container-features-test-lib

check "agent-browser is on PATH" bash -c "command -v agent-browser"
check "agent-browser is executable by the remote user" test -x "$(command -v agent-browser)"
check "agent-browser landed in ~/.local/bin" test -x "$HOME/.local/bin/agent-browser"
check "and that is the agent-browser the remote user's PATH resolves" \
  test "$(command -v agent-browser)" = "$HOME/.local/bin/agent-browser"
check "agent-browser --version succeeds" bash -c "agent-browser --version"

# postinstall.js replaces npm's own bin symlink with a direct symlink to the native Rust binary
# bundled in the npm tarball — this is the whole reason agent-browser does not have pi's .nvmrc
# problem (see the README's "Why agent-browser does not have pi's .nvmrc problem"): what is on
# PATH is a native binary, not a `#!/usr/bin/env node` script, so the container's active node
# version does not affect running it.
check "~/.local/bin/agent-browser is a symlink" test -L "$HOME/.local/bin/agent-browser"
check "pointing into agent-browser's own lib/node_modules/agent-browser/bin/, not a JS wrapper" \
  bash -c "readlink \"\$HOME/.local/bin/agent-browser\" | grep -q 'lib/node_modules/agent-browser/bin/'"

# agentBrowserChrome: "none" — no browser download at all.
check "~/.agent-browser does not exist — agentBrowserChrome is \"none\"" \
  test ! -e "$HOME/.agent-browser"

# The Claude CLI still installs alongside it — installAgentBrowser does not turn
# installClaudeCli off, the options are independent.
check "claude is still on PATH too" bash -c "command -v claude"

reportResults
