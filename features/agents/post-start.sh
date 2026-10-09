#!/bin/bash
# agents start-time step — when updateToolsOnStart is on, update each agent CLI this Feature
# installed, before anything launches it.
#
# install.sh copies this file to /usr/local/share/devc-features/agents/post-start.sh at image
# build time and writes update-tools.conf beside it: the CLIs that build installed, space-
# separated, in the order to update them (claude copilot pi herdr). No file means the option is
# off or no CLI was installed. The manifest's postStartCommand names the copy, and the
# devcontainer CLI runs it as the remote user.
#
# Why at start: the build-time install sits in a Docker RUN layer, and a plain rebuild reuses
# that layer, so a fresh container comes up on whatever version the layer first downloaded.
# Claude Code then replaces itself in the background and asks to be restarted. Updating here
# runs inside `devcontainer up`, before devc's `docker exec` (or VS Code) starts any agent, so
# the first launch is already current. postStartCommand rather than postCreateCommand so a
# container restarted days after its build is brought current too.
#
# Herdr is safe to update here: no Herdr server is running yet at start. It is never passed
# --handoff.
#
# Never fails the start: an offline or failed update must still leave a working container on
# the installed version. Every path logs and exits 0, and each update is capped at 120 seconds.
set -u

warn() {
  echo "agents: $*" >&2
}

# Overridable for the offline harness, which cannot write under /usr/local/share.
UPDATE_TOOLS_CONF="${UPDATE_TOOLS_CONF:-/usr/local/share/devc-features/agents/update-tools.conf}"
UPDATE_TIMEOUT=120
LOG_DIR="$HOME/.cache/devc-agents"

if [ ! -f "$UPDATE_TOOLS_CONF" ]; then
  echo "agents: updateToolsOnStart is off or no agent CLI is installed — nothing to update"
  exit 0
fi

# pi is a Node.js CLI, and the start-time shell's PATH is not guaranteed to carry node: the
# devcontainers node Feature wires nvm into interactive shells only. Same lookup as install.sh's
# node_prelude. Returns non-zero when node is still missing.
ensure_node() {
  command -v node > /dev/null 2>&1 && return 0
  for _nvm_dir in "${NVM_DIR:-}" /usr/local/share/nvm "$HOME/.nvm"; do
    [ -n "$_nvm_dir" ] || continue
    [ -s "$_nvm_dir/nvm.sh" ] || continue
    export NVM_DIR="$_nvm_dir"
    # nvm.sh is not written to be sourced under strict modes; nothing in it may abort this script.
    set +u
    . "$_nvm_dir/nvm.sh" > /dev/null 2>&1
    set -u
    command -v node > /dev/null 2>&1 && return 0
  done
  return 1
}

first_line() { # first_line <bin> — first line of `<bin> --version`, whatever the tool's format
  "$1" --version 2>&1 < /dev/null | head -n 1
}

mkdir -p "$LOG_DIR" 2> /dev/null || true

for name in $(cat "$UPDATE_TOOLS_CONF"); do
  # By absolute path: the start-time shell's PATH need not include ~/.local/bin.
  bin="$HOME/.local/bin/$name"
  if [ ! -x "$bin" ]; then
    warn "$name not found at ~/.local/bin/$name — skipping update"
    continue
  fi
  if [ "$name" = pi ] && ! ensure_node; then
    warn "pi update skipped — node not found"
    continue
  fi

  log="$LOG_DIR/update-$name.log"
  before="$(first_line "$bin")"
  # Plain `<bin> update`, no arguments for any tool: for pi, no target updates pi alone (not its
  # packages, which create time re-resolves); for herdr, no --handoff. stdin is /dev/null so an
  # update that wants confirmation fails instead of hanging the start.
  code=0
  if command -v timeout > /dev/null 2>&1; then
    timeout "$UPDATE_TIMEOUT" "$bin" update < /dev/null > "$log" 2>&1 || code=$?
  else
    "$bin" update < /dev/null > "$log" 2>&1 || code=$?
  fi
  after="$(first_line "$bin")"

  if [ "$code" -ne 0 ]; then
    warn "$name update failed (exit $code) — see ~/.cache/devc-agents/update-$name.log"
  elif [ "$before" != "$after" ]; then
    echo "agents: $name updated: $before → $after"
  else
    echo "agents: $name up to date: $after"
  fi
done

exit 0
