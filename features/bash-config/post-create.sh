#!/bin/sh
# bash-config create-time step — point dirs/project at this workspace, and record the workspace
# path in dirs/env.sh.
#
# install.sh runs at image *build* time, where the workspace is not mounted and its path is
# unknowable. A lifecycle hook runs at *create* time, and the devcontainer CLI hands every
# lifecycle hook the workspace folder as its cwd — so the path is simply there, once, and
# $PROJECT_PATH becomes an override rather than a prerequisite. The CLI runs this **as the
# remote user**, and runs Feature-declared postCreateCommands before the consumer's own.
#
# The two things it writes are the only configuration in this Feature that is not a constant,
# and neither is a rewrite of anything: the project directory is a **symlink** (a symlinked
# directory globs live, so the workspace stays the source of truth and an edit after create is
# picked up by the next shell), and env.sh is a whole file, written fresh. Nothing here touches
# ~/.bashrc or init.sh — those are static by construction.
set -e

# Same default as install.sh's, so this file is readable and runnable straight out of the repo.
SHARE_DIR="${SHARE_DIR:-/usr/local/share/devc-features/bash-config}"
DIRS="$SHARE_DIR/dirs"

# `${VAR-default}`, not `${VAR:-default}`: config.sh setting PROJECT_DIR="" is the consumer
# explicitly asking for no project symlink, and must not fall back to the default. A missing
# config.sh means this script was run outside an install, not that the option is empty.
if [ -r "$SHARE_DIR/config.sh" ]; then
  # shellcheck source=/dev/null
  . "$SHARE_DIR/config.sh"
fi
PROJECT_DIR="${PROJECT_DIR-.devcontainer/shell}"

# The workspace, or nothing. runLifecycleHook computes one cwd for every lifecycle command:
#
#   remoteCwd = containerProperties.remoteWorkspaceFolder || containerProperties.homeFolder
#
# so an unset PROJECT_PATH *and* a cwd equal to the home folder is precisely the branch where
# there was no workspace folder to be given. Treating $HOME as the workspace there would link
# the project directory at ~/.devcontainer/shell and export a PROJECT_PATH of $HOME, both of
# which are worse than doing nothing.
WS=''
if [ -n "${PROJECT_PATH:-}" ]; then
  WS="$PROJECT_PATH"
elif [ "$PWD" != "$HOME" ]; then
  WS="$PWD"
fi

mkdir -p "$DIRS"

# --- ownership repair -----------------------------------------------------------------------
# install.sh already chowns $DIRS to $_REMOTE_USER at *build* time, but the devcontainer CLI's
# default UID remap — on, in practice, any Linux host whose UID differs from the image's
# baked-in one — renumbers the remote user's UID *after* the image is built, and chowns only
# $HOME doing it. That orphans $DIRS from the renumbered user, and the `ln -sfn` below would
# fail with a permission error.
#
# Non-recursive: dirs/user may already carry a host bind mount, which must not be chowned.
owner="$(stat -c '%U' "$DIRS" 2> /dev/null || true)"
if [ -n "$owner" ] && [ "$owner" != "$(id -un)" ]; then
  if command -v sudo > /dev/null 2>&1; then
    sudo chown "$(id -un)" "$DIRS" || echo "bash-config: could not chown $DIRS" >&2
  else
    echo "bash-config: $DIRS is owned by $owner and no sudo is available to fix it" >&2
  fi
fi

# --- dirs/project ---------------------------------------------------------------------------

case "$PROJECT_DIR" in
  '')
    # The layer is switched off. Remove rather than leave, so flipping the option off in a
    # rebuilt container actually takes effect instead of stranding the previous symlink.
    rm -f "$DIRS/project"
    echo 'bash-config: projectDir is empty — no project directory linked'
    ;;
  /*)
    # A fixed container path. It never needed the workspace, so it is linked whether or not one
    # was found — and, like every other path here, it may not exist yet: a dangling symlink is a
    # silent no-op in init.sh, and heals the moment something creates the directory.
    ln -sfn "$PROJECT_DIR" "$DIRS/project"
    echo "bash-config: project directory linked to $PROJECT_DIR"
    ;;
  *)
    if [ -n "$WS" ]; then
      ln -sfn "$WS/$PROJECT_DIR" "$DIRS/project"
      echo "bash-config: project directory linked to $WS/$PROJECT_DIR"
    else
      # Decline, and say which of the two things would fix it. Exit status stays 0: a container
      # that cannot be opened is a worse outcome than a Feature that did half its job and said
      # so, and the user directory half works regardless.
      echo 'bash-config: no PROJECT_PATH, and the cwd is the home folder — this container has' >&2
      echo 'bash-config: no workspace folder, so the project directory cannot be resolved at' >&2
      echo 'bash-config: create time. Set PROJECT_PATH as remoteEnv, or give projectDir an' >&2
      echo 'bash-config: absolute container path. No project directory was linked.' >&2
    fi
    ;;
esac

# --- dirs/env.sh ----------------------------------------------------------------------------
#
# init.sh sources this before either directory, so a layer script sees PROJECT_PATH without the
# consumer having declared a remoteEnv — which is most of what a project's own scripts want to
# know. Guarded with `:-`, so a value inherited from the environment still wins: a consumer who
# already sets it as remoteEnv is not overridden by a path resolved at create time.
#
# Only when a workspace was found. With none, an unguarded export would announce a workspace
# that does not exist, and the guard would not save it — there is nothing to inherit from.
if [ -n "$WS" ]; then
  {
    cat << 'ENV_HEADER'
# bash-config — written by post-create.sh at create time, sourced by init.sh in every shell it
# reaches. Rewritten on every create; edits do not survive one.
ENV_HEADER
    printf 'export PROJECT_PATH="${PROJECT_PATH:-%s}"\n' "$WS"
  } > "$DIRS/env.sh"
  echo "bash-config: PROJECT_PATH recorded as $WS"
fi
