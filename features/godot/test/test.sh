#!/bin/bash
# `devcontainer features test` default scenario — runs INSIDE a container built from this
# Feature with **no options** (`"godot": {}`) on mcr.microsoft.com/devcontainers/base:ubuntu,
# which has no Godot, no display server and no fontconfig in it at all.
#
# That combination is the point of this file. It is the bare-`{}` case every Feature in this
# collection has to survive (see .plans/design/devc-feature-split.md), and it also proves the
# headless claim: the same binary that "latest" resolved at build time runs with no display
# server anywhere in the image.
#
# The pinned-version and projectDir scenarios in scenarios.json cover the rest.
set -e

source dev-container-features-test-lib

SHARE=/usr/local/share/devc-features/godot

check "the binary is installed" test -x "$SHARE/bin/godot"
check "owned by root" bash -c "[ \"\$(stat -c '%U:%G' $SHARE/bin/godot)\" = 'root:root' ]"
check "godot is on PATH" bash -c 'command -v godot'
check "and is a symlink to the installed binary" bash -c \
  "[ \"\$(readlink /usr/local/bin/godot)\" = $SHARE/bin/godot ]"

check "create-time script is installed" test -f "$SHARE/post-create.sh"
check "and is executable" test -x "$SHARE/post-create.sh"

# The options cross into the create-time script at build time — the manifest's
# postCreateCommand takes no arguments — so "did the bake happen" is a real property. These are
# the defaults, since this scenario passes no options.
check "projectDir baked empty — the workspace root" \
  grep -qx 'PROJECT_DIR=""' "$SHARE/post-create.sh"
check "fixGodotDirOwnership baked true" \
  grep -qx 'FIX_GODOT_DIR_OWNERSHIP="true"' "$SHARE/post-create.sh"

# --- the headless claim: no display server anywhere in this image ---------------------------

check "no X11/Wayland display is set" bash -c '[ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]'
check "godot --version succeeds" bash -c 'godot --version'
check "godot --headless --version succeeds too" bash -c 'godot --headless --version'
check "both report the same version string" bash -c \
  '[ "$(godot --version)" = "$(godot --headless --version)" ]'

# installDependencies defaults on: fontconfig is the one shared library shown to matter for
# headless import/export on this base image.
check "fontconfig is installed" bash -c 'dpkg -s fontconfig > /dev/null 2>&1'

# --- the declared .godot volume ---------------------------------------------------------------

check "the .godot volume is mounted at the workspace root" mountpoint -q "$PWD/.godot"
check "and is owned by the remote user (the create-time chown ran)" bash -c \
  "[ \"\$(stat -c '%U' $PWD/.godot)\" = \"\$(id -un)\" ]"
check "and is writable by them" test -w "$PWD/.godot"

reportResults
