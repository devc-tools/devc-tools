#!/bin/sh
# git-container-config create-time step — re-apply the user-scope git settings a devcontainer
# needs and cannot keep.
#
# install.sh copies this file to /usr/local/share/devc-features/git-container-config/post-create.sh
# at image build time and bakes the Feature's four behavior-switch options into the assignments
# below; the manifest's `postCreateCommand` names that copy. The devcontainer CLI runs it **as
# the remote user**, which is the entire point: `git config --global` writes $HOME/.gitconfig,
# and running this as root (as a git-lfs Feature's own postCreateCommand does) would write
# /root/.gitconfig instead, which the remote user never sees.
#
# Why every create, not just the first: ~/.gitconfig is container-local and wiped on every
# rebuild, while the repo's working tree and .git are host bind mounts — so anything git needs
# at *user* scope has to be re-applied every time the container is (re)created.
#
# Order is a correctness requirement, not a style choice: the identity include runs FIRST so the
# container-mandated settings below it win over anything the identity file carries, on the
# principle that a devcontainer's own requirements (worktree paths, safe.directory) must never
# be overridable by whatever happens to be in a mounted identity file.
#
# Nothing here assumes a `vscode` user or that any mount exists at all.
#
# The script must exit 0 in every path except a genuine `git config` failure: a
# postCreateCommand that fails aborts container creation, and none of the warnings below is
# worth an unbootable container.
set -e

warn() {
  echo "git-container-config: $*" >&2
}

# --- baked by install.sh from the Feature's options -------------------------------------
# Kept in `${VAR:-default}` / `${VAR-default}` form here so this file is readable and runnable
# straight out of the repo. install.sh rewrites each of these four lines to the configured
# literal and fails the build if a rewrite does not take, so a rename here cannot silently
# un-wire an option.
#
# SAFE_DIRECTORY uses `${VAR-default}`, not `${VAR:-default}`: an explicitly empty value
# disables that setting entirely (no safe.directory at all) and must not fall back to a
# non-empty default.
LFS_FILTERS="${LFS_FILTERS:-true}"
LFS_SKIP_SMUDGE="${LFS_SKIP_SMUDGE:-true}"
WORKTREE_RELATIVE_PATHS="${WORKTREE_RELATIVE_PATHS:-true}"
SAFE_DIRECTORY="${SAFE_DIRECTORY-*}"
# ----------------------------------------------------------------------------------------

# --- 1. per-user identity -----------------------------------------------------------------
# Included FIRST so the container-mandated settings below override anything it carries. The
# Feature never reads, parses or validates this file's contents — it only names it; producing
# it is entirely the consumer's job (see README.md for the initializeCommand + mount recipe).
#
# Fixed mount point, not an option: a consumer bind-mounts their own identity file onto it, and
# "nothing mounted" is a genuinely absent file rather than an option pointing nowhere — so no
# include.path is written at all, instead of one pointing at an empty file.
IDENTITY_INCLUDE_PATH=/usr/local/share/devc-features/git-container-config/identity/gitconfig

if [ -f "$IDENTITY_INCLUDE_PATH" ]; then
  git config --global --replace-all include.path "$IDENTITY_INCLUDE_PATH"
fi

# Warn on the *effective* identity rather than on the mount, since the mounted file may also
# exist but be empty — the host itself had no identity configured. No scope flag: `git config
# --global --get` does not follow include.path, so it would report nothing even on a correctly
# configured setup.
if [ -z "$(git config --get user.email || true)" ] ||
  [ -z "$(git config --get user.name || true)" ]; then
  warn "no git identity found; set user.name/user.email to commit"
fi

# --- 2. LFS filters ------------------------------------------------------------------------
if [ "$LFS_FILTERS" = true ]; then
  if ! command -v git-lfs > /dev/null 2>&1; then
    warn "git-lfs not on PATH; skipping LFS filter setup"
  else
    # A git-lfs Feature runs `git lfs install` at build time as root, so the filters land in
    # /root/.gitconfig and the remote user never sees them. Its own postCreate script would
    # configure them for the right user, but only when autoPull=true, which is not wanted here.
    # Without these filters, git compares materialized LFS binaries against their pointer blobs
    # and reports every LFS asset as modified.
    #
    #   --skip-repo    leave .git/hooks and the repo config alone; they are host-shared and
    #                  already correct, so rewriting them churns the host's state.
    #   --force        take ownership of the filter values, so container behavior does not
    #                  depend on what the host happens to have configured.
    #   --skip-smudge  don't materialize LFS objects on checkout (only when lfsSkipSmudge is
    #                  true). Most work does not need them, and checkouts stay fast. Run
    #                  `git lfs pull` (all) or `git lfs checkout -- <path>` (targeted) when you
    #                  do. The clean filter stays active either way, so materialized files still
    #                  read as unmodified.
    if [ "$LFS_SKIP_SMUDGE" = true ]; then
      git lfs install --force --skip-repo --skip-smudge
    else
      git lfs install --force --skip-repo
    fi
  fi
fi

# --- 3. worktree links -----------------------------------------------------------------------
# Worktree links must stay relative: absolute paths differ between host (/Users/...) and
# container (/workspaces/...). Without this, a `git worktree add` run inside the container
# writes container-absolute paths the host cannot resolve — corrupting a .git both sides share.
if [ "$WORKTREE_RELATIVE_PATHS" = true ]; then
  git config --global worktree.useRelativePaths true
fi

# --- 4. safe.directory -----------------------------------------------------------------------
# The workspace binds in and can present a different owner than the container user, making git
# refuse to operate ("detected dubious ownership"). Empty disables the setting entirely, so a
# consumer who wants git's default behavior back can ask for it.
if [ -n "$SAFE_DIRECTORY" ]; then
  git config --global --replace-all safe.directory "$SAFE_DIRECTORY"
fi
