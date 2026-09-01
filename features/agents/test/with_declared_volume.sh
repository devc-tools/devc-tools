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
# one — a volume mounted over a build-time directory is exactly the case the ownership repair and
# the .claude.json fold were written against, and this is the first scenario where they run
# against a real one.
set -e

source dev-container-features-test-lib

check "~/.claude is a mount point, not a plain directory" mountpoint -q "$HOME/.claude"

# The declared target is a literal /home/vscode/.claude; this image's remote user is vscode, so
# the two agree and no warning should have fired. The mismatch path is covered by reading, not by
# a scenario — building an image with a differently-named remote user to assert a warning costs a
# whole scenario for one echo.
check "the remote user's home is the one the manifest targets" test "$HOME" = /home/vscode

# The volume seeds itself from what install.sh pre-created in the image, which is what keeps it
# owned by the remote user rather than root. Asserting writability is the assertion that matters
# — a root-owned volume here would leave Claude Code unable to write its own state.
check "~/.claude is owned by the remote user, not root" test -O "$HOME/.claude"
check "and is writable" bash -c "touch \"$HOME/.claude/.write-probe\" && rm \"$HOME/.claude/.write-probe\""

# Everything the Feature does at create time, now done on top of a real mount rather than a plain
# directory — the combination that was previously only ever exercised by devc, never by a test.
check "~/.claude.json is a symlink into the volume" test -L "$HOME/.claude.json"
check "it points inside ~/.claude" \
  test "$(readlink "$HOME/.claude.json")" = "$HOME/.claude/.claude.json"
check "and reads back the seeded {}" test "$(cat "$HOME/.claude.json")" = '{}'

reportResults
