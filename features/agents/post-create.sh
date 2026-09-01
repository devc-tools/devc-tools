#!/bin/bash
# agents create-time step — links the host config seed into ~/.claude, and folds ~/.claude.json
# into ~/.claude so one volume captures all of Claude Code's state.
#
# install.sh copies this file to /usr/local/share/devc-features/agents/post-create.sh at image
# build time; the manifest's postCreateCommand names that copy, and the devcontainer CLI runs it
# as the remote user, before any user postCreateCommand. Running as the remote user is what makes
# $HOME the right base for both paths below — there is nothing for install.sh to bake in.
#
# Copied from devc-core/default/scripts/agents-setup.sh — see README.md's "Relationship to devc"
# for which file is which. The devc:seed-link block below is copied verbatim from that file: only
# its two parameterizing assignments (SEED and CLAUDE_DIR) differ, so
# devc/tests/seed_link_test.sh runs against both copies unmodified.
#
# The script must exit 0 on every skip path: a postCreateCommand that fails aborts container
# creation, and none of the skips here (an empty seed, ownership already correct) is worth an
# unbootable container.
set -e

warn() {
  echo "agents: $*" >&2
}

# --- 0. declared-volume home check ----------------------------------------------------------
# This Feature's manifest declares a named volume at DECLARED_CLAUDE_DIR — a literal path,
# because no devcontainer.json substitution variable names the remote user's home. Measured, not
# assumed: `${containerEnv:HOME}` does not substitute inside a Feature's own `mounts` (Docker is
# handed the literal string and refuses the mount outright). See
# .plans/implemented/declared-volume-spike.md, M1.
#
# So on an image whose remote user is not `vscode`, the volume is mounted somewhere Claude Code
# never reads, and this user's ~/.claude is an ordinary directory that does not survive a
# rebuild. Nothing here can fix that — a mount target cannot be chosen at create time — so it
# warns and names the one-line fix.
#
# Warn, never fail: exit 0 on every skip path is this script's rule (see the header), and a
# wrong-home warning is emphatically not worth an uncreatable container.
DECLARED_CLAUDE_DIR=/home/vscode/.claude

if [ "$HOME/.claude" != "$DECLARED_CLAUDE_DIR" ]; then
  warn "this Feature declares its ~/.claude volume at $DECLARED_CLAUDE_DIR, but your home is $HOME."
  warn "$HOME/.claude is therefore NOT backed by that volume and will not survive a rebuild."
  warn "add this to your devcontainer.json's mounts to fix it:"
  warn "  type=volume,source=claude-code-config-\${devcontainerId},target=$HOME/.claude"
fi

# --- 1. ownership repair -------------------------------------------------------------------
# Belt-and-braces: install.sh already pre-creates ~/.claude owned by the remote user at build
# time, and whether a first-use empty named volume mounted over it at create time inherits that
# ownership is unmeasured (no Docker in the environment this Feature was written in — see
# .plans/design/devc-feature-split.md, open question 3). Cheap either way, so it stays.
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

# devc:seed-link (start) — devc/tests/seed_link_test.sh runs everything between these two
# markers against temp dirs, so keep the block self-contained (parameterized only by
# SEED and CLAUDE_DIR; no sudo, no paths outside them).
#
# ~/.claude host config seed. Every top-level *file* in the read-only seed bind mount is
# symlinked into the .claude volume, so host edits are live and host file modes (e.g. the
# statusline exec bit) are preserved. Directories are ignored by design: the devc:skills
# fence mounts per-skill binds under ~/.claude/skills/, and Docker has already materialized
# that directory by the time this runs — linking over it would either produce a nested
# skills/skills or fail on a busy mountpoint.
#
# Runs on every container create, so additions, edits, and deletions on the host all take
# effect without deleting the volume.
SEED=/usr/local/share/devc-features/agents/claude-seed
CLAUDE_DIR="$HOME/.claude"

# Drop links a previous create made whose seed file has since been removed or renamed. Only
# symlinks pointing into $SEED are touched, so volume state (projects/, todos/,
# .credentials.json) and the skills mountpoints are left alone. `-type l` uses lstat and
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
# "$HOME/.claude.json" when that variable is unset (verified against the CLI's own resolver).
# So it is a *sibling* of ~/.claude, not a member of it — the one piece of Claude Code state a
# volume mounted at ~/.claude would otherwise miss, and a file cannot be a volume mount target
# on its own. Symlinking it into ~/.claude is what lets a single mount capture everything;
# earlier versions of this Feature needed a second volume and a claudeJsonDir option to say
# where it was.
#
# Unconditional: there is nothing left to opt into. With no volume mounted this is an
# indirection inside one home directory, which costs nothing and keeps one code path.
# Every step below warns rather than fails. Being unconditional is exactly why: this now runs in
# every container, so a read-only ~/.claude, or a ~/.claude.json that is somehow a directory,
# would take container creation down with it. A container that boots with its auth file
# unrelocated beats one that does not boot.
mkdir -p "$CLAUDE_DIR" || warn "could not create $CLAUDE_DIR"
JSON_TARGET="$CLAUDE_DIR/.claude.json"

if [ ! -e "$JSON_TARGET" ]; then
  if [ -f "$HOME/.claude.json" ] && [ ! -L "$HOME/.claude.json" ]; then
    # A real file here is Claude Code's own earlier run, or a consumer with no volume mounted.
    # Move it rather than delete it — this step is unconditional now, so an `rm` would be data
    # loss for anyone who never asked to have their auth relocated.
    mv "$HOME/.claude.json" "$JSON_TARGET" || warn "could not move ~/.claude.json into $CLAUDE_DIR"
  else
    echo '{}' > "$JSON_TARGET" || warn "could not seed $JSON_TARGET"
  fi
fi

# Compares the link target, not just "is a symlink": a link left by an older version of this
# Feature points at some other directory entirely, and has to be repointed rather than kept.
# Guarded on the target existing, so a failed seed above leaves ~/.claude.json as it was rather
# than replacing it with a dangling link.
# The directory case is checked first and explicitly: `ln -sfn` given a real directory does not
# fail, it silently creates the link *inside* it, which is worse than doing nothing.
if [ -d "$HOME/.claude.json" ] && [ ! -L "$HOME/.claude.json" ]; then
  warn "$HOME/.claude.json is a directory — leaving it alone"
elif [ -e "$JSON_TARGET" ] && [ "$(readlink "$HOME/.claude.json" 2> /dev/null)" != "$JSON_TARGET" ]; then
  rm -f "$HOME/.claude.json" 2> /dev/null || true
  ln -sfn "$JSON_TARGET" "$HOME/.claude.json" || warn "could not link ~/.claude.json"
fi
