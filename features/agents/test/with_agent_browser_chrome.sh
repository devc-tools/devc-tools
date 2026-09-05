#!/bin/bash
# Scenario `with_agent_browser_chrome` — installAgentBrowser: true, agentBrowserChrome left at
# its default ("with-deps"), alongside a node Feature.
#
# This is the slowest scenario in the collection by a wide margin: it downloads ~185 MB of
# Chrome for Testing and apt-installs ~36 packages. Run it deliberately, not as a matter of
# course.
#
# Also the one place this Feature answers the "[unverified]" risk the plan flagged rather than
# guessing at it: whether Chrome actually launches in an unprivileged container. `agent-browser
# doctor` (no flags) does a live headless launch, so its exit code settles the question for real
# rather than assuming it.
set -e

source dev-container-features-test-lib

check "agent-browser is on PATH" bash -c "command -v agent-browser"

# install_agent_browser_chrome runs `agent-browser install --with-deps` as root, with HOME
# repointed at the remote user's home — so the download must land there, not in /root, and must
# come out owned by the remote user (the chown that step performs after the install, which is
# safe only there: this directory is created fresh at build time with nothing mounted under it).
check "~/.agent-browser/browsers/chrome-* exists" \
  bash -c "compgen -G \"\$HOME/.agent-browser/browsers/chrome-*\" > /dev/null"
check "and is owned by the remote user, not root" \
  bash -c "[ \"\$(stat -c '%U' \"\$HOME/.agent-browser\")\" = \"\$(id -un)\" ]"

check "agent-browser doctor confirms Chrome offline, without a live launch" \
  bash -c "agent-browser doctor --offline --quick"

# The live check: does the headless launch actually work under this container's default seccomp
# profile? If this fails, the fix (per the plan) is a one-line AGENT_BROWSER_ARGS containerEnv
# entry adding --no-sandbox, not a redesign of this Feature — but that fix does not belong here
# speculatively. This assertion is what tells the next reader whether it is needed at all.
check "agent-browser doctor (live launch) succeeds" bash -c "agent-browser doctor"

# The Claude CLI still installs alongside it — the options are independent.
check "claude is still on PATH too" bash -c "command -v claude"

reportResults
