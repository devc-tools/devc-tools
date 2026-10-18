#!/bin/bash
# Scenario: `version: "25.07.1"` — a release tag rather than "latest".
#
# The installed binary reports exactly what was asked for, independent of whatever "latest"
# resolves to on the day this runs. Tag-to-asset mapping is asserted offline, in
# install_options_test.sh; this is what proves the real release asset installs and runs.
set -e

source dev-container-features-test-lib

check "the requested version was installed" bash -c 'hx --version | grep -q "^helix 25.07.1 "'
check "hx --health runs" hx --health

reportResults
