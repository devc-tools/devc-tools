#!/bin/bash
# Scenario: every group `false` — `x11Libraries`, `openGL`, `fonts` off, `vulkan` and `tools`
# left off.
#
# Proves the always-set alone is a working Feature: Xvfb still starts and still answers.
#
# What this deliberately does not assert is that the *default* groups' packages are absent.
# Most of them are dependencies of the always-set itself (xvfb pulls in libgl1 and a Mesa
# driver, x11-utils most of the X client libraries), so they are present here whatever the
# options say. That each option changes the *requested* set is asserted offline, in
# install_options_test.sh, where the request can be seen directly. The opt-in groups are
# nothing's dependency, so their absence is checked here.
set -e

source dev-container-features-test-lib

absent() { # absent <pkg>...
  for _p in "$@"; do ! dpkg -s "$_p" > /dev/null 2>&1 || { echo "installed: $_p"; return 1; }; done
}

check "the always-set is installed" bash -c \
  'dpkg -s xvfb > /dev/null && dpkg -s xauth > /dev/null && dpkg -s x11-utils > /dev/null'
check "the vulkan group is not" absent mesa-vulkan-drivers
check "the tools group is not" absent imagemagick xdotool

eval "$(xvfb-ensure)"
check "Xvfb still starts" test "$DISPLAY" = ':99'
check "and answers" xdpyinfo
check "xvfb-ensure --stop exits 0" xvfb-ensure --stop

reportResults
