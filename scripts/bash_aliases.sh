# devc-tools shell integration — one shell function per tool in this repo.
#
# Source this from your ~/.bashrc (or ~/.bash_aliases):
#   source /path/to/devc-tools/scripts/bash_aliases.sh
#
# Each function runs its tool straight from source via Deno — no compile step:
#   devc-bridge start | stop | status | restart
#   devc config | up | attach | claude | exec | build | mounts | stop | down | status
#
# Sourcing also exports $DEVC_BIN (the same from-source invocation as the `devc` function)
# for non-shell callers that can't see shell functions.
#
# Requires Deno 2.9+ on PATH. `devc-bridge start` backgrounds this same from-source
# invocation with its `run` subcommand — nothing is built. Only the opt-in menu-bar
# tray needs `deno desktop` (macOS GUI); see devc-bridge/host's `dev` task.

# Permissions every tool here runs with. Kept in one variable so the shell functions and
# the exported $DEVC_BIN invocation below can't drift apart.
#
# This set must stay in step with SOURCE_CHILD_PERMISSIONS in devc/devcontainer_selfexec.ts,
# whose own doc comment says so — they are the same permissions for the same code. `--allow-sys`
# is here for the embedded devcontainer CLI: it calls `os.release()` while starting any real
# subcommand, and without the permission dies on a bare `Object.release (ext:deno_node/os.ts)`
# stack. It surfaces only when the CLI runs in *this* process (`devc __devcontainer …`, which
# `features/*/test/run-features-test.sh` uses); devc's own `up` path spawns a child carrying
# SOURCE_CHILD_PERMISSIONS instead, which is why the drift went unnoticed. `--version` and
# `--help` short-circuit ahead of the call, so neither is a test of it.
_DEVC_TOOLS_PERMS="--allow-read --allow-write --allow-run --allow-env --allow-net --allow-sys"

# Resolve the repo root from THIS file, at source time, so the functions work regardless
# of the caller's cwd. Guarded so a bad path fails loudly, not silently.
if _devc_tools_root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd)"; then
  export DEVC_TOOLS_ROOT="$_devc_tools_root"
  export DEVC_BRIDGE_MAIN="$DEVC_TOOLS_ROOT/devc-bridge/host/main.ts"
  export DEVC_MAIN="$DEVC_TOOLS_ROOT/devc/main.ts"
  unset _devc_tools_root

  # `devc` below is a bash function — invisible to anything that spawns child processes
  # directly (e.g. Node's child_process.spawn, which resolves commands from PATH only and
  # never sees shell functions). Exporting the same invocation as $DEVC_BIN lets any such
  # consumer run devc from source too, with no separate setup: sourcing this file is enough.
  #
  # An explicit `export DEVC_BIN=...` from elsewhere (e.g. pointing at a compiled binary)
  # still wins — but a value *this file* set on an earlier source does not. That distinction
  # is the whole point of the marker below. This used to be a plain `:=`, which assigns only
  # when unset, so re-sourcing after editing _DEVC_TOOLS_PERMS above left the old string in
  # place and the change appeared not to work: the shell kept a DEVC_BIN missing the new
  # flag, and only a brand-new terminal picked it up. Comparing against the marker lets a
  # re-source update its own value while still yielding to anyone else's.
  _devc_bin_default="deno run $_DEVC_TOOLS_PERMS $DEVC_MAIN"
  if [ -z "${DEVC_BIN:-}" ] || [ "${DEVC_BIN:-}" = "${DEVC_BIN_FROM_ALIASES:-}" ]; then
    DEVC_BIN="$_devc_bin_default"
  fi
  unset _devc_bin_default
  export DEVC_BIN
  # Exported so a subshell that re-sources this file can still tell "we set this" from
  # "someone else set this" — without it, any nested source would treat our own value as
  # foreign and refuse to refresh it.
  export DEVC_BIN_FROM_ALIASES="$DEVC_BIN"
else
  echo "devc-tools: could not locate the repo root above ${BASH_SOURCE[0]:-$0}" >&2
fi

# Run one tool's entrypoint from source. $1 = tool name (for errors), $2 = entrypoint.
_devc_tools_run() {
  local name="$1" main="$2"
  shift 2
  if [ -z "$main" ] || [ ! -f "$main" ]; then
    echo "$name: entrypoint not found ($main); re-source scripts/bash_aliases.sh" >&2
    return 1
  fi
  # Unquoted on purpose: the perms must word-split into separate flags.
  deno run $_DEVC_TOOLS_PERMS "$main" "$@"
}

devc-bridge() { _devc_tools_run devc-bridge "${DEVC_BRIDGE_MAIN:-}" "$@"; }

devc() { _devc_tools_run devc "${DEVC_MAIN:-}" "$@"; }

# Adding a tool: export its <TOOL>_MAIN above, then one function line here.
