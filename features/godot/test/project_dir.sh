#!/bin/bash
# Scenario: the Godot project is NOT at the workspace root. `projectDir` is `games/app`, and
# the scenario's onCreateCommand creates that directory before the Feature's own
# postCreateCommand runs.
#
# What this scenario does NOT claim: that `.godot` under `games/app` is chowned correctly — it
# can't be, the declared volume cannot follow `projectDir` (see the README's own "does not
# follow projectDir" section, and node-nvmrc's identical limitation for node_modules). The
# create-time warning naming the exact mount line to paste is asserted offline instead, in
# post_create_test.sh's own projectDir cases: it goes to the create-time hook's stderr, which
# lands in the build log and is gone by the time this scenario's assertions run inside the
# finished container — the same reasoning node-nvmrc's project_subdir.sh documents.
#
# What IS observable here is the shape the warning describes.
set -e

source dev-container-features-test-lib

SHARE=/usr/local/share/devc-features/godot

check "projectDir was baked into the hook" \
  grep -qx 'PROJECT_DIR="games/app"' "$SHARE/post-create.sh"

check "godot still installs and runs regardless of projectDir" bash -c 'godot --headless --version'

# --- the declared volume does NOT follow projectDir --------------------------------------------
check "the volume landed at the workspace root, as declared" mountpoint -q "$PWD/.godot"
check "and NOT at the project directory, which is where Godot would actually cache" \
  bash -c "! mountpoint -q '$PWD/games/app/.godot' 2> /dev/null"

reportResults
