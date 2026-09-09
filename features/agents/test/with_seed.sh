#!/bin/bash
# Scenario `with_seed` — a seed directory already populated before this Feature's
# postCreateCommand runs, standing in for what a real host bind mount would deliver (a bind mount
# is the one thing a Feature cannot declare — see README.md). Written directly into the Feature's
# own fixed seed path by this scenario's own onCreateCommand, the same technique
# git-container-config's mounted_identity scenario uses.
#
# The one option it passes is `"claudeSeed": true`. The seed is opt-in as of 0.6.0 — the path
# itself is still fixed, so mounting something onto it plus turning the flag on is the whole
# configuration. The paired `with_seed_disabled` scenario mounts the same seed with the flag left
# at its default and asserts the exact opposite.
set -e

source dev-container-features-test-lib

SEED=/usr/local/share/devc-features/agents/claude-seed

check "the seed landed before create" test -f "$SEED/CLAUDE.md"

check "CLAUDE.md is a symlink into the seed" \
  test "$(readlink "$HOME/.claude/CLAUDE.md")" = "$SEED/CLAUDE.md"
check "settings.json is linked too" test -L "$HOME/.claude/settings.json"
check "the seed's skills/ subdirectory is NOT linked" test ! -e "$HOME/.claude/skills"

# Unrelated to the seed. As of 0.5.0 the manifest's containerEnv points CLAUDE_CONFIG_DIR at the
# volume's own target, so Claude Code writes .claude.json inside ~/.claude as a real file and
# there is no fold and no symlink left anywhere. Claude Code owns the file's contents (installMethod,
# firstStartVersion, migrationVersion, a machine id...), so what is asserted is the shape, not a value.
check "~/.claude/.claude.json is a regular file, not a symlink" \
  bash -c "test -f \"$HOME/.claude/.claude.json\" && test ! -L \"$HOME/.claude/.claude.json\""
check "nothing was left beside it at ~/.claude.json" test ! -e "$HOME/.claude.json"
check "it reads back a JSON object" \
  bash -c "test -s \"$HOME/.claude/.claude.json\" && test \"\$(head -c1 \"$HOME/.claude/.claude.json\")\" = '{'"

# The never-overwrite rule: .claude.json is skipped by name, so even a seed that carried one
# could not shadow the file Claude Code owns.
check "the seed did not shadow .claude.json" \
  bash -c "test ! -L \"$HOME/.claude/.claude.json\""

reportResults
