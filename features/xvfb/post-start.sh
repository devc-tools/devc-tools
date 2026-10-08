#!/bin/sh
# xvfb start-time step — when the Feature's startOnContainerStart option is on, make sure a
# virtual display is up before anything asks for one.
#
# install.sh copies this file to /usr/local/share/devc-features/xvfb/post-start.sh at image
# build time and bakes START_ON_CONTAINER_START_OPT into the assignment below; the manifest's
# postStartCommand names that copy.
#
# This runs on *every* start and every restart-after-attach — postStartCommand, not
# postCreateCommand, because the server is a process and does not survive a stop. xvfb-ensure
# is what makes that safe: a display that is already up is reused, not started twice.
#
# It sets no DISPLAY for anyone. A Feature's containerEnv cannot be conditional on an option,
# and a DISPLAY exported unconditionally would point every process in every consumer's
# container at a display that, by default, does not exist. The README has the remoteEnv line
# for a consumer who wants it global.
#
# Never fails the start: nothing in the container depends on this display existing at start,
# and `xvfb-ensure` will start one on demand anyway. Every path here logs and exits 0.
set -u

warn() {
  echo "xvfb: $*" >&2
}

# --- baked by install.sh from the Feature's options ---------------------------------
START_ON_CONTAINER_START_OPT="${START_ON_CONTAINER_START_OPT:-false}"
# --------------------------------------------------------------------------------------

[ "$START_ON_CONTAINER_START_OPT" = true ] || {
  echo "xvfb: startOnContainerStart is false — not starting a display (xvfb-ensure starts one on demand)"
  exit 0
}

# The copy that sits beside this script, so a bind mount over the Feature's directory shadows
# both together.
XVFB_ENSURE="${XVFB_ENSURE:-$(dirname "$0")/bin/xvfb-ensure}"

[ -x "$XVFB_ENSURE" ] || {
  warn "$XVFB_ENSURE is missing or not executable — cannot start a display"
  exit 0
}

# With $DISPLAY unset: the option asks for the *virtual* display to be up. A DISPLAY already in
# this hook's environment — a forwarded host display, or the consumer's own remoteEnv naming the
# display this is about to start — must not be mistaken for it.
unset DISPLAY

if _out="$("$XVFB_ENSURE")"; then
  _display="${_out#export DISPLAY=\"}"
  _display="${_display%\"}"
  echo "xvfb: virtual display ready at $_display"
else
  warn "xvfb-ensure could not start a display — see its messages above; run it by hand to retry"
fi
exit 0
