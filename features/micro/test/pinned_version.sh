#!/bin/bash
# Scenario: `version: "2.0.15"` — a release version rather than "latest".
#
# The installed binary reports exactly what was asked for, independent of whatever "latest"
# resolves to on the day this runs. Version-to-asset mapping is asserted offline, in
# install_options_test.sh; this is what proves the real release asset installs and runs.
set -e

source dev-container-features-test-lib

check "the requested version was installed" bash -c 'micro -version | grep -q "^Version: 2.0.15$"'

reportResults
