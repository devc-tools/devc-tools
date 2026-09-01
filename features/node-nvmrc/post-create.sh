#!/bin/sh
# node-nvmrc create-time step — install the Node version this project pins in .nvmrc, and point
# this Feature's PATH symlink at it.
#
# install.sh copies this file to /usr/local/share/devc-features/node-nvmrc/post-create.sh at
# image build time and bakes the Feature's options into the five assignments below; the
# manifest's `postCreateCommand` names that copy. The devcontainer CLI runs it **as the remote
# user**, and runs every Feature-declared postCreateCommand *before* the one the consumer's own
# devcontainer.json declares.
#
# Why create time rather than build time: the workspace is not mounted while the image builds,
# so there is no .nvmrc to read then — and the node_modules repair below needs whatever is
# mounted there to actually be mounted. Nothing here assumes a `vscode` user, a passwordless
# `sudo`, or that nvm exists at all.
#
# The symlink this writes is $SHARE_DIR/pin/bin, **not** $NVM_DIR/current. They are both "the
# symlink" and they are not interchangeable: nvm's is container-global and is rewritten by *any*
# `nvm use` in *any* shell, while this one is moved only by this script. The manifest's
# containerEnv puts pin/bin ahead of $NVM_DIR/current on PATH precisely so a human's `nvm use`
# in one terminal cannot repoint Node for every other process in the container.
set -e

die() {
  echo "node-nvmrc: $*" >&2
  exit 1
}

# --- baked by install.sh from the Feature's options -------------------------------------
# Kept in `${VAR:-default}` form here so this file is readable and runnable straight out of
# the repo. install.sh rewrites each of these five lines to the configured literal and fails
# the build if a rewrite does not take, so a rename here cannot silently un-wire an option.
#
# PROJECT_DIR uses `${VAR-default}`, not `${VAR:-default}`: an explicitly empty projectDir means
# the workspace root and must not fall back to anything.
NVM_DIR="${NVM_DIR:-/usr/local/share/nvm}"
PROJECT_DIR="${PROJECT_DIR-}"
INSTALL_ON_CREATE="${INSTALL_ON_CREATE:-true}"
FIX_NODE_MODULES_OWNERSHIP="${FIX_NODE_MODULES_OWNERSHIP:-true}"
SHARE_DIR="${SHARE_DIR:-/usr/local/share/devc-features/node-nvmrc}"
# ----------------------------------------------------------------------------------------

[ "$INSTALL_ON_CREATE" = true ] || exit 0

# PROJECT_PATH is devc's remoteEnv naming the container-side workspace root. A non-devc
# consumer has no such variable, so the fallback carries the weight: the devcontainer CLI runs
# every lifecycle hook — Feature-declared ones included — with cwd set to the remote workspace
# folder, falling back to the remote user's home when there is none. Both spellings therefore
# land on the workspace.
#
# The workspace root is used for nothing but resolving a relative projectDir. $TARGET is the
# only directory ever entered, and the two are identical whenever projectDir is left alone.
WORKSPACE="${PROJECT_PATH:-$PWD}"

# Absolute is used as-is; anything else is workspace-relative; empty is the root.
case "$PROJECT_DIR" in
  '') TARGET="$WORKSPACE" ;;
  /*) TARGET="$PROJECT_DIR" ;;
  *) TARGET="$WORKSPACE/$PROJECT_DIR" ;;
esac

# This Feature's manifest declares a node_modules volume at ${containerWorkspaceFolder}/node_modules
# — the workspace root, and only ever the workspace root. A Feature option cannot substitute into
# that Feature's own `mounts` (the literal `${projectDir}` would reach Docker and be rejected),
# so the declared target cannot follow PROJECT_DIR the way the cd below does.
#
# The consequence is worth saying out loud rather than leaving to be discovered: with projectDir
# set, the declared volume sits at the workspace root where nothing writes, and the project's own
# node_modules is an ordinary directory that does not survive a rebuild. Only the explicitly-set
# case warns — the empty default is the case the declaration is exactly right for.
if [ -n "$PROJECT_DIR" ]; then
  echo "node-nvmrc: this Feature declares a node_modules volume at the workspace root," >&2
  echo "node-nvmrc: but projectDir is '$PROJECT_DIR', so your project's node_modules is at" >&2
  echo "node-nvmrc: $TARGET/node_modules and is NOT backed by it. Add to your mounts:" >&2
  echo "node-nvmrc:   type=volume,source=node-modules-\${devcontainerId},target=$TARGET/node_modules" >&2
fi

# A projectDir that does not exist is a misconfiguration, not a reason to make the container
# uncreatable — same grading as the missing-nvm path below.
cd "$TARGET" 2> /dev/null || {
  echo "node-nvmrc: projectDir '$PROJECT_DIR' does not exist under $WORKSPACE." >&2
  exit 0
}

# No .nvmrc is success, not a skip-with-noise. This Feature is meant to be safe to leave
# enabled in a repo that pins nothing, which is the whole reason it is a one-line opt-in — so
# the *default* location misses silently. A miss under an explicitly named projectDir warns
# instead: the consumer asked for a directory, and silence would send them hunting for where
# Node came from.
#
# This check is load-bearing, not defensive. `nvm install` with no arguments walks *up*
# the tree (nvm_find_nvmrc → nvm_find_up), so with projectDir naming a subdirectory that has no
# .nvmrc, nvm would silently fall back to the workspace root's — the option would appear to work
# while pinning something else entirely.
if [ ! -f .nvmrc ]; then
  [ -z "$PROJECT_DIR" ] || echo "node-nvmrc: no .nvmrc in $PWD — nothing pinned." >&2
  exit 0
fi

# A missing nvm warns rather than fails. The prerequisite is documented, but failing create
# over it turns a misconfiguration into a container that cannot be opened at all — and the
# consumer still gets a message naming the directory that was searched. No symlink is created,
# so the PATH entry stays inert.
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "node-nvmrc: $PWD/.nvmrc found, but there is no nvm at $NVM_DIR." >&2
  echo "node-nvmrc: add a Feature that provides one (ghcr.io/devcontainers/features/node)," >&2
  echo "node-nvmrc: or set this Feature's 'nvmDir' option. Nothing was installed." >&2
  exit 0
fi

export NVM_DIR
# shellcheck source=/dev/null
. "$NVM_DIR/nvm.sh"

# A named volume mounted at node_modules first comes up root-owned — after which an `npm ci` as
# the remote user cannot write into it. That volume is this Feature's own declaration in the
# normal case, and the repair is portable to anyone who mounts one there themselves.
#
# Deliberately narrow. Only node_modules, only when it already exists, never the workspace
# itself. `sudo -n` because an image whose sudo wants a password would otherwise hang create
# forever on a prompt nobody can answer; `id -u`/`id -g` because whoever this hook runs as is
# the right owner.
#
# It follows projectDir, because the cwd does: the volume belongs where the project is. A
# consumer who sets projectDir and leaves a volume mounted at the workspace root gets nothing
# repaired there — one README line, deliberately not a second option and not two chown targets.
if [ "$FIX_NODE_MODULES_OWNERSHIP" = true ] && [ -d node_modules ] &&
  command -v sudo > /dev/null 2>&1; then
  sudo -n chown -R "$(id -u):$(id -g)" ./node_modules 2> /dev/null || true
fi

# Fatal on purpose, unlike everything above: the .nvmrc asked for a version that could not be
# installed, and a container that silently comes up on the wrong Node is worse than one that
# fails while the consumer is still watching the log.
#
# No arguments, so nvm's own parser reads .nvmrc — it accepts comments and key=value lines, and
# reimplementing that here would drift from it. Nothing in this Feature parses .nvmrc.
nvm install

# `nvm install` runs `nvm use` implicitly, which exports NVM_BIN as the installed version's bin
# directory outright — so no version string is ever extracted here.
[ -n "${NVM_BIN:-}" ] || die 'nvm install succeeded but NVM_BIN is unset'

# Ownership repair: install.sh chowns $SHARE_DIR/pin to $_REMOTE_USER at *build* time, but the
# devcontainer CLI's default UID remap — on, in practice, any Linux host whose UID differs from
# the image's baked-in one — renumbers the remote user's UID *after* the image is built, and
# chowns only $HOME doing it. That orphans $SHARE_DIR/pin from the renumbered user, and the
# ln -sfn below would fail with a permission error.
#
# sudo -n, matching the node_modules repair above: an image whose sudo wants a password must not
# hang create on a prompt nobody can answer.
owner="$(stat -c '%U' "$SHARE_DIR/pin" 2> /dev/null || true)"
if [ -n "$owner" ] && [ "$owner" != "$(id -un)" ] && command -v sudo > /dev/null 2>&1; then
  sudo -n chown "$(id -un)" "$SHARE_DIR/pin" 2> /dev/null ||
    echo "node-nvmrc: $SHARE_DIR/pin is owned by $owner and could not be repaired" >&2
fi

# -n is required, not stylistic: without it a second run resolves the existing
# symlink-to-a-directory and creates pin/bin/bin instead of replacing pin/bin.
ln -sfn "$NVM_BIN" "$SHARE_DIR/pin/bin"
echo "node-nvmrc: $SHARE_DIR/pin/bin -> $NVM_BIN"

# nvm does not move its `default` alias on install (nvm_ensure_default_set writes it only when
# none exists, and the node Feature already wrote one), so without this the pin lives nowhere in
# nvm's own state. Best-effort: the PATH entry is authoritative and this only keeps nvm from
# disagreeing with it, so it must not be able to fail the create.
nvm alias default "$(nvm current)" > /dev/null 2>&1 ||
  echo "node-nvmrc: could not set nvm's default alias; PATH still names the pinned version" >&2
