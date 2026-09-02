#!/bin/bash
# agents create-time step — links the host config seed into ~/.claude, and folds ~/.claude.json
# into ~/.claude so one volume captures all of Claude Code's state.
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
  warn "the volume's target is /home/vscode/.claude; this container's home is $HOME."
  warn "declare the mount yourself in devcontainer.json to fix it:"
  warn "  type=volume,source=claude-code-config-\${devcontainerId},target=$HOME/.claude"
fi

# --- 1. ownership repair -------------------------------------------------------------------
# install.sh already pre-creates ~/.claude owned by the remote user, so this is normally a
# no-op. It stays because it is cheap and it also covers a volume a consumer mounted themselves.
#
# Non-recursive — a hard requirement, not a style choice: subpaths like skills/ are host bind
# mounts and must not be chowned.
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
    if [ -L "$src" ] && [ ! -e "$src" ]; then
      echo "devc: skipping $name — host symlink dangles in the container; use a real file"
      continue
    fi
    # -f follows symlinks; skips directories and anything else non-regular.
    [ -f "$src" ] || continue
    if [ -e "$dest" ] && [ ! -L "$dest" ] && [ ! -f "$dest" ]; then
      echo "devc: skipping $name — $dest exists and is not a regular file"
      continue
    fi
    if [ -f "$dest" ] && [ ! -L "$dest" ]; then
      echo "devc: replacing volume-local $name with the host seed copy"
    fi
    ln -sfn "$src" "$dest" || echo "devc: could not link $dest (bind-mounted?)"
  done < <(find "$SEED" -mindepth 1 -maxdepth 1 -print0)
fi
# devc:seed-link (end)

# --- 3. ~/.claude.json ---------------------------------------------------------------------
# Claude Code resolves its config/auth file as "$CLAUDE_CONFIG_DIR/.claude.json", falling back to
# "$HOME/.claude.json" when that variable is unset. So it is a *sibling* of ~/.claude, not a
# member of it — the one piece of Claude Code state a volume mounted at ~/.claude would
# otherwise miss, and a file cannot be a volume mount target on its own. Symlinking it into
# ~/.claude is what lets a single mount capture everything.
#
# Unconditional. With no volume mounted this is an indirection inside one home directory, which
# costs nothing and keeps one code path. Every step below warns rather than fails, precisely
# because it is unconditional: a read-only ~/.claude, or a ~/.claude.json that is somehow a
# directory, would otherwise take container creation down with it. A container that boots with
# its auth file unrelocated beats one that does not boot.
mkdir -p "$CLAUDE_DIR" || warn "could not create $CLAUDE_DIR"
JSON_TARGET="$CLAUDE_DIR/.claude.json"

if [ ! -e "$JSON_TARGET" ]; then
  if [ -f "$HOME/.claude.json" ] && [ ! -L "$HOME/.claude.json" ]; then
    # A real file here is Claude Code's own earlier run, or a consumer with no volume mounted.
    # Move it rather than delete it — this step is unconditional, so an `rm` would be data loss
    # for anyone who never asked to have their auth relocated.
    mv "$HOME/.claude.json" "$JSON_TARGET" || warn "could not move ~/.claude.json into $CLAUDE_DIR"
  else
    echo '{}' > "$JSON_TARGET" || warn "could not seed $JSON_TARGET"
  fi
fi

# Compares the link target, not just "is a symlink": a link pointing at some other directory has
# to be repointed rather than kept. Guarded on the target existing, so a failed seed above leaves
# ~/.claude.json as it was rather than replacing it with a dangling link.
# The directory case is checked first and explicitly: `ln -sfn` given a real directory does not
# fail, it silently creates the link *inside* it, which is worse than doing nothing.
if [ -d "$HOME/.claude.json" ] && [ ! -L "$HOME/.claude.json" ]; then
  warn "$HOME/.claude.json is a directory — leaving it alone"
elif [ -e "$JSON_TARGET" ] && [ "$(readlink "$HOME/.claude.json" 2> /dev/null)" != "$JSON_TARGET" ]; then
  rm -f "$HOME/.claude.json" 2> /dev/null || true
  ln -sfn "$JSON_TARGET" "$HOME/.claude.json" || warn "could not link ~/.claude.json"
fi
