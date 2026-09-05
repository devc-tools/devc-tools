#!/bin/sh
# agents Feature install — install the agent CLIs, install any declared pi packages and Herdr
# plugins, pre-create ~/.claude and the seed mount point, and place the create-time script.
#
# Runs as root at image *build* time. Four things happen here that post-create.sh cannot:
#
#   - The CLI installs, run as the remote user rather than root, so the binaries land under a
#     directory that user can later update (`claude`/`copilot`/`pi update`/`herdr update`/
#     `agent-browser` via npm). Network is required when any install option is true: a failed
#     download fails the build, rather than leaving a container that looks fine until the first
#     `claude`. An npm-installed CLI (pi, agent-browser) additionally needs Node.js visible to a
#     non-interactive shell, which at build time it is not — see node_prelude.
#   - piPackages/herdrPlugins, installed the same way and for the same reason as the CLIs: what
#     either CLI writes in a running container is lost on the next rebuild. Each requires its
#     CLI's own install option; a non-empty value without it is a build-time `die`, not a
#     silent skip. agentBrowserChrome (Chrome for Testing plus its Linux system libraries) is
#     the one exception to that pairing — see install_agent_browser_chrome.
#   - Pre-creating ~/.claude owned by the remote user, so the volume the manifest declares there
#     comes up owned correctly rather than root-owned.
#   - Pre-creating the seed directory, empty. It is this Feature's published surface: a consumer
#     bind-mounts their own host config onto it. Empty is a working state, not a broken one —
#     the seed-link step finds nothing to link and moves on, which is the bare `{}` case.
#
# There are no path options to validate or bake. Every path this Feature touches is either fixed
# (the seed) or derived from the remote user's own home (~/.claude).
set -e

die() {
  echo "agents: $*" >&2
  exit 1
}

# Options reach install.sh uppercased with non-word characters stripped (the CLI's getSafeId),
# and booleans arrive as the strings "true"/"false". The defaults are repeated here rather than
# trusted from the manifest so the script also runs standalone.
INSTALL_CLAUDE_CLI_OPT="${INSTALLCLAUDECLI:-true}"
INSTALL_COPILOT_CLI_OPT="${INSTALLCOPILOTCLI:-false}"
INSTALL_PI_CLI_OPT="${INSTALLPICLI:-false}"
INSTALL_HERDR_OPT="${INSTALLHERDR:-false}"
PI_PACKAGES_OPT="${PIPACKAGES:-}"
HERDR_PLUGINS_OPT="${HERDRPLUGINS:-}"
INSTALL_AGENT_BROWSER_OPT="${INSTALLAGENTBROWSER:-false}"
# agentBrowserChrome has a non-empty default ("with-deps"), unlike piPackages/herdrPlugins'
# empty one — so, unlike those two, install.sh cannot tell an explicit value from the default it
# was handed, and there is no die guard here. It is read only when installAgentBrowser is true
# and silently ignored otherwise; see the option's own description and the README.
AGENT_BROWSER_CHROME_OPT="${AGENTBROWSERCHROME:-with-deps}"

# A non-empty list option with its CLI option left off is a hard error, not a silent skip — a
# silent skip would produce a container that looks configured (the option is set) but installs
# nothing. Checked up front, before any download starts, so the failure is immediate rather than
# surfacing after an unrelated install has already run.
if [ -n "$PI_PACKAGES_OPT" ] && [ "$INSTALL_PI_CLI_OPT" != true ]; then
  die "piPackages is set but installPiCli is false, so there is no pi to install them with." \
    "Set installPiCli: true, or clear piPackages."
fi
if [ -n "$HERDR_PLUGINS_OPT" ] && [ "$INSTALL_HERDR_OPT" != true ]; then
  die "herdrPlugins is set but installHerdr is false, so there is no herdr to install them" \
    "with. Set installHerdr: true, or clear herdrPlugins."
fi

# /usr/local/share/devc-features/<id>/ is the Feature namespace, kept separate from devc's own
# /usr/local/share/devc/ so "did devc put this here, or a Feature?" stays answerable.
# Overridable for the test harness.
SHARE_DIR="${SHARE_DIR:-/usr/local/share/devc-features/agents}"

FEATURE_DIR="$(cd "$(dirname "$0")" && pwd)"

# _REMOTE_USER_HOME is set by the CLI whenever it knows the remote user (every real Feature
# install); falls back to $HOME for a manual run or the offline test harness. Claude Code
# resolves its own state directory as $CLAUDE_CONFIG_DIR or, unset, $HOME/.claude — so the
# remote user's home is the only correct answer here, and there is nothing to make an option of.
REMOTE_USER_HOME="${_REMOTE_USER_HOME:-$HOME}"
REMOTE_USER="${_REMOTE_USER:-$(id -un)}"
CLAUDE_DIR="$REMOTE_USER_HOME/.claude"

# --- CLI installs, as the remote user, not root -------------------------------------------------
#
# `su -`/`runuser -l` resolve $HOME to $_REMOTE_USER_HOME for the installer script, without which
# the installers would drop their binaries under root's own ~/.local/bin instead. Written to a
# temp script and run by path, rather than passed as a `-c` string, so nothing here has to
# reason about nested quoting.
have() { command -v "$1" > /dev/null 2>&1; }

run_as_remote_user() { # run_as_remote_user <script-path>
  if have runuser; then
    runuser -l "$REMOTE_USER" -c "bash '$1'"
  else
    su - "$REMOTE_USER" -c "bash '$1'"
  fi
}

# Exit code the node prelude below uses to say "the toolchain is missing", so install_cli can
# tell that apart from a failed download and name the real problem. 78 is sysexits.h's
# EX_CONFIG; any value the installers themselves do not use would do.
NODE_MISSING_STATUS=78

# node_prelude <min node version> — prints (to stdout) the runtime shell snippet that finds
# Node.js on a non-interactive build-time shell and pins npm's global prefix, ready to be
# embedded ahead of any generated script that needs `node`/`npm` on PATH. Shared by install_cli
# (for the npm-installed pi CLI) and install_pi_packages (pi itself is a Node CLI) — both need
# the exact same fix for the exact same problem, so this is the one place it is written.
#
# Emits its own `NODE_MIN='<value>'` assignment first — the one value the prelude cannot
# hardcode — so the body itself stays a *quoted* heredoc: it is all runtime shell, and nothing in
# it should be expanded by root's shell at generation time.
node_prelude() { # node_prelude <min node version>
  echo "NODE_MIN='$1'"
  cat << 'NODE_PRELUDE'
# Some installers (pi) install themselves with npm, so they need Node.js on PATH — and at image
# build time it is not there, even though the node Feature has already installed it. The
# devcontainers node Feature wires nvm into /etc/bash.bashrc only, and bash sources that file
# just for *interactive* shells (/etc/profile guards it on $PS1). This script is a
# non-interactive one, so node is present on disk and invisible to it. `installsAfter` does not
# help: it fixes the install *order*, not the PATH. Source nvm directly instead.
if ! command -v node > /dev/null 2>&1; then
  for _nvm_dir in "${NVM_DIR:-}" /usr/local/share/nvm "$HOME/.nvm"; do
    [ -n "$_nvm_dir" ] || continue
    [ -s "$_nvm_dir/nvm.sh" ] || continue
    export NVM_DIR="$_nvm_dir"
    # nvm.sh is a large script that is not written to be sourced under `set -e`; a non-fatal
    # failure inside it must not take this whole install down.
    set +e
    . "$_nvm_dir/nvm.sh" > /dev/null 2>&1
    set -e
    if command -v node > /dev/null 2>&1; then break; fi
  done
fi

if ! command -v node > /dev/null 2>&1 || ! command -v npm > /dev/null 2>&1; then
  echo "agents: Node.js $NODE_MIN or newer and npm are required for this CLI, and neither" >&2
  echo "agents: node nor npm was found at build time (nvm was not found either). Add a node" >&2
  echo "agents: Feature to the container ahead of this one, then rebuild." >&2
  exit 78
fi

# Check the version here rather than letting the installer discover it. An installer that fails
# its own preflight exits 1, which install_cli can only report as "network required" — the
# misleading message this whole prelude exists to stop. Comparing in node rather than with sort
# -V keeps it to one tool that is, by this point, guaranteed present.
if ! node -e 'const need=process.argv[1].split(".").map(Number),have=process.versions.node.split(".").map(Number);for(let i=0;i<3;i++){const n=need[i]||0,h=have[i]||0;if(h>n)process.exit(0);if(h<n)process.exit(1)}process.exit(0)' "$NODE_MIN" > /dev/null 2>&1; then
  echo "agents: this CLI needs Node.js $NODE_MIN or newer; the container has $(node --version)." >&2
  echo "agents: raise the node Feature's version option, or drop the install option for it." >&2
  exit 78
fi

# Pin npm's global prefix to ~/.local, so an npm-installed agent CLI lands in ~/.local/bin
# beside claude and copilot. Without this, npm's global prefix under nvm is the *active node
# version's* own directory (/usr/local/share/nvm/versions/node/<version>) — so the binary would
# drop out of PATH the moment node-nvmrc switched the container onto a different version for a
# project's .nvmrc, and the `[ ! -x "$HOME/.local/bin/<bin>" ]` guard below would never see it
# on a rebuild either.
export npm_config_prefix="$HOME/.local"
NODE_PRELUDE
}

# sh_quote <string> — prints a single-quoted, safely-escaped version of <string> to stdout, for
# embedding a value that comes from Feature options (so, in principle, from a consumer's
# devcontainer.json) as a single literal shell word inside a generated script, without word
# splitting, globbing, or the value breaking out of its quotes.
sh_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# csv_quoted_entries <comma-separated string> — splits on `,`, trims leading/trailing whitespace
# from each entry, drops empty entries (so a leading/trailing/doubled comma is harmless and an
# all-empty input yields nothing), and prints the survivors on stdout, each pre-quoted with
# sh_quote and space-separated, ready to splice into a generated `for x in <this>; do` line.
# Shared by install_pi_packages and install_herdr_plugins — piPackages and herdrPlugins parse
# identically; only what they do with each entry differs.
csv_quoted_entries() {
  _csv="$1"
  _out=""
  _old_ifs="$IFS"
  IFS=','
  for _raw in $_csv; do
    IFS="$_old_ifs"
    _trimmed="$(printf '%s' "$_raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [ -n "$_trimmed" ]; then
      _out="$_out$(sh_quote "$_trimmed") "
    fi
    IFS=','
  done
  IFS="$_old_ifs"
  printf '%s' "$_out"
}

install_cli() { # install_cli <display name> <binary name> <install script URL> [min node version]
  # A 4th argument means "this installer runs on Node.js", and its value is the minimum version
  # that installer needs — see node_prelude above.
  _name="$1"; _bin="$2"; _url="$3"; _node_min="${4:-}"
  _script="$(mktemp)"
  # set -o pipefail is bash-only (hence `bash '$1'` above, not a bare `sh -c`) — without it a
  # failed curl piped into bash would not fail this whole line, and a network failure would look
  # like a successful, silent no-op install instead of failing the build.
  #
  # Built in pieces so node_prelude's output can stay a *quoted* heredoc internally: it is all
  # runtime shell, and nothing in it should be expanded here by root's shell. Only the last piece
  # interpolates, and only the two values it has to (`$_bin`, `$_url`).
  {
    echo 'set -e'
    echo 'set -o pipefail'
    if [ -n "$_node_min" ]; then
      node_prelude "$_node_min"
    fi
    cat << EOF
if [ ! -x "\$HOME/.local/bin/$_bin" ] && ! command -v $_bin > /dev/null 2>&1; then
  curl -fsSL $_url | bash
fi
EOF
  } > "$_script"
  chmod 0755 "$_script"
  # Captured with `|| _status=$?` rather than `if ! …`, so `set -e` does not abort here and the
  # prelude's distinct exit code survives to be reported below.
  _status=0
  run_as_remote_user "$_script" || _status=$?
  rm -f "$_script"
  if [ "$_status" -eq "$NODE_MISSING_STATUS" ]; then
    die "$_name CLI install failed — see the Node.js requirement above"
  elif [ "$_status" -ne 0 ]; then
    die "$_name CLI install failed (network required)"
  fi
  echo "agents: $_name CLI installed for $REMOTE_USER"
}

# install_npm_cli <display name> <binary name> <npm package> <min node version> — install_cli's
# sibling for a CLI that installs itself with `npm install -g`, rather than `curl | bash`. Kept
# separate rather than growing a mode flag onto install_cli: pi still uses the curl installer
# (https://pi.dev/install.sh, which itself invokes npm internally) and stays on that untouched
# path; this is for a CLI published as a plain npm package.
#
# Same contract as install_cli end to end: the node prelude, the same idempotency guard, run as
# the remote user, the same two failure reports (Node.js missing vs. network). `npm install -g`
# under the prelude's pinned npm_config_prefix=$HOME/.local is what lands the binary in
# ~/.local/bin instead of the active nvm version's own directory.
install_npm_cli() { # install_npm_cli <display name> <binary name> <npm package> <min node version>
  _name="$1"; _bin="$2"; _pkg="$3"; _node_min="$4"
  _script="$(mktemp)"
  {
    echo 'set -e'
    echo 'set -o pipefail'
    node_prelude "$_node_min"
    cat << EOF
if [ ! -x "\$HOME/.local/bin/$_bin" ] && ! command -v $_bin > /dev/null 2>&1; then
  npm install -g $_pkg
fi
EOF
  } > "$_script"
  chmod 0755 "$_script"
  _status=0
  run_as_remote_user "$_script" || _status=$?
  rm -f "$_script"
  if [ "$_status" -eq "$NODE_MISSING_STATUS" ]; then
    die "$_name CLI install failed — see the Node.js requirement above"
  elif [ "$_status" -ne 0 ]; then
    die "$_name CLI install failed (network required)"
  fi
  echo "agents: $_name CLI installed for $REMOTE_USER"
}

# install_pi_packages <comma-separated pi package sources> — installs each with `pi install`, as
# the remote user, through the same node prelude installPiCli needs (pi is a Node CLI and
# build-time PATH does not have node on it). Belongs at build time, not create time: `pi install`
# writes ~/.pi, which is not a mount, so anything installed in a live container is lost on the
# next rebuild.
#
# No `pi list` presence guard: reinstalling an already-installed source is a genuine no-op (npm
# reports "up to date"; settings.json gains no duplicate entry), so a rebuild does not pay for
# one.
install_pi_packages() { # install_pi_packages <comma-separated pi package sources>
  _entries="$(csv_quoted_entries "$1")"
  [ -n "$_entries" ] || return 0
  _script="$(mktemp)"
  {
    echo 'set -e'
    echo 'set -o pipefail'
    node_prelude 22.19.0
    cat << EOF
for _pkg in $_entries; do
  echo "agents: pi install \$_pkg"
  pi install "\$_pkg"
done
EOF
  } > "$_script"
  chmod 0755 "$_script"
  _status=0
  run_as_remote_user "$_script" || _status=$?
  rm -f "$_script"
  if [ "$_status" -eq "$NODE_MISSING_STATUS" ]; then
    die "piPackages install failed — see the Node.js requirement above"
  elif [ "$_status" -ne 0 ]; then
    die "piPackages install failed (network required, or pi rejected one of the sources)"
  fi
  echo "agents: pi packages installed for $REMOTE_USER: $1"
}

# install_herdr_plugins <comma-separated GitHub-shorthand plugin sources> — installs each with
# `herdr plugin install <entry> --yes`, as the remote user. `--yes` is required: `plugin install`
# shows a trust preview in an interactive terminal, and there is no terminal at build time.
#
# GitHub shorthand only (owner/repo[/subdir]) — Herdr's installer accepts nothing else, so a
# non-shorthand entry fails with Herdr's own error rather than one from this script. Needs git
# and network at build time; both are named in the failure message. Plugin registration is
# global to the user rather than per session, so one build-time install covers every session in
# the container. A plugin whose min_herdr_version exceeds the installed Herdr fails the build
# too — expected, and named here so that failure is diagnosable.
install_herdr_plugins() { # install_herdr_plugins <comma-separated GitHub-shorthand plugins>
  _entries="$(csv_quoted_entries "$1")"
  [ -n "$_entries" ] || return 0
  if ! have git; then
    die "herdrPlugins is set but git is not present at build time — herdr plugin install needs" \
      "it. Add git to the image ahead of this Feature."
  fi
  _script="$(mktemp)"
  {
    echo 'set -e'
    cat << EOF
for _plugin in $_entries; do
  echo "agents: herdr plugin install \$_plugin"
  herdr plugin install "\$_plugin" --yes
done
EOF
  } > "$_script"
  chmod 0755 "$_script"
  _status=0
  run_as_remote_user "$_script" || _status=$?
  rm -f "$_script"
  if [ "$_status" -ne 0 ]; then
    die "herdrPlugins install failed (network required, git required, or a plugin's" \
      "min_herdr_version exceeds the installed Herdr version)"
  fi
  echo "agents: herdr plugins installed for $REMOTE_USER: $1"
}

# install_agent_browser_chrome <with-deps|browser-only|none> — runs `agent-browser install
# [--with-deps]`, which downloads Chrome for Testing into ~/.agent-browser and, for
# "with-deps", apt-installs the ~36 shared libraries and fonts Chrome needs on Linux.
#
# The one place in this Feature that does not use run_as_remote_user. `--with-deps` shells out
# to literally `sudo apt-get update && sudo apt-get install -y <packages>`, and:
#
#   - the remote user may have no sudo, or no passwordless sudo, on an arbitrary base image;
#   - running the whole command as the remote user would also mean running apt as that user,
#     which fails outright without real sudo privileges.
#
# So this runs as root — which this whole script already is — with HOME repointed at the remote
# user's home (so the one download lands where the remote user will find it, not in
# /root/.agent-browser) and a passthrough `sudo` shim first on PATH (we are already root, so
# `exec "$@"` is the correct no-op; this removes sudo from the Feature's dependency set entirely
# rather than adding a `sudo -n true` precheck and a fifth way to fail the build).
install_agent_browser_chrome() { # install_agent_browser_chrome <with-deps|browser-only|none>
  _mode="$1"
  if [ "$_mode" = none ]; then
    return 0
  fi

  # agent-browser is on PATH at this point only via $REMOTE_USER_HOME/.local/bin, which root's
  # own PATH does not include — invoke it by absolute path instead.
  _bin="$REMOTE_USER_HOME/.local/bin/agent-browser"

  _shim_dir="$(mktemp -d)"
  cat > "$_shim_dir/sudo" << 'SUDO_SHIM'
#!/bin/sh
exec "$@"
SUDO_SHIM
  chmod 0755 "$_shim_dir/sudo"

  _flag=""
  if [ "$_mode" = with-deps ]; then
    _flag="--with-deps"
  fi

  _status=0
  HOME="$REMOTE_USER_HOME" PATH="$_shim_dir:$PATH" "$_bin" install $_flag || _status=$?
  rm -rf "$_shim_dir"
  if [ "$_status" -ne 0 ]; then
    die "agent-browser install ($_mode) failed (network required, or apt could not satisfy" \
      "the library list on this base image)"
  fi

  # Safe only here, unlike the ~/.claude chown above: this directory was just created, at build
  # time, by the command that just ran, with nothing mounted under it. post-create.sh's
  # non-recursive chown of ~/.claude exists precisely because subpaths there may be host bind
  # mounts; that concern does not apply to a directory this step owns end to end.
  if [ -d "$REMOTE_USER_HOME/.agent-browser" ]; then
    chown -R "$REMOTE_USER" "$REMOTE_USER_HOME/.agent-browser"
  fi
  echo "agents: agent-browser Chrome installed ($_mode) for $REMOTE_USER"
}

if [ "$INSTALL_CLAUDE_CLI_OPT" = true ]; then
  install_cli Claude claude https://claude.ai/install.sh
fi
if [ "$INSTALL_COPILOT_CLI_OPT" = true ]; then
  install_cli Copilot copilot https://gh.io/copilot-install
fi
if [ "$INSTALL_PI_CLI_OPT" = true ]; then
  # pi's own package declares engines >= 22.19.0; under anything older its bundle dies with a
  # raw SyntaxError rather than a version complaint, so the check is worth making here.
  install_cli Pi pi https://pi.dev/install.sh 22.19.0
fi
if [ "$INSTALL_HERDR_OPT" = true ]; then
  # Herdr ships a static binary — no node prelude, unlike pi above.
  install_cli Herdr herdr https://herdr.dev/install.sh
fi
if [ -n "$PI_PACKAGES_OPT" ]; then
  # The die guard above already ensures INSTALL_PI_CLI_OPT is true whenever this is reached.
  install_pi_packages "$PI_PACKAGES_OPT"
fi
if [ -n "$HERDR_PLUGINS_OPT" ]; then
  # The die guard above already ensures INSTALL_HERDR_OPT is true whenever this is reached.
  install_herdr_plugins "$HERDR_PLUGINS_OPT"
fi
if [ "$INSTALL_AGENT_BROWSER_OPT" = true ]; then
  # 22.19.0 — deliberately pi's existing floor above, not the package's declared engines >= 24:
  # that floor covers building the Rust CLI from source, npm does not enforce engines without
  # engine-strict, a global install is measured working on Node 22.23.2, and the artifact this
  # installs is a native binary with no Node dependency at run time at all. Raising it to 24
  # would refuse the build for every consumer pinned to Node 22 LTS for no measured reason.
  install_npm_cli "agent-browser" agent-browser agent-browser 22.19.0
  # agentBrowserChrome is read only in here — see its own assignment above for why there is no
  # die guard pairing it with this option the way piPackages/herdrPlugins pair with theirs.
  install_agent_browser_chrome "$AGENT_BROWSER_CHROME_OPT"
fi

# --- pre-create ~/.claude, owned by the remote user ---------------------------------------------
# Docker seeds a first-use empty named volume from whatever is already at the mount point, so
# creating it owned here is what makes the declared volume come up owned by the remote user.
mkdir -p "$CLAUDE_DIR"
if [ "$(id -un)" != "$REMOTE_USER" ]; then
  chown "$REMOTE_USER" "$CLAUDE_DIR" 2> /dev/null ||
    echo "agents: could not chown $CLAUDE_DIR to $REMOTE_USER (post-create.sh repairs this)"
fi

# --- the create-time script, and the seed mount point -------------------------------------------
#
# claude-seed stays root-owned and is never written to by this Feature: a consumer mounts their
# own host directory onto it read-only, and post-create.sh only ever reads it. Left empty when
# nobody mounts anything, which is the bare `{}` case.
mkdir -p "$SHARE_DIR/claude-seed"

# Plain cp rather than `install -o root`: this runs as root, so the copy is root-owned either
# way, and no ownership flag means the script still runs unprivileged in the test harness.
cp "$FEATURE_DIR/post-create.sh" "$SHARE_DIR/post-create.sh"
chmod 0755 "$SHARE_DIR/post-create.sh"

echo "agents: create-time script installed at $SHARE_DIR/post-create.sh"
echo "agents: claudeDir='$CLAUDE_DIR' seedDir='$SHARE_DIR/claude-seed'" \
  "installClaudeCli=$INSTALL_CLAUDE_CLI_OPT installCopilotCli=$INSTALL_COPILOT_CLI_OPT" \
  "installPiCli=$INSTALL_PI_CLI_OPT installHerdr=$INSTALL_HERDR_OPT" \
  "piPackages='$PI_PACKAGES_OPT' herdrPlugins='$HERDR_PLUGINS_OPT'" \
  "installAgentBrowser=$INSTALL_AGENT_BROWSER_OPT agentBrowserChrome='$AGENT_BROWSER_CHROME_OPT'"
