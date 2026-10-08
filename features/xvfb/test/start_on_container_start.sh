#!/bin/bash
# Scenario: `startOnContainerStart: true`.
#
# The whole point: a display is already up, and this script never starts one. The server was
# started by the Feature's postStartCommand, whose own process exited long before this ran — so
# finding it here is what proves a started server outlives the hook that started it.
set -e

source dev-container-features-test-lib

SHARE=/usr/local/share/devc-features/xvfb

check "startOnContainerStart baked true" \
  grep -qx 'START_ON_CONTAINER_START_OPT="true"' "$SHARE/post-start.sh"

# --status first, and only ever --status: it cannot start anything.
check "a display is already up" xvfb-ensure --status
check "on the default number" bash -c \
  "[ \"\$(xvfb-ensure --status)\" = 'export DISPLAY=\":99\"' ]"
check "started by xvfb-ensure — its pidfile is there" test -f /tmp/xvfb-99.pid
check "naming a running Xvfb" bash -c '[ "$(pgrep -x Xvfb)" = "$(cat /tmp/xvfb-99.pid)" ]'
check "and it answers a client" xdpyinfo -display :99

# The option starts a server; it still exports nothing.
check "DISPLAY is still not set for anyone" bash -c '[ -z "${DISPLAY:-}" ]'

# The hook runs on every start; running it again must find the same server, not add one.
check "the start-time hook is safe to run again" bash "$SHARE/post-start.sh"
check "and started no second server" bash -c '[ "$(pgrep -cx Xvfb)" -eq 1 ]'

reportResults
