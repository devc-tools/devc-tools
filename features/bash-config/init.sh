# bash-config — the sourcing logic. Sourced by the static block install.sh appends to
# ~/.bashrc; never executed, so there is no shebang and no `set -e`. It runs *inside* the
# caller's shell, and killing an interactive shell over one bad layer script is not this
# file's call.
#
# install.sh ships this file **verbatim** and nothing — not install.sh, not post-create.sh —
# ever rewrites a line of it. That is the whole reason the two directories below are fixed
# paths: the configuration lives in files this Feature owns (dirs/project is a symlink,
# dirs/env.sh is written at create time) and the code is a constant.
#
# **`~/.bashrc` only, deliberately.** A real terminal in a devcontainer starts a plain
# interactive, non-login bash, and an agent or scripted tool invocation typically reaches
# neither ~/.bashrc nor a login profile at all (`bash -c` reads no startup file). So a login
# profile would reach neither audience this Feature exists for, at the cost of having to pick
# which of ~/.bash_profile / ~/.bash_login / ~/.profile to append to. See README.md.
#
# Written in POSIX `sh` style out of habit, not requirement — ~/.bashrc is read only by bash.

# The one path in this file. Overridable only for the offline harness — a Feature that is
# published cannot have its fixed paths depend on the environment of the shell that reads it.
_bash_config_dirs="${_BASH_CONFIG_DIRS:-/usr/local/share/devc-features/bash-config/dirs}"

_bash_config_source_dir() { # _bash_config_source_dir <directory>
  # An absent directory, a dangling symlink (`-d` follows, so it is false) and an empty one are
  # all silent successes at rc 0. This Feature has to be safe to leave enabled in a project that
  # ships no scripts at all, or the one-line opt-in is worthless.
  [ -d "$1" ] || return 0

  # The *physical* path, so the guard below keys on where the files actually are rather than on
  # the name this shell reached them by: dirs/project is a symlink into the workspace, and a
  # directory reached under two names is still one directory.
  _bash_config_real=$(CDPATH= cd -P "$1" 2> /dev/null && pwd)
  [ -n "$_bash_config_real" ] || _bash_config_real="$1"

  # Source a directory at most once per shell. This guards against dirs/user and dirs/project
  # ever resolving to the same physical directory, and against something manually re-sourcing
  # ~/.bashrc mid-session re-running the scan. Deliberately not exported — it must reset per
  # shell, not inherit into a subshell that legitimately re-sources ~/.bashrc.
  case ":${_BASH_CONFIG_DONE:-}:" in
    *":$_bash_config_real:"*) return 0 ;;
  esac
  _BASH_CONFIG_DONE="${_BASH_CONFIG_DONE:+$_BASH_CONFIG_DONE:}$_bash_config_real"

  for _bash_config_f in "$1"/bashrc_*.sh; do
    # An unmatched glob stays literal, so this -f test is also the empty-directory guard — and
    # what keeps a *directory* named bashrc_x.sh from being sourced.
    [ -f "$_bash_config_f" ] && . "$_bash_config_f"
  done
  # Also the function's exit status: `unset` succeeds, where the loop's last `[ -f ]` may not.
  unset _bash_config_f
}

# post-create.sh writes PROJECT_PATH here, so a layer script can use it without the consumer
# having declared a remoteEnv. Absent is normal — nothing creates it at build time. Outside the
# helper so its exports land in the shell rather than in a function.
[ -r "$_bash_config_dirs/env.sh" ] && . "$_bash_config_dirs/env.sh"

# User directory first, project second, so a project's committed settings win on conflict — the
# same system → global → local order git uses. A project file that *assigns* rather than appends
# to a shared variable (PS1, PATH) therefore overrides the personal one.
_bash_config_source_dir "$_bash_config_dirs/user"
_bash_config_source_dir "$_bash_config_dirs/project"

# No helper and no loop variable survive, and this is the last thing ~/.bashrc runs — a
# consumer's prompt may render $?, so a stray non-zero status here would show up as an error on
# the very first prompt of every shell. `unset` cannot fail, which is why it goes last.
unset -f _bash_config_source_dir
unset _bash_config_dirs _bash_config_real
