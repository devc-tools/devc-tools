#!/bin/bash
# Scenario `with_seed` — a seed directory already populated before this Feature's
# postCreateCommand runs, standing in for what a real host bind mount would deliver (a bind mount
# is the one thing a Feature cannot declare — see README.md). Written directly into the Feature's
# own fixed seed path by this scenario's own onCreateCommand, the same technique
# git-container-config's mounted_identity scenario uses.
#
# Note what this scenario does NOT pass: any options at all. The seed path is fixed, so mounting
# something onto it is the whole configuration — that is the difference between this scenario and
# the default one.
set -e

source dev-container-features-test-lib

SEED=/usr/local/share/devc-features/agents/claude-seed

check "the seed landed before create" test -f "$SEED/CLAUDE.md"

check "CLAUDE.md is a symlink into the seed" \
  test "$(readlink "$HOME/.claude/CLAUDE.md")" = "$SEED/CLAUDE.md"
check "settings.json is linked too" test -L "$HOME/.claude/settings.json"
check "the seed's skills/ subdirectory is NOT linked" test ! -e "$HOME/.claude/skills"

# Unrelated to the seed — a seeded .claude.json would be a *file* in the seed, and this scenario
# does not put one there. It still lands, because this step is unconditional.
check "~/.claude.json is a symlink" test -L "$HOME/.claude.json"
check "it points inside ~/.claude, not at the seed" \
  test "$(readlink "$HOME/.claude.json")" = "$HOME/.claude/.claude.json"
# Claude Code owns this file's contents and writes real state into it at install time
# (installMethod, firstStartVersion, migrationVersion, a machine id...). Pinning `{}` pinned a
# value that belonged to an external tool, and it went stale the moment the CLI started
# seeding itself. What this Feature is responsible for is the *fold* — that the path is a link
# into the volume (asserted above) and that reading through it yields a JSON object.
check "it reads back a JSON object" \
  bash -c "test -s \"$HOME/.claude.json\" && test \"\$(head -c1 \"$HOME/.claude.json\")\" = '{'"

reportResults
