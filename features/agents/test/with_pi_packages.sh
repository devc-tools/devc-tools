#!/bin/bash
# Scenario `with_pi_packages` — installPiCli: true plus one piPackages entry, alongside a node
# Feature. Exercises the build-time `pi install` path: the package must be visible to `pi list`
# and ~/.pi/agent/settings.json (the file pi install writes) must exist and be owned by the
# remote user. Ownership is the assertion with teeth: ~/.pi is a declared volume, so a
# root-owned first-use volume would leave pi unable to write its own state at all.
set -e

source dev-container-features-test-lib

check "pi is on PATH" bash -c "command -v pi"

check "the pi package appears in pi list" bash -c \
  "pi list | grep -qF 'npm:@andrewjacop/pi-herdr'"

check "~/.pi/agent/settings.json exists" test -f "$HOME/.pi/agent/settings.json"
check "and is owned by the remote user" bash -c \
  "[ \"\$(stat -c '%U' \"$HOME/.pi/agent/settings.json\")\" = \"\$(id -un)\" ]"
check "and names the installed package" bash -c \
  "grep -qF 'npm:@andrewjacop/pi-herdr' \"$HOME/.pi/agent/settings.json\""

reportResults
