#!/bin/bash
# agents create-time step — optionally links the host config seed into ~/.claude (opt-in via the
# claudeSeed option; see step 2b), always links the Herdr config seed into ~/.config/herdr, then
# installs any declared pi packages and Herdr plugins.
#
# The two seeds are deliberately asymmetric. ~/.claude is a mount — the Feature's own declared
# volume, or whatever a consumer put there, possibly a bind of a real host directory — so writing
# symlinks into it is something to ask for rather than assume, and the flag exists to protect it.
# ~/.config/herdr is not a mount and holds live per-container runtime state, so binding it would
# be actively harmful and there is nothing there for a flag to protect: that half stays
# unconditional.
#
# Nothing here relocates Claude Code's config/auth file any more: the manifest's containerEnv
# sets CLAUDE_CONFIG_DIR=/home/vscode/.claude, so Claude Code writes that file inside the volume
# itself and one mount captures all of its state with no symlink involved.
#
# install.sh copies this file to /usr/local/share/devc-features/agents/post-create.sh at image
# build time; the manifest's postCreateCommand names that copy, and the devcontainer CLI runs it
# as the remote user, before any user postCreateCommand. Running as the remote user is what makes
# $HOME the right base for both paths below — there is nothing for install.sh to bake in.
#
# The script must exit 0 on every skip path: a postCreateCommand that fails aborts container
# creation, and none of the skips here (an empty seed, ownership already correct) is worth an
# unbootable container.
set -e

warn() {
  echo "agents: $*" >&2
}

# --- 0. declared-volume home check ----------------------------------------------------------
# The manifest declares a named volume at the literal /home/vscode/.claude — a literal because no
# devcontainer.json variable names the remote user's home inside a Feature's own `mounts`
# (`${containerEnv:HOME}` reaches Docker as a literal string and the mount is refused; measured,
# docs/manual-verification.md §12 M1).
#
# So on an image whose remote user is not `vscode`, the volume is mounted somewhere Claude Code
# never reads. Nothing here can fix that — a mount target cannot be chosen at create time — so it
# warns and names the one-line fix. It decides by asking the real question — is this user's
# ~/.claude actually a mount point? — rather than by comparing paths, so a consumer who declared
# the mount themselves is recognised as correct instead of reported as a mismatch.

# Is $1 the target of a mount? Prefers util-linux's mountpoint(1) and falls back to
# /proc/self/mountinfo (field 5 is the mount point) on an image that lacks it.
claude_dir_is_mounted() {
  if command -v mountpoint > /dev/null 2>&1; then
    mountpoint -q "$1"
  else
    awk -v p="$1" '$5 == p { found = 1 } END { exit !found }' /proc/self/mountinfo 2> /dev/null
  fi
}

if ! claude_dir_is_mounted "$HOME/.claude"; then
  warn "$HOME/.claude is NOT backed by this Feature's named volume, so anything Claude Code"
  warn "writes there will be lost on the next rebuild."
  warn "the volume's target is /home/vscode/.claude, and CLAUDE_CONFIG_DIR is set to that same"
  warn "literal, so Claude Code reads and writes there rather than under this container's"
  warn "home, $HOME."
  warn "point both at this home in devcontainer.json to fix it:"
  warn "  mounts: type=volume,source=claude-code-config-\${devcontainerId},target=$HOME/.claude"
  warn "  containerEnv: { \"CLAUDE_CONFIG_DIR\": \"$HOME/.claude\" }"
fi

# --- 1. ownership repair -------------------------------------------------------------------
# install.sh already pre-creates ~/.claude owned by the remote user, so this is normally a
# no-op. It stays because it is cheap and it also covers a volume a consumer mounted themselves.
#
# Non-recursive — a hard requirement, not a style choice: subpaths like skills/ are host bind
# mounts and must not be chowned.
#
# The mkdir is insurance rather than load-bearing — install.sh pre-creates the directory at
# build time and the volume mounts over it — but both the repair below and the seed-link block
# guard on `[ -d ... ]` and would silently skip if it were ever missing.
mkdir -p "$HOME/.claude" || warn "could not create $HOME/.claude"

if [ -d "$HOME/.claude" ]; then
  owner="$(stat -c '%U' "$HOME/.claude" 2> /dev/null || true)"
  if [ -n "$owner" ] && [ "$owner" != "$(id -un)" ]; then
    if command -v sudo > /dev/null 2>&1; then
      sudo chown "$(id -un)" "$HOME/.claude" || warn "could not chown $HOME/.claude"
    else
      warn "$HOME/.claude is owned by $owner and no sudo is available to fix it"
    fi
  fi
fi

# --- 2a. drop seed links a previous create left behind ----------------------------------------
# Unconditional — it runs whether or not the seed itself is enabled below, and that is the whole
# point. A container built by an older agents Feature (<= 0.5.0, when the seed was unconditional)
# comes back with symlinks in ~/.claude pointing into the seed path; with claudeSeed off and
# nothing bind-mounted onto that path those links dangle, and a dangling ~/.claude/CLAUDE.md is
# worse than no CLAUDE.md at all. The same applies to flipping the option from true back to false.
#
# This DUPLICATES roughly six lines from inside the devc:seed-link fence below. The duplication is
# deliberate — do not "deduplicate" it. The fence is extracted verbatim by
# devc/tests/seed_link_test.sh and re-pointed with `sed` on exactly two line-start assignments
# (SEED= and CLAUDE_DIR=); hoisting this out of the fence and sharing it would need a third
# parameterized variable, which breaks that harness and the contract in features/CONTRIBUTING.md.
#
# It uses $HOME/.claude and the literal seed path directly rather than $CLAUDE_DIR/$SEED: those
# two are assigned *inside* the fence and are unset whenever the guard below is false.
# devc:seed-cleanup (start)
if [ -d "$HOME/.claude" ]; then
  while IFS= read -r -d '' link; do
    case "$(readlink "$link")" in
      /usr/local/share/devc-features/agents/claude-seed/*) rm -f "$link" ;;
    esac
  done < <(find "$HOME/.claude" -mindepth 1 -maxdepth 1 -type l -print0)
fi
# devc:seed-cleanup (end)

# --- 2b. the ~/.claude seed, opt-in -----------------------------------------------------------
# install.sh writes claude-seed.conf holding the exact string `true` when claudeSeed is on, and
# `rm -f`s it otherwise, so an absent or empty file reads as false and the fence never runs. Read
# the same way pi-packages.conf/herdr-plugins.conf are read further down.
#
# The `if`/`fi` sit OUTSIDE the devc:seed-link markers and the fence body below stays
# UNINDENTED. Both are requirements, not style: devc/tests/seed_link_test.sh extracts everything
# strictly between the markers and re-points it with `sed -e 's#^SEED=...#' -e
# 's#^CLAUDE_DIR=...#'`, so an indented body would stop matching those line-start anchors and an
# `if` inside the markers would be extracted without its `fi`. An unindented `if` body is valid
# bash; leave it alone.
if [ "$(cat /usr/local/share/devc-features/agents/claude-seed.conf 2> /dev/null || true)" = true ]; then
# devc:seed-link (start) — a test harness runs everything between these two markers on its
# own, so keep the block self-contained (see features/CONTRIBUTING.md).
#
# ~/.claude host config seed. Every top-level *file* in the read-only seed bind mount is
# symlinked into the .claude volume, so host edits are live and host file modes (e.g. the
# statusline exec bit) are preserved. Directories are ignored by design: something else may
# have mounted per-skill binds under ~/.claude/skills/, and Docker has already materialized
# that directory by the time this runs — linking over it would either produce a nested
# skills/skills or fail on a busy mountpoint.
#
# Runs on every container create, so additions, edits, and deletions on the host all take
# effect without deleting the volume.
SEED=/usr/local/share/devc-features/agents/claude-seed
CLAUDE_DIR="$HOME/.claude"

# Drop links a previous create made whose seed file has since been removed or renamed. Only
# symlinks pointing into $SEED are touched, so volume state (projects/, todos/,
# .credentials.json) and any subdirectory mountpoints are left alone. `-type l` uses lstat and
# readlink still reports a target, so a now-dangling link is caught here too.
if [ -d "$CLAUDE_DIR" ]; then
  while IFS= read -r -d '' link; do
    case "$(readlink "$link")" in
      "$SEED"/*) rm -f "$link" ;;
    esac
  done < <(find "$CLAUDE_DIR" -mindepth 1 -maxdepth 1 -type l -print0)
fi

if [ -d "$SEED" ]; then
  while IFS= read -r -d '' src; do
    name="$(basename "$src")"
    dest="$CLAUDE_DIR/$name"
    # Claude Code owns these two inside CLAUDE_CONFIG_DIR (=~/.claude) and rewrites them whole.
    # The never-overwrite rule below already covers them whenever they exist, but naming them
    # gives a message that says why, and covers the window where they are momentarily absent —
    # a seed link there would be overwritten by the CLI's next write anyway.
    case "$name" in
      .claude.json | .credentials.json)
        echo "devc: skipping $name — Claude Code owns that file in ~/.claude"
        continue
        ;;
    esac
    if [ -L "$src" ] && [ ! -e "$src" ]; then
      echo "devc: skipping $name — host symlink dangles in the container; use a real file"
      continue
    fi
    # -f follows symlinks; skips directories and anything else non-regular.
    [ -f "$src" ] || continue
    # The seed creates links and replaces its own links; it never replaces a file. ~/.claude may
    # be a bind mount of a real host directory, in which case $dest is a live host file and the
    # old "replace volume-local state" behaviour destroyed it with no backup.
    if [ -e "$dest" ] && [ ! -L "$dest" ]; then
      echo "devc: skipping $name — $dest already exists and is not a link into the seed"
      continue
    fi
    ln -sfn "$src" "$dest" || echo "devc: could not link $dest (bind-mounted?)"
  done < <(find "$SEED" -mindepth 1 -maxdepth 1 -print0)
fi
# devc:seed-link (end)
fi

# --- 2c. herdr-seed -> ~/.config/herdr -----------------------------------------------------
# Same idea as the claude-seed block above — a consumer's own Herdr config.toml (the
# tab_bar_right entry a plugin's status indicator needs, say) lives on the host and gets linked
# in live — but kept as its own block, not a shared function, and not folded into the
# devc:seed-link fence above: that fence is extracted verbatim by
# devc/tests/seed_link_test.sh via `SEED=`/`CLAUDE_DIR=` sed substitution, so it has to stay
# exactly self-contained and exactly two variables. A separate block with its own two variables
# is simpler than teaching that test a third parameter.
#
# devc:herdr-seed-link (start)
HERDR_SEED=/usr/local/share/devc-features/agents/herdr-seed
HERDR_CONFIG_DIR="$HOME/.config/herdr"

mkdir -p "$HERDR_CONFIG_DIR" || warn "could not create $HERDR_CONFIG_DIR"

if [ -d "$HERDR_CONFIG_DIR" ]; then
  while IFS= read -r -d '' link; do
    case "$(readlink "$link")" in
      "$HERDR_SEED"/*) rm -f "$link" ;;
    esac
  done < <(find "$HERDR_CONFIG_DIR" -mindepth 1 -maxdepth 1 -type l -print0)
fi

if [ -d "$HERDR_SEED" ]; then
  while IFS= read -r -d '' src; do
    name="$(basename "$src")"
    dest="$HERDR_CONFIG_DIR/$name"
    if [ -L "$src" ] && [ ! -e "$src" ]; then
      echo "devc: skipping $name — host symlink dangles in the container; use a real file"
      continue
    fi
    [ -f "$src" ] || continue
    if [ -e "$dest" ] && [ ! -L "$dest" ] && [ ! -f "$dest" ]; then
      echo "devc: skipping $name — $dest exists and is not a regular file"
      continue
    fi
    if [ -f "$dest" ] && [ ! -L "$dest" ]; then
      echo "devc: replacing volume-local $name with the host seed copy"
    fi
    ln -sfn "$src" "$dest" || echo "devc: could not link $dest (bind-mounted?)"
  done < <(find "$HERDR_SEED" -mindepth 1 -maxdepth 1 -print0)
fi
# devc:herdr-seed-link (end)

# --- 4. pi packages / Herdr plugins ---------------------------------------------------------
# Deferred here from build time — see create-time-plugins.sh's own header for the full reason
# (short version: a Docker build-layer cache can silently keep serving a stale `git clone` from
# the last time the image's RUN layer actually executed; postCreateCommand has no layer to go
# stale, so it re-resolves each source's current tip on every container creation instead).
#
# install.sh persisted the raw, already-validated option strings to these two fixed files; a
# missing file (an image built by an older version of this Feature, before this moved) reads as
# empty via the `2> /dev/null` fallback, which is a no-op for both installers below — not a
# warning-worthy state, since nothing was ever promised to a container built before the option
# existed.
CREATE_TIME_PLUGINS=/usr/local/share/devc-features/agents/create-time-plugins.sh
if [ -f "$CREATE_TIME_PLUGINS" ]; then
  # shellcheck source=create-time-plugins.sh
  . "$CREATE_TIME_PLUGINS"
  install_pi_packages "$(cat /usr/local/share/devc-features/agents/pi-packages.conf 2> /dev/null || true)"
  install_herdr_plugins "$(cat /usr/local/share/devc-features/agents/herdr-plugins.conf 2> /dev/null || true)"
fi
