#!/bin/sh
# git-container-config Feature install — place the create-time script with the option values
# baked in.
#
# Runs as root at image *build* time, and its whole job is to put a file somewhere. It must not
# run any `git config` itself: `git config --global` writes into $HOME/.gitconfig, and at build
# time that HOME is root's — writing here would land the whole bug class this Feature exists to
# fix (settings in /root/.gitconfig instead of the remote user's). Everything that touches git
# config happens in post-create.sh, which the manifest's postCreateCommand runs **as the remote
# user** at create time.
#
# Nothing here assumes a `vscode` user, that any identity file exists, or that anything is
# mounted at all.
set -e

die() {
  echo "git-container-config: $*" >&2
  exit 1
}

# Options reach install.sh uppercased with non-word characters stripped (the CLI's getSafeId),
# and booleans arrive as the strings "true"/"false". The defaults are repeated here rather than
# trusted from the manifest so the script also runs standalone.
#
# `${VAR-default}` rather than `${VAR:-default}` for the string option: an explicitly empty
# value means something different from "unset" — safeDirectory disables the setting entirely —
# and must not fall back to a non-empty default.
LFS_FILTERS_OPT="${LFSFILTERS:-true}"
LFS_SKIP_SMUDGE_OPT="${LFSSKIPSMUDGE:-true}"
WORKTREE_RELATIVE_PATHS_OPT="${WORKTREERELATIVEPATHS:-true}"
SAFE_DIRECTORY_OPT="${SAFEDIRECTORY-*}"

# The string option is pasted into a double-quoted shell assignment in post-create.sh, so
# anything that could end that string, start an expansion or add a line is rejected outright
# rather than silently producing a script that does something else. This is a git safe.directory
# pattern; none of this is a real restriction.
check_opt() { # check_opt <option name> <value>
  case "$2" in
    *'"'*) die "$1 may not contain a double quote: $2" ;;
    *'`'*) die "$1 may not contain a backtick: $2" ;;
    *'$'*) die "$1 may not contain a dollar sign: $2" ;;
    *'\'*) die "$1 may not contain a backslash: $2" ;;
    # A literal newline, which would turn the rest of the value into its own line of shell.
    *'
'*) die "$1 may not contain a newline: $2" ;;
  esac
}
check_opt safeDirectory "$SAFE_DIRECTORY_OPT"

# /usr/local/share/devc-features/<id>/ is the Feature namespace, kept separate from devc's own
# /usr/local/share/devc/ so "did devc put this here, or a Feature?" stays answerable.
# Overridable for the test harness.
SHARE_DIR="${SHARE_DIR:-/usr/local/share/devc-features/git-container-config}"

FEATURE_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- the create-time script -------------------------------------------------------------
#
# The manifest's postCreateCommand takes no arguments, so the options have to cross into
# post-create.sh at build time. They are baked by rewriting its `VAR="${VAR:-default}"` lines,
# which keeps the file in the repo readable and runnable on its own.

bake() { # bake <file> <var> <value>
  _bake_tmp="$1.bake.$$"
  # awk with the replacement passed as a -v value, rather than sed: a `&` in a value is a
  # back-reference in a sed replacement and a `|` would end the expression.
  awk -v var="$2" -v line="$2=\"$3\"" '
    index($0, var "=") == 1 { print line; next }
                            { print }
  ' "$1" > "$_bake_tmp"
  mv -f "$_bake_tmp" "$1"
  # A rename or a reformat upstream would otherwise leave the option silently unwired, with the
  # `${VAR:-default}` fallback quietly standing in for whatever the consumer asked for.
  # -qxF, not -q: the pattern is built from the same value, so a regex metacharacter in it must
  # not be able to make a failed bake look like a successful one.
  grep -qxF "$2=\"$3\"" "$1" || die "could not bake $2 into $(basename "$1")"
}

mkdir -p "$SHARE_DIR"

# identity/ stays root-owned and is never written to by this Feature: a consumer bind-mounts
# their own identity file onto identity/gitconfig, read-only, and post-create.sh only ever
# reads it. Left empty when nobody mounts anything, which is the bare `{}` case.
mkdir -p "$SHARE_DIR/identity"

# Plain cp rather than `install -o root`: this runs as root, so the copy is root-owned either
# way, and no ownership flag means the script still runs unprivileged in the test harness.
cp "$FEATURE_DIR/post-create.sh" "$SHARE_DIR/post-create.sh"
bake "$SHARE_DIR/post-create.sh" LFS_FILTERS "$LFS_FILTERS_OPT"
bake "$SHARE_DIR/post-create.sh" LFS_SKIP_SMUDGE "$LFS_SKIP_SMUDGE_OPT"
bake "$SHARE_DIR/post-create.sh" WORKTREE_RELATIVE_PATHS "$WORKTREE_RELATIVE_PATHS_OPT"
bake "$SHARE_DIR/post-create.sh" SAFE_DIRECTORY "$SAFE_DIRECTORY_OPT"
chmod 0755 "$SHARE_DIR/post-create.sh"

echo "git-container-config: create-time script installed at $SHARE_DIR/post-create.sh"
echo "git-container-config: lfsFilters=$LFS_FILTERS_OPT lfsSkipSmudge=$LFS_SKIP_SMUDGE_OPT" \
  "worktreeRelativePaths=$WORKTREE_RELATIVE_PATHS_OPT safeDirectory='$SAFE_DIRECTORY_OPT'"
