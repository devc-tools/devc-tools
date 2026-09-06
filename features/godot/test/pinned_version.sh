#!/bin/bash
# Scenario: `version: "4.7.2"` — a bare version, not a full `-stable` tag, and not "latest".
#
# The whole point: the installed version is exactly what was asked for, independent of
# whatever "latest" currently resolves to on the day this runs. A bare version and its full
# `X.Y.Z-stable` tag are asserted to resolve identically offline, in
# install_options_test.sh's own case 2 — this scenario is what proves the *installed binary*
# actually reports it, which the offline harness (no real Godot binary) cannot.
set -e

source dev-container-features-test-lib

SHARE=/usr/local/share/devc-features/godot

check "projectDir baked empty" grep -qx 'PROJECT_DIR=""' "$SHARE/post-create.sh"

check "the requested version was installed" bash -c \
  "case \"\$(godot --version)\" in 4.7.2.stable.*) exit 0 ;; *) exit 1 ;; esac"
check "headless reports the same" bash -c \
  "[ \"\$(godot --version)\" = \"\$(godot --headless --version)\" ]"

reportResults
