#!/bin/sh
# godot create-time step — repair ownership of the declared .godot cache volume, or warn when
# projectDir means that volume isn't where the project actually is.
#
# install.sh copies this file to /usr/local/share/devc-features/godot/post-create.sh at image
# build time and bakes the Feature's two options into the two assignments below; the manifest's
# `postCreateCommand` names that copy. The devcontainer CLI runs it **as the remote user**, and
# runs every Feature-declared postCreateCommand *before* the one the consumer's own
# devcontainer.json declares.
#
# No `godot --version` smoke check here — the binary was already proven to run at build time
# (install.sh's own summary line would have failed the build otherwise); create time is for the
# mount, not for re-verifying the install.
set -e

# --- baked by install.sh from the Feature's options -------------------------------------
# Kept in `${VAR-default}`/`${VAR:-default}` form here so this file is readable and runnable
# straight out of the repo. install.sh rewrites each of these two lines to the configured
# literal and fails the build if a rewrite does not take, so a rename here cannot silently
# un-wire an option.
#
# PROJECT_DIR uses `${VAR-default}`, not `${VAR:-default}`: an explicitly empty projectDir means
# the workspace root and must not fall back to anything.
PROJECT_DIR="${PROJECT_DIR-}"
FIX_GODOT_DIR_OWNERSHIP="${FIX_GODOT_DIR_OWNERSHIP:-true}"
# ------------------------------------------------------------------------------------------

# PROJECT_PATH is devc's remoteEnv naming the container-side workspace root, node-nvmrc's own
# fallback. A non-devc consumer has no such variable, so $PWD carries the weight: the
# devcontainer CLI runs every lifecycle hook — Feature-declared ones included — with cwd set to
# the remote workspace folder.
cd "${PROJECT_PATH:-$PWD}"
TARGET="${PROJECT_DIR:-.}"

# This Feature's manifest declares a .godot volume at ${containerWorkspaceFolder}/.godot — the
# workspace root, and only ever the workspace root. A Feature option cannot substitute into that
# Feature's own `mounts` (see node-nvmrc's own projectDir for why), so the declared target
# cannot follow PROJECT_DIR the way a cd below would.
if [ -n "$PROJECT_DIR" ]; then
  echo "godot: projectDir is set to '$PROJECT_DIR', but the .godot volume this Feature" >&2
  echo "godot: declares cannot follow it — it always mounts at the workspace root. Add:" >&2
  echo '  "mounts": ["type=volume,source=godot-project-cache-${devcontainerId},target=${containerWorkspaceFolder}/'"$PROJECT_DIR"'/.godot"]' >&2
  echo "godot: to your own devcontainer.json, or move the project to the workspace root." >&2
else
  # Best-effort exactly like node-nvmrc's node_modules chown: bounded to .godot, never the
  # workspace itself, sudo -n so it cannot hang, never fails the create.
  [ "$FIX_GODOT_DIR_OWNERSHIP" = true ] && [ -d "$TARGET/.godot" ] &&
    command -v sudo >/dev/null 2>&1 &&
    sudo -n chown -R "$(id -u):$(id -g)" "$TARGET/.godot" 2>/dev/null || true
fi
