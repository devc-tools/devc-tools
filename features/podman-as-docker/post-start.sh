#!/bin/sh
# podman-as-docker start-time step — run `podman system service` on the fixed Docker-API
# socket path, backgrounded and idempotent.
#
# install.sh copies this file to
# /usr/local/share/devc-features/podman-as-docker/post-start.sh at image build time and
# bakes SOCKET_DIR and DOCKER_API_SOCKET_OPT into the two assignments below; the
# manifest's postStartCommand names that copy and its own containerEnv names the same
# socket path as DOCKER_HOST unconditionally (containerEnv cannot be conditional on an
# option).
#
# This runs on *every* start and every restart-after-attach — postStartCommand, not
# postCreateCommand, because the API service is a process and does not survive a stop.
#
# Never fails the start: the `docker` CLI shim (podman-docker) works without this socket
# at all: only a DOCKER_HOST consumer needs it. Every path here logs and exits 0.
set -u

warn() {
  echo "podman-as-docker: $*" >&2
}

# --- baked by install.sh from the Feature's options ---------------------------------
SOCKET_DIR="${SOCKET_DIR:-/run/devc-features/podman-as-docker}"
DOCKER_API_SOCKET_OPT="${DOCKER_API_SOCKET_OPT:-true}"
# --------------------------------------------------------------------------------------

[ "$DOCKER_API_SOCKET_OPT" = true ] || {
  echo "podman-as-docker: dockerApiSocket is false — not starting the API service"
  exit 0
}

command -v podman > /dev/null 2>&1 || {
  warn "podman not on PATH — cannot start the API service"
  exit 0
}

mkdir -p "$SOCKET_DIR" 2> /dev/null || {
  warn "could not create $SOCKET_DIR — cannot start the API service"
  exit 0
}

# Ownership repair: install.sh chowns $SOCKET_DIR to $_REMOTE_USER at *build* time, but
# the devcontainer CLI's default UID remap — on a Linux host whose UID differs from the
# image's baked-in one, which is the normal case on a CI runner — renumbers the remote
# user's UID *after* the image is built, and chowns only $HOME doing it. That orphans
# $SOCKET_DIR from the renumbered user, and every write below (the log file, the socket
# itself) then fails with Permission denied. sudo -n so a passworded sudo cannot hang
# this on a prompt nobody can answer; best-effort, since this must never fail the start.
owner="$(stat -c '%U' "$SOCKET_DIR" 2> /dev/null || true)"
if [ -n "$owner" ] && [ "$owner" != "$(id -un)" ] && command -v sudo > /dev/null 2>&1; then
  sudo -n chown "$(id -un)" "$SOCKET_DIR" 2> /dev/null ||
    warn "$SOCKET_DIR is owned by $owner and could not be repaired"
fi

SOCK="$SOCKET_DIR/podman.sock"

# Idempotent: if the socket already answers, do nothing. This is what makes it safe to
# run on every start and every restart-after-attach, not just the first one.
if [ -S "$SOCK" ] && podman --url "unix://$SOCK" system info > /dev/null 2>&1; then
  echo "podman-as-docker: API socket already answering at $SOCK"
  exit 0
fi

# A stale socket file from a service that died without cleaning up would otherwise make
# the next `podman system service` fail to bind.
rm -f "$SOCK" 2> /dev/null || true

# Backgrounded and detached: a blocking postStartCommand hangs container start. setsid
# detaches from the postStartCommand's own process group so it survives that command
# exiting; stdio is redirected so nothing here can block on a closed pipe.
LOG="$SOCKET_DIR/service.log"
if command -v setsid > /dev/null 2>&1; then
  setsid podman system service --time=0 "unix://$SOCK" > "$LOG" 2>&1 < /dev/null &
else
  nohup podman system service --time=0 "unix://$SOCK" > "$LOG" 2>&1 < /dev/null &
fi
disown 2> /dev/null || true

# Give it a moment to bind, then report — best-effort, not a hard wait: a slow start
# still leaves the service coming up in the background, and this must never fail the
# start.
_i=0
while [ "$_i" -lt 20 ]; do
  [ -S "$SOCK" ] && break
  sleep 0.1
  _i=$((_i + 1))
done

if [ -S "$SOCK" ]; then
  echo "podman-as-docker: API socket started at $SOCK"
else
  warn "API socket did not appear at $SOCK after starting the service — see $LOG"
fi
exit 0
