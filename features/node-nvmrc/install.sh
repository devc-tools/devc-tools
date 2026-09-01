#!/bin/sh
# node-nvmrc Feature install — place the create-time script and the directory this Feature's
# containerEnv puts on PATH.
#
# Runs as root at image *build* time, and its whole job is to put files somewhere. It must not
# touch nvm: the workspace is not mounted yet, so there is no .nvmrc to read, and nvm itself may
# be installed by a Feature ordered after this one on some other consumer's config. Everything
# that needs either of those things happens in post-create.sh.
#
# Nothing is appended to any startup file. The Feature reaches every process through a static
# `containerEnv` PATH entry naming $SHARE_DIR/pin/bin, which post-create.sh points at the pinned
# version — so nothing depends on a shell being interactive, being bash, or existing at all.
#
# Nothing here assumes a `vscode` user, a PROJECT_PATH, or a `sudo`.
set -e

die() {
  echo "node-nvmrc: $*" >&2
  exit 1
}

# Options reach install.sh uppercased with non-word characters stripped (the CLI's getSafeId),
# and booleans arrive as the strings "true"/"false". The defaults are repeated here rather than
# trusted from the manifest so the script also runs standalone; /usr/local/share/nvm is where
# ghcr.io/devcontainers/features/node puts nvm, not a devc invention.
#
# `${VAR-default}` rather than `${VAR:-default}` for projectDir: an explicitly empty value means
# the workspace root and must not fall back to anything.
NVM_DIR_OPT="${NVMDIR:-/usr/local/share/nvm}"
PROJECT_DIR_OPT="${PROJECTDIR-}"
INSTALL_ON_CREATE="${INSTALLONCREATE:-true}"
FIX_NODE_MODULES_OWNERSHIP="${FIXNODEMODULESOWNERSHIP:-true}"

# Both path options are pasted into a double-quoted shell assignment in post-create.sh, so
# anything that could end that string, start an expansion or add a line is rejected outright
# rather than silently producing a script that does something else. Without this,
# nvmDir='/opt/n"; touch /tmp/PWNED; :"' bakes to a line that runs that command *and passes the
# verify grep*, because the grep is built from the same unescaped value. These are container
# paths; none of it is a real restriction.
check_path_opt() { # check_path_opt <option name> <value>
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
check_path_opt nvmDir "$NVM_DIR_OPT"
check_path_opt projectDir "$PROJECT_DIR_OPT"

# /usr/local/share/devc-features/<id>/ is the Feature namespace, kept separate from devc's own
# /usr/local/share/devc/ so "did devc put this here, or a Feature?" stays answerable.
# Overridable for the test harness.
#
# This literal also appears in the manifest twice (containerEnv's PATH entry and the
# postCreateCommand) and in post-create.sh's own default. Four places, one path — see
# features/CONTRIBUTING.md before renaming it.
SHARE_DIR="${SHARE_DIR:-/usr/local/share/devc-features/node-nvmrc}"

FEATURE_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- the create-time script -------------------------------------------------------------
#
# The manifest's postCreateCommand takes no arguments, so the options have to cross into
# post-create.sh at build time. They are baked by rewriting its `VAR="${VAR:-default}"` lines,
# which keeps the file in the repo readable and runnable on its own.

bake() { # bake <file> <var> <value>
  _bake_tmp="$1.bake.$$"
  # awk with the replacement passed as a -v value, rather than sed: a `&` in a path is a
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
# Plain cp rather than `install -o root`: this runs as root, so the copy is root-owned either
# way, and no ownership flag means the script still runs unprivileged in the test harness.
cp "$FEATURE_DIR/post-create.sh" "$SHARE_DIR/post-create.sh"
bake "$SHARE_DIR/post-create.sh" NVM_DIR "$NVM_DIR_OPT"
bake "$SHARE_DIR/post-create.sh" PROJECT_DIR "$PROJECT_DIR_OPT"
bake "$SHARE_DIR/post-create.sh" INSTALL_ON_CREATE "$INSTALL_ON_CREATE"
bake "$SHARE_DIR/post-create.sh" FIX_NODE_MODULES_OWNERSHIP "$FIX_NODE_MODULES_OWNERSHIP"
# The hook cannot discover where it was installed (the manifest calls it by absolute path), so
# the directory it creates the symlink under is baked too.
bake "$SHARE_DIR/post-create.sh" SHARE_DIR "$SHARE_DIR"
chmod 0755 "$SHARE_DIR/post-create.sh"

echo "node-nvmrc: create-time script installed at $SHARE_DIR/post-create.sh"

# --- the directory on PATH ------------------------------------------------------------------
#
# pin/bin is the symlink the create-time hook points at the pinned version's bin directory, and
# pin/ is what the manifest's containerEnv puts on PATH. It is created empty here and stays that
# way whenever there is nothing to pin: a PATH entry naming a directory that does not exist is
# silently skipped by every shell and by execvp, so lookup falls through to whatever else
# provides node. That is what keeps this Feature safe to leave enabled in a repo pinning nothing.
#
# A separate, user-owned subdirectory rather than chowning $SHARE_DIR itself: the create-time
# hook runs unprivileged and has to create a symlink under a root-owned /usr/local/share, while
# post-create.sh must stay root-owned. A non-recursive chown of one subdirectory satisfies both.
#
# Not named current/. $NVM_DIR/current is nvm's own container-global symlink, rewritten by *any*
# `nvm use` in *any* shell; this one is moved only by this Feature's create-time hook. Two
# symlinks with the same name would make "fix the symlink" a coin flip.
mkdir -p "$SHARE_DIR/pin"
if [ -n "${_REMOTE_USER:-}" ]; then
  chown "$_REMOTE_USER" "$SHARE_DIR/pin" 2> /dev/null || true
fi

echo "node-nvmrc: PATH entry is $SHARE_DIR/pin/bin (NVM_DIR=$NVM_DIR_OPT," \
  "projectDir='$PROJECT_DIR_OPT')"
