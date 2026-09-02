#!/bin/bash
# `devcontainer features test` default scenario — runs INSIDE a container built from this
# Feature with **no options** (`"agents": {}`).
#
# That combination is the bare-`{}` case every Feature in this collection has to survive (see
# .plans/design/devc-feature-split.md): the Claude CLI installs, the seed directory exists and is
# empty so nothing is linked, ~/.claude.json is folded into ~/.claude, and Copilot/pi/Herdr are
# absent with no pi packages or Herdr plugins installed (installCopilotCli/installPiCli/
# installHerdr default false, piPackages/herdrPlugins default empty).
#
# There are no path options to pass — the seed scenario in scenarios.json differs from this one
# only by what its onCreateCommand writes into the seed, not by configuration.
set -e

source dev-container-features-test-lib

SHARE=/usr/local/share/devc-features/agents

check "create-time script is installed" test -f "$SHARE/post-create.sh"
check "and is executable" test -x "$SHARE/post-create.sh"
check "and is owned by root" bash -c \
  "[ \"\$(stat -c '%U:%G' $SHARE/post-create.sh)\" = 'root:root' ]"

# --- the seed directory is this Feature's published surface ----------------------------------
# install.sh creates it empty at build time so a consumer has something to bind-mount onto, and
# so the bare `{}` case is an empty seed rather than a missing path.
check "the seed directory exists" test -d "$SHARE/claude-seed"
check "and is empty — nothing was mounted onto it" bash -c \
  "[ -z \"\$(ls -A $SHARE/claude-seed)\" ]"

# --- the Claude CLI ------------------------------------------------------------------------
check "claude is on PATH" bash -c "command -v claude"
check "claude is executable by the remote user" test -x "$(command -v claude)"

# --- Copilot, pi and Herdr stay absent — their install options all default false -------------
check "copilot is NOT on PATH" bash -c "! command -v copilot"
check "pi is NOT on PATH" bash -c "! command -v pi"
check "herdr is NOT on PATH" bash -c "! command -v herdr"

# --- piPackages/herdrPlugins stay empty by default — the assertion that catches a default
# flipping and silently installing something nobody asked for --------------------------------
check "~/.pi/agent/settings.json does not exist — no piPackages entry was ever installed" \
  test ! -e "$HOME/.pi/agent/settings.json"
check "no herdr plugin config dir exists — no herdrPlugins entry was ever installed" \
  test ! -d "$HOME/.config/herdr/plugins"

# --- ~/.claude ownership ---------------------------------------------------------------------
# install.sh pre-creates it owned by the remote user at build time; post-create.sh's belt-and-
# braces chown is a no-op here either way.
check "~/.claude exists" test -d "$HOME/.claude"
check "and is owned by the remote user" bash -c \
  "[ \"\$(stat -c '%U' $HOME/.claude)\" = \"\$(id -un)\" ]"

# --- nothing linked out of an empty seed ------------------------------------------------------
check "the seed was empty, so ~/.claude has nothing linked into it" bash -c \
  "[ -z \"\$(find \"$HOME/.claude\" -mindepth 1 -maxdepth 1 -type l)\" ]"

# --- ~/.claude.json is folded into ~/.claude, unconditionally ---------------------------------
# The one place Claude Code keeps state outside ~/.claude. Doing this with no volume mounted, as
# here, is an indirection inside one home directory; with a volume at ~/.claude it is what makes
# a single mount capture everything.
check "~/.claude.json is a symlink" test -L "$HOME/.claude.json"
check "it points inside ~/.claude" \
  test "$(readlink "$HOME/.claude.json")" = "$HOME/.claude/.claude.json"
# Claude Code owns this file's contents and writes real state into it at install time
# (installMethod, firstStartVersion, migrationVersion, a machine id...). Pinning `{}` pinned a
# value that belonged to an external tool, and it went stale the moment the CLI started
# seeding itself. What this Feature is responsible for is the *fold* — that the path is a link
# into the volume (asserted above) and that reading through it yields a JSON object.
check "and reads back a JSON object through the link" \
  bash -c "test -s \"$HOME/.claude.json\" && test \"\$(head -c1 \"$HOME/.claude.json\")\" = '{'"

reportResults
