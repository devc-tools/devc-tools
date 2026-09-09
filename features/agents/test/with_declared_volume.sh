#!/bin/bash
# Scenario `with_declared_volume` — the Feature's own `mounts` declaration, which nothing offline
# can assert: it only exists once the devcontainer CLI has merged this Feature's metadata and
# handed the mount to `docker run`.
#
# Note what this scenario passes: nothing. A bare `{}` is the point — persistence used to require
# a mount line pasted into the consumer's devcontainer.json, and this asserts it no longer does.
#
# The volume is keyed on ${devcontainerId}, so its *name* is opaque and per-devcontainer and is
# deliberately not asserted here (a test that pinned the name would pin the id). What matters is
# that ~/.claude is a mount point at all, and that the rest of the Feature still works on top of
# one — a volume mounted over a build-time directory is exactly the case the ownership repair was
# written against, and this is the first scenario where it runs against a real one. It is also
# where CLAUDE_CONFIG_DIR and the declared volume are checked to name the same path.
set -e

source dev-container-features-test-lib

check "~/.claude is a mount point, not a plain directory" mountpoint -q "$HOME/.claude"

# The declared target is the literal /home/vscode/.claude and this image's remote user is `vscode`,
# so the two agree and no warning should have fired. The mismatch path has its own scenario
# (`with_mismatched_home`).
check "the remote user's home is the one the manifest targets" test "$HOME" = /home/vscode

# The volume seeds itself from what install.sh pre-created in the image, which is what keeps it
# owned by the remote user rather than root. Asserting writability is the assertion that matters
# — a root-owned volume here would leave Claude Code unable to write its own state.
check "~/.claude is owned by the remote user, not root" test -O "$HOME/.claude"
check "and is writable" bash -c "touch \"$HOME/.claude/.write-probe\" && rm \"$HOME/.claude/.write-probe\""

# The manifest's containerEnv, now observed on top of a real mount rather than a plain directory.
# containerEnv is baked as an image ENV, so this asserts it reached the running container at all —
# and that Claude Code, not this Feature, is what put .claude.json inside the volume.
check "CLAUDE_CONFIG_DIR is exported in the container" \
  bash -c "[ \"\$(printenv CLAUDE_CONFIG_DIR)\" = /home/vscode/.claude ]"
# A regular file, not a symlink: the fold is gone, and what is here was written in place by the
# CLI at install time (installMethod, firstStartVersion, migrationVersion, a machine id...).
check "~/.claude/.claude.json is a regular file, not a symlink" \
  bash -c "test -f \"$HOME/.claude/.claude.json\" && test ! -L \"$HOME/.claude/.claude.json\""
check "nothing was left beside the volume at ~/.claude.json" test ! -e "$HOME/.claude.json"

reportResults
