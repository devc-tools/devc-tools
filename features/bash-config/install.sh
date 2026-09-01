#!/bin/sh
# bash-config Feature install — place the three scripts and the two fixed directories, then
# append one static block to ~/.bashrc.
#
# Runs as root at image *build* time, and its whole job is to put files somewhere. Nothing is
# resolved here because nothing here needs resolving: the block it appends names a fixed path
# that never changes, so there is no option to substitute into it, nothing for a create-time
# hook to rewrite afterwards, and therefore no rewrite that can silently stop matching.
#
# The one option crosses into post-create.sh through config.sh, a file written here and sourced
# there — rather than by rewriting a line of post-create.sh, which would reintroduce exactly
# that class of drift.
#
# bash only. zsh and fish get nothing — deliberately unwritten rather than half-written.
set -e

die() {
  echo "bash-config: $*" >&2
  exit 1
}

# Options reach install.sh uppercased with non-word characters stripped (the CLI's getSafeId).
# `${VAR-default}` rather than `${VAR:-default}`: an explicitly empty option means "no project
# symlink" and must not fall back to the default. The default is repeated from the manifest so
# this script also runs standalone.
PROJECT_DIR_OPT="${PROJECTDIR-.devcontainer/shell}"

# The value is written into a double-quoted shell assignment in config.sh, so anything that
# could end that string, start an expansion or add a line is rejected outright rather than
# silently producing a config file that says something else. These are container paths; none of
# it is a real restriction.
case "$PROJECT_DIR_OPT" in
  *'"'*) die "projectDir may not contain a double quote: $PROJECT_DIR_OPT" ;;
  *'`'*) die "projectDir may not contain a backtick: $PROJECT_DIR_OPT" ;;
  *'$'*) die "projectDir may not contain a dollar sign: $PROJECT_DIR_OPT" ;;
  *'\'*) die "projectDir may not contain a backslash: $PROJECT_DIR_OPT" ;;
  # A literal newline, which would turn the rest of the value into its own line of shell.
  *'
'*) die "projectDir may not contain a newline: $PROJECT_DIR_OPT" ;;
esac

# /usr/local/share/devc-features/<id>/ is the Feature namespace, kept separate from devc's own
# /usr/local/share/devc/ so "did devc put this here, or a Feature?" stays answerable.
# Overridable for the test harness.
SHARE_DIR="${SHARE_DIR:-/usr/local/share/devc-features/bash-config}"

FEATURE_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- the scripts and the two fixed directories --------------------------------------------
#
# dirs/user is this Feature's published surface: the consumer bind-mounts onto it, copies into
# it, or leaves it empty. It is created here and **never written to again** — the Feature never
# learns where its contents came from.
#
# dirs/project is not created here at all. post-create.sh makes it a *symlink* into the
# workspace, and a symlinked directory globs live, so the workspace stays the source of truth
# and an edit needs no rebuild and no recreate.

mkdir -p "$SHARE_DIR/dirs/user"

# Plain cp rather than `install -o root`: this runs as root, so the copy is root-owned either
# way, and no ownership flag means the script still runs unprivileged in the test harness.
cp "$FEATURE_DIR/init.sh" "$SHARE_DIR/init.sh"
chmod 0644 "$SHARE_DIR/init.sh"
cp "$FEATURE_DIR/post-create.sh" "$SHARE_DIR/post-create.sh"
chmod 0755 "$SHARE_DIR/post-create.sh"

# The option's whole journey to create time. printf with the value as an *argument*, never as
# part of the format string, so a `%` in a path is not read as a conversion specifier.
{
  cat << 'CONFIG_HEADER'
# bash-config — written by install.sh at image build time, sourced by post-create.sh at create
# time. The manifest's postCreateCommand takes no arguments, so this file is how the Feature's
# one option crosses over. Not executed, and not the place to change it: set the option.
CONFIG_HEADER
  printf 'PROJECT_DIR="%s"\n' "$PROJECT_DIR_OPT"
} > "$SHARE_DIR/config.sh"
chmod 0644 "$SHARE_DIR/config.sh"

# Required, not best-effort. /usr/local/share is root-owned and post-create.sh runs as the
# remote user, so without this it could create neither the project symlink nor env.sh — and it
# would fail at create time, in a container the consumer then cannot easily open to fix. Only
# dirs/ is handed over; the scripts stay root-owned.
if [ -n "${_REMOTE_USER:-}" ]; then
  chown -R "$_REMOTE_USER" "$SHARE_DIR/dirs" ||
    die "could not chown $SHARE_DIR/dirs to '$_REMOTE_USER' — the create-time hook runs as" \
      'that user and could not then create the project symlink'
fi

echo "bash-config: installed into $SHARE_DIR (projectDir='$PROJECT_DIR_OPT')"

# --- the ~/.bashrc block ---------------------------------------------------------------------

USER_HOME="${_REMOTE_USER_HOME:-$HOME}"
[ -n "$USER_HOME" ] || die 'no _REMOTE_USER_HOME and no HOME — nowhere to append a block'
START_MARKER='# >>> bash-config >>>'
END_MARKER='# <<< bash-config <<<'

append_block() { # append_block <file>
  # Marker-guarded so a rebuild does not double-append.
  if grep -qF "$START_MARKER" "$1" 2> /dev/null; then
    echo "bash-config: $1 already has the block — left alone"
    return 0
  fi

  # One line, and it is the same line in every container this Feature is ever installed into.
  # No option is substituted here and nothing rewrites it later, which is the entire design: a
  # static block cannot drift from what the Feature thinks it wrote.
  {
    printf '%s\n' "$START_MARKER"
    printf '. %s\n' "$SHARE_DIR/init.sh"
    printf '%s\n' "$END_MARKER"
  } >> "$1"

  # `>>` creates the file root-owned if it did not exist, which would leave the remote user
  # unable to edit their own startup file. Appending to an existing one leaves ownership alone,
  # so this is a no-op in the common case.
  if [ -n "${_REMOTE_USER:-}" ]; then
    chown "$_REMOTE_USER" "$1" 2> /dev/null || true
  fi

  echo "bash-config: block appended to $1"
}

# ~/.bashrc reaches **interactive** shells only: the stock `case $- in *i*) ;; *) return;; esac`
# guard sits at the top of it and this block lands at the bottom, so `bash -c` gets nothing and
# `bash -ic` gets everything. That is this Feature's whole audience — no block is appended
# anywhere else, and a login profile (~/.bash_profile / ~/.bash_login / ~/.profile) is never
# touched. See README.md for what that gives up.
append_block "$USER_HOME/.bashrc"
