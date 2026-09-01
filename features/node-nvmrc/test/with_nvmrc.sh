#!/bin/bash
# Scenario: the upstream node Feature provides nvm, this Feature drives it, and the workspace
# pins a version the node Feature did NOT install (`.nvmrc` says 20, the node Feature installed
# `lts`). That gap is deliberate — it is what makes "the pinned version won" observable rather
# than a coincidence.
#
# The `.nvmrc` is written by the scenario's own `onCreateCommand`, which runs before *any*
# postCreateCommand, this Feature's included. `devcontainer features test` generates the
# workspace folder itself and copies the test directory in only after the container is created,
# so there is no committed fixture that could be in place at create time — the onCreateCommand
# is the only way to have a `.nvmrc` there when the hook looks for one.
#
# This is also the scenario that answers the question the plan refused to assume: if a
# Feature-declared postCreateCommand did NOT run with cwd at the workspace folder, the hook
# would have found no `.nvmrc` and installed nothing, and the first check below fails.
set -e

source dev-container-features-test-lib

PINNED=20
SHARE=/usr/local/share/devc-features/node-nvmrc

check ".nvmrc is where the hook would have looked" test -f "$PWD/.nvmrc"

check "the pinned major is installed under nvm" bash -c \
  "ls -d \"\${NVM_DIR:-/usr/local/share/nvm}\"/versions/node/v$PINNED.* > /dev/null"

check "pin/bin points into that version" bash -c \
  "case \"\$(readlink -f $SHARE/pin/bin)\" in */versions/node/v$PINNED.*/bin) exit 0 ;;
     *) exit 1 ;; esac"

# The assertion that matters, and the whole reason 0.2.0 exists. In 0.1.0 the pin lived in a
# ~/.bashrc block, so only `bash -lic` could see it; these three shapes all got whatever the
# node Feature installed. Now the pin is a PATH entry in PID 1's environment.
check "a plain non-interactive bash reports the pinned major" bash -c \
  "[ \"\$(bash -c 'node -v' | tr -d '\r' | cut -d. -f1)\" = 'v$PINNED' ]"
check "so does sh — no bash, no startup file, nothing" bash -c \
  "[ \"\$(sh -c 'node -v' | tr -d '\r' | cut -d. -f1)\" = 'v$PINNED' ]"
check "and a login shell agrees" bash -c \
  "[ \"\$(bash -lc 'node -v' | tr -d '\r' | cut -d. -f1)\" = 'v$PINNED' ]"

# `env -i` keeps only what the caller passes: this is the pin reaching a process that inherited
# nothing but PATH, which is as close as a scenario gets to `docker exec`.
check "and a process given nothing but PATH" bash -c \
  "[ \"\$(env -i PATH=\"\$PATH\" node -v | tr -d '\r' | cut -d. -f1)\" = 'v$PINNED' ]"

# Directory-independence is now a property, not a limitation: the pin is one version for the
# whole container, so leaving the workspace changes nothing.
check "the version does not depend on the cwd" bash -c \
  "[ \"\$(cd /tmp && bash -c 'node -v' | tr -d '\r' | cut -d. -f1)\" = 'v$PINNED' ]"

# The mechanism, stated as a check so a future refactor cannot quietly move it back into a
# startup file.
check "no node-nvmrc block was appended to ~/.bashrc" bash -c \
  "! grep -qF '# >>> node-nvmrc >>>' '$HOME/.bashrc' 2> /dev/null"
check "and no cd override exists in an interactive shell" bash -c \
  "! bash -ic 'declare -F cd' > /dev/null 2>&1"

# nvm's own state agrees with PATH, so `nvm use default` in a terminal lands on the pin too.
check "nvm's default alias names the pinned version" bash -c \
  ". \"\${NVM_DIR:-/usr/local/share/nvm}/nvm.sh\" &&
   [ \"\$(nvm version default | cut -d. -f1)\" = 'v$PINNED' ]"

# --- the Feature's own declared node_modules volume -------------------------------------------
# New in 0.2.0: this Feature declares the volume rather than asking every consumer to paste a
# mount line. Nothing offline can see it — the mount only exists once the CLI has merged this
# Feature's metadata into `docker run`.
check "node_modules is a mount point, not a plain directory" mountpoint -q "$PWD/node_modules"

# The ownership repair, observed against a real volume for the first time. A named volume mounted
# over a path with nothing behind it in the image comes up root-owned; without the repair, the
# npm run below fails EACCES. This is the condition declared-volume-spike M4 reproduced
# standalone, and the repair predates it — see post-create.sh's FIX_NODE_MODULES_OWNERSHIP.
check "and the create-time repair left it writable by the remote user" \
  bash -c "touch '$PWD/node_modules/.write-probe' && rm '$PWD/node_modules/.write-probe'"

# The regression guard for declared-volume-spike M3. `npm ci` removes node_modules before
# installing, and a mount point's contents can be emptied but the directory itself cannot be
# unlinked — so the failure to watch for is EBUSY. Measured to pass on npm 10.9.8; nothing pins
# npm, which is exactly why this runs on every scenario run rather than once in a spike.
#
# Twice, deliberately: the first `ci` has an empty directory to work with, the second has a
# populated one, and only the second exercises the removal path.
printf '{"name":"nvmrc-scenario","version":"1.0.0","private":true,"dependencies":{"is-number":"7.0.0"}}\n' \
  > "$PWD/package.json"
check "npm install populates the volume" bash -c "cd '$PWD' && npm install --silent"
check "npm ci succeeds over the mounted volume" bash -c "cd '$PWD' && npm ci --silent"
check "and again, with a populated node_modules to remove first — no EBUSY" \
  bash -c "cd '$PWD' && npm ci --silent"
check "the volume is still mounted afterwards" mountpoint -q "$PWD/node_modules"
check "and was refilled, not left empty" test -d "$PWD/node_modules/is-number"

reportResults
