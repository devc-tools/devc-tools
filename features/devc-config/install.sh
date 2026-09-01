#!/bin/sh
# devc-config Feature install — place the create-time script. Nothing else.
#
# Runs as root at image *build* time. The workspace is not mounted yet, so there is nothing here
# to read from it and nothing to resolve — the two fenced blocks in post-create.sh do all of
# that themselves, at create time.
#
# There are no options: the two candidate hook paths and the bashrc marker are hardcoded inside
# those fences. See features/CONTRIBUTING.md for why.
set -e

# /usr/local/share/devc-features/<id>/ is the Feature namespace, kept separate from devc's own
# /usr/local/share/devc/ so "did devc put this here, or a Feature?" stays answerable.
# Overridable for the test harness.
SHARE_DIR="${SHARE_DIR:-/usr/local/share/devc-features/devc-config}"

FEATURE_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$SHARE_DIR"
# Plain cp rather than `install -o root`: this runs as root, so the copy is root-owned either
# way, and no ownership flag means the script still runs unprivileged in the test harness.
#
# No chown of anything, here or after. The create-time hook runs as the remote user but only
# ever *reads* $SHARE_DIR — nothing is written there at create time, so there is no ownership
# handover to make.
cp "$FEATURE_DIR/post-create.sh" "$SHARE_DIR/post-create.sh"
chmod 0755 "$SHARE_DIR/post-create.sh"

echo "devc-config: create-time script installed at $SHARE_DIR/post-create.sh"
