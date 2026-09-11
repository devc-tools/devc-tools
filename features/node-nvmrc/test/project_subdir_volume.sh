#!/bin/bash
# Scenario: `projectDir` is `packages/app` AND the consumer mounted their own node_modules volume
# there — the shape the create-time warning asks for, and the one it must recognise as already
# done. The scenario's mount is deliberately spelled the way a consumer would rather than the way
# the manifest is: a `source` of its own (`node-modules-${devcontainerId}-app`, distinct from the
# Feature's, which is what a monorepo giving each package its own volume needs) and a `target`
# written through `${containerWorkspaceFolder}` rather than as a literal path.
#
# Only a real container can assert this. The Feature cannot read the consumer's devcontainer.json,
# so it asks whether the path is a mount point instead — and whether that question gets the right
# answer depends on the CLI having merged this mount and Docker having made it, neither of which
# exists offline. The warning's *text* stays asserted in post_create_test.sh (case 18); what is
# observable here is the shape underneath it.
set -e

source dev-container-features-test-lib

PINNED=20
SHARE=/usr/local/share/devc-features/node-nvmrc

check "projectDir was baked into the hook" \
  grep -qx 'PROJECT_DIR="packages/app"' "$SHARE/post-create.sh"

# The premise. Both are mount points here: the Feature's own declaration still lands at the
# workspace root — it cannot follow projectDir — and the consumer's lands on the project.
check "the consumer's volume is a mount point at the project directory" \
  mountpoint -q "$PWD/packages/app/node_modules"
check "and the Feature's own is still at the workspace root" mountpoint -q "$PWD/node_modules"

# What the mount is for. A volume comes up root-owned, and the hook's chown follows projectDir —
# so this is the first scenario where that repair runs against a real volume that npm would use.
check "the project's node_modules is owned by the remote user, not root" \
  test -O "$PWD/packages/app/node_modules"
check "and is writable, which is what npm ci needs" bash -c \
  "touch '$PWD/packages/app/node_modules/.write-probe' && rm '$PWD/packages/app/node_modules/.write-probe'"

# And the rest of the hook is unaffected by any of it.
check "the project's pinned major is what got installed" bash -c \
  "ls -d \"\${NVM_DIR:-/usr/local/share/nvm}\"/versions/node/v$PINNED.* > /dev/null"
check "a plain non-interactive bash reports the project's version" bash -c \
  "[ \"\$(bash -c 'node -v' | tr -d '\r' | cut -d. -f1)\" = 'v$PINNED' ]"

reportResults
