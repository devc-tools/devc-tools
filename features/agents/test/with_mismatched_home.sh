#!/bin/bash
# Scenario `with_mismatched_home` — the case the Feature cannot fix, and must survive.
#
# The volume is declared at the literal /home/vscode/.claude, but this scenario's remote user is
# `root`, so $HOME is /root and the volume lands at a path this user never reads.
#
# That mismatch is a consumer's to fix (declare the mount themselves — see the Feature README).
# What this scenario pins is the failure *mode*: the Feature notices, warns on stderr, and still
# exits 0. A create-time script that aborted here would make the Feature unusable on every image
# whose remote user is not `vscode`, which is the whole reason the check is a warning, not an error.
set -e

source dev-container-features-test-lib

check "this scenario really does have a non-default home" test "$HOME" = /root

# The condition being detected. The warning text itself is deliberately not asserted — it is
# prose, and pinning it would turn every reword into a test failure. That the container exists at
# all is the assertion that matters.
check "~/.claude is NOT backed by the declared volume" \
  bash -c "! mountpoint -q \"$HOME/.claude\""

# Everything below is only reachable if post-create.sh exited 0 despite warning.
check "the create-time step still completed" test -d "$HOME/.claude"
check "~/.claude.json was still folded into the directory" test -L "$HOME/.claude.json"
check "and still reads back a JSON object through the link" \
  bash -c "test -s \"$HOME/.claude.json\" && test \"\$(head -c1 \"$HOME/.claude.json\")\" = '{'"
check "the Claude CLI still installed under this user's home" test -x "$HOME/.local/bin/claude"

reportResults
