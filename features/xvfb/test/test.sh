#!/bin/bash
# `devcontainer features test` default scenario — runs INSIDE a container built from this
# Feature with **no options** (`"xvfb": {}`) on mcr.microsoft.com/devcontainers/base:ubuntu,
# which has no X server and no GL driver in it at all.
#
# It is the bare-`{}` case every Feature in this collection has to survive (see
# .plans/design/devc-feature-split.md): the default groups are installed, nothing was started
# and no DISPLAY was exported, and `xvfb-ensure` then produces a display a real client accepts.
#
# The option, start-time, Godot-rendering and Debian scenarios in scenarios.json cover the rest.
set -e

source dev-container-features-test-lib

SHARE=/usr/local/share/devc-features/xvfb

installed() { # installed <pkg>...
  for _p in "$@"; do dpkg -s "$_p" > /dev/null 2>&1 || { echo "not installed: $_p"; return 1; }; done
}

check "the always-set is installed" installed xvfb xauth x11-utils
check "x11Libraries defaults on" installed libx11-6 libxext6 libxi6 libxrandr2 libxcursor1 \
  libxinerama1 libxrender1 libxkbcommon0 libfontconfig1
check "openGL defaults on" installed libgl1 libegl1 libgl1-mesa-dri
check "fonts defaults on" installed fonts-dejavu-core

check "xvfb-ensure is installed" test -x "$SHARE/bin/xvfb-ensure"
check "and is on PATH" bash -c 'command -v xvfb-ensure'
check "as a symlink to the installed command" bash -c \
  "[ \"\$(readlink /usr/local/bin/xvfb-ensure)\" = $SHARE/bin/xvfb-ensure ]"
check "display baked to the default" grep -qx 'DEFAULT_DISPLAY="99"' "$SHARE/bin/xvfb-ensure"
check "screen baked to the default" \
  grep -qx 'DEFAULT_SCREEN="1920x1080x24"' "$SHARE/bin/xvfb-ensure"
check "startOnContainerStart baked false" \
  grep -qx 'START_ON_CONTAINER_START_OPT="false"' "$SHARE/post-start.sh"

# --- a bare {} starts nothing and exports nothing ---------------------------------------------

check "no DISPLAY is set" bash -c '[ -z "${DISPLAY:-}" ]'
check "no server is running" bash -c '! pgrep -x Xvfb > /dev/null'
check "xvfb-ensure --status agrees" bash -c '! xvfb-ensure --status'

# --- start, reuse, stop -----------------------------------------------------------------------

FIRST="$(xvfb-ensure)"
check "xvfb-ensure prints exactly the export line" test "$FIRST" = 'export DISPLAY=":99"'
eval "$FIRST"
check "the display it names answers" xdpyinfo
check "with the requested screen" bash -c 'xdpyinfo | grep -q "dimensions: *1920x1080 pixels"'
check "and GLX, so Mesa clients can render" bash -c 'xdpyinfo | grep -qx " *GLX"'
check "the server outlived the command that started it" pgrep -x Xvfb

SECOND="$(xvfb-ensure)"
check "a second call prints the identical line" test "$SECOND" = "$FIRST"
check "and started no second server" bash -c '[ "$(pgrep -cx Xvfb)" -eq 1 ]'
check "--status reports it too" bash -c "[ \"\$(xvfb-ensure --status)\" = '$FIRST' ]"

# Debian's own one-server-per-command script still works beside it, on a display of its own.
# The shared server is identified by pid, not by counting Xvfb processes: xvfb-run's private
# server is still exiting for a moment after xvfb-run itself returns (measured: a count taken
# straight afterwards reads 2, and 1 a second later).
SHARED_PID="$(cat /tmp/xvfb-99.pid)"
check "xvfb-run -a works alongside" xvfb-run -a xdpyinfo
check "and left the shared server running" kill -0 "$SHARED_PID"
check "and still answering" xdpyinfo

check "xvfb-ensure --stop exits 0" xvfb-ensure --stop
check "and --status then exits 1" bash -c '! xvfb-ensure --status'
check "the shared server is gone" bash -c "! kill -0 $SHARED_PID 2> /dev/null"
check "and so is its pidfile" test ! -e /tmp/xvfb-99.pid

reportResults
