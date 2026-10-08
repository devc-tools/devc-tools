#!/bin/bash
# Scenario: Debian bookworm, with `extraPackages` set to the README's VS Code / Electron list.
#
# Two things at once. bookworm predates the `t64` renames, so the four `t64` names in that list
# can only install through the fallback to their bare names — and the list is the one a consumer
# pastes from the README, so this is also the proof that recipe installs on a real base. The
# image is pinned to bookworm rather than the floating `debian` tag on purpose: trixie has the
# `t64` names, and a tag that floated onto it would leave the fallback unexercised while still
# passing.
set -e

source dev-container-features-test-lib

installed() { # installed <pkg>...
  for _p in "$@"; do dpkg -s "$_p" > /dev/null 2>&1 || { echo "not installed: $_p"; return 1; }; done
}

check "this base really is one without the t64 names" bash -c \
  '. /etc/os-release && [ "$ID" = debian ] && [ "$VERSION_ID" = 12 ]'
check "the t64 names fell back to the bare ones" installed libgtk-3-0 libasound2 \
  libatk-bridge2.0-0 libcups2
check "the rest of the list installed as written" installed libnss3 libgbm1 libxss1 \
  libxkbfile1 libsecret-1-0 libxshmfence1 libdrm2
check "the default groups installed on Debian too" installed xvfb xauth x11-utils libx11-6 \
  libgl1 libegl1 libgl1-mesa-dri fonts-dejavu-core

eval "$(xvfb-ensure)"
check "Xvfb starts on Debian" test "$DISPLAY" = ':99'
check "and answers" xdpyinfo
check "with GLX" bash -c 'xdpyinfo | grep -qx " *GLX"'
check "xvfb-ensure --stop exits 0" xvfb-ensure --stop

reportResults
