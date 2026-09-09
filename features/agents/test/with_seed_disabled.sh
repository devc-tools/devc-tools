#!/bin/bash
# Scenario `with_seed_disabled` — the same populated seed as `with_seed`, and `"agents": {}`.
#
# This is what proves the default. `claudeSeed` defaults false, so a seed with files in it must
# produce NO symlinks in ~/.claude. Every other bare scenario has an *empty* seed and would pass
# whichever way the default went, which is exactly why this one exists: it is the only scenario
# where "the option is off" and "there is nothing to link" are different statements.
set -e

source dev-container-features-test-lib

SHARE=/usr/local/share/devc-features/agents
SEED="$SHARE/claude-seed"

check "the seed really was populated before create" test -f "$SEED/CLAUDE.md"
check "and had a second file too" test -f "$SEED/settings.json"

# install.sh writes claude-seed.conf only for claudeSeed: true, and rm -f's it otherwise.
check "no claude-seed.conf was baked — claudeSeed defaults false" test ! -e "$SHARE/claude-seed.conf"

check "CLAUDE.md was NOT linked into ~/.claude" test ! -e "$HOME/.claude/CLAUDE.md"
check "settings.json was NOT linked either" test ! -e "$HOME/.claude/settings.json"
check "nothing at all was linked into ~/.claude" bash -c \
  "[ -z \"\$(find \"$HOME/.claude\" -mindepth 1 -maxdepth 1 -type l)\" ]"
check "and nothing dangles there" bash -c \
  "[ -z \"\$(find \"$HOME/.claude\" -mindepth 1 -maxdepth 1 -xtype l)\" ]"

# The rest of the create step is unaffected by the flag — the herdr half is unconditional, and
# ~/.claude itself is still the Feature's declared volume.
check "~/.claude exists and is owned by the remote user" bash -c \
  "test -d \"$HOME/.claude\" && [ \"\$(stat -c '%U' $HOME/.claude)\" = \"\$(id -un)\" ]"
check "~/.config/herdr was still created — the herdr seed stays unconditional" \
  test -d "$HOME/.config/herdr"
check "~/.claude/.claude.json is a regular file, not a symlink" \
  bash -c "test -f \"$HOME/.claude/.claude.json\" && test ! -L \"$HOME/.claude/.claude.json\""

reportResults
