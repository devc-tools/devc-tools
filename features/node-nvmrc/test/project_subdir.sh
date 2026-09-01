#!/bin/bash
# Scenario: the Node project is NOT at the workspace root. `projectDir` is `packages/app`, the
# scenario's onCreateCommand writes `packages/app/.nvmrc` pinning 20, and there is deliberately
# **no `.nvmrc` at the workspace root at all**.
#
# The node Feature installs `lts`, so the gap between that and 20 is what makes "the option was
# honored" observable rather than a coincidence — the same technique with_nvmrc uses.
#
# The absent root `.nvmrc` matters for a second reason. `nvm install` with no arguments walks
# *up* the tree, so a root `.nvmrc` here would make this scenario pass even if the hook had
# ignored `projectDir` entirely. Its absence is what makes the hook's own `cd` the only thing
# that can have found the file. The complementary case — a root `.nvmrc` that must NOT be
# inherited — is asserted offline in post_create_test.sh, where nvm's walk-up can be observed
# not happening.
set -e

source dev-container-features-test-lib

PINNED=20
SHARE=/usr/local/share/devc-features/node-nvmrc

check "the .nvmrc is in the project directory" test -f "$PWD/packages/app/.nvmrc"
check "and there is none at the workspace root" test ! -f "$PWD/.nvmrc"

check "projectDir was baked into the hook" \
  grep -qx 'PROJECT_DIR="packages/app"' "$SHARE/post-create.sh"

check "the project's pinned major is what got installed" bash -c \
  "ls -d \"\${NVM_DIR:-/usr/local/share/nvm}\"/versions/node/v$PINNED.* > /dev/null"

# The whole point: the pin is container-wide, so it does not matter that the process asking is
# nowhere near packages/app.
check "a plain non-interactive bash reports the project's version" bash -c \
  "[ \"\$(bash -c 'node -v' | tr -d '\r' | cut -d. -f1)\" = 'v$PINNED' ]"
check "from the workspace root, which pins nothing itself" bash -c \
  "[ \"\$(cd $PWD && bash -c 'node -v' | tr -d '\r' | cut -d. -f1)\" = 'v$PINNED' ]"
check "and from outside the workspace entirely" bash -c \
  "[ \"\$(cd /tmp && sh -c 'node -v' | tr -d '\r' | cut -d. -f1)\" = 'v$PINNED' ]"

check "pin/bin points into that version" bash -c \
  "case \"\$(readlink -f $SHARE/pin/bin)\" in */versions/node/v$PINNED.*/bin) exit 0 ;;
     *) exit 1 ;; esac"

# --- the declared volume does NOT follow projectDir --------------------------------------------
# A Feature option cannot substitute into that Feature's own mounts (declared-volume-spike, M2),
# so the declared volume is at the workspace root while this project is in packages/app. That is
# a documented limitation, not a bug, and the create-time warning is its entire mitigation.
#
# The warning text itself is asserted offline, in post_create_test.sh case 17, not here: it goes
# to the create-time hook's stderr, which lands in the build log and is gone by the time a
# scenario runs inside the finished container. What IS observable here is the shape the warning
# describes, so that is what this asserts.
check "the volume landed at the workspace root, as declared" mountpoint -q "$PWD/node_modules"
check "and NOT at the project directory, which is where npm would use it" \
  bash -c "! mountpoint -q '$PWD/packages/app/node_modules' 2> /dev/null"

reportResults
