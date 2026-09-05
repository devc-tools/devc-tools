# agents Feature create-time installs — pi packages and Herdr plugins, run at container
# *create* time via post-create.sh rather than baked into a build-time Docker RUN layer.
#
# Why here and not install.sh: ~/.pi and ~/.config/herdr are still not mounts, so anything
# either CLI writes in a running container is still lost on the next full rebuild — that part
# hasn't changed. What moved is *when* the install runs, and that fixes a real staleness bug:
# a build-time RUN layer is keyed on Docker's build cache, so an unchanged HERDRPLUGINS/
# PIPACKAGES option value means an unchanged RUN instruction, which Docker treats as a cache
# hit and never re-executes — a consumer who only bumped an upstream plugin's default branch
# and ran a plain "Rebuild Container" (not "Rebuild Without Cache") kept whatever commit was
# cloned the *last time that layer actually ran*, silently. postCreateCommand is not a Docker
# layer at all: it unconditionally re-runs on every container *creation*, which is exactly what
# "Rebuild Container" performs (destroy + create a new container from the image) — so running
# the actual git-touching install here means every rebuild re-resolves each source's current
# tip, with no ref to pin and no --no-cache needed.
#
# install.sh still does the option validation (the installHerdr/installPiCli pairing) and
# persists the raw option strings into pi-packages.conf/herdr-plugins.conf, because
# postCreateCommand does not receive a Feature's own options as environment variables — only
# install.sh does. A misconfigured devcontainer.json still fails fast at build time; only the
# actual fetch is deferred.
#
# A failed install here WARNS and continues rather than aborting container creation the way
# install.sh's `die` used to abort the build. That is a deliberate change, not an oversight:
# this now runs on every single container creation instead of only when the image is rebuilt,
# so a transient network blip at create time would otherwise cost you the ability to open the
# container at all. `doctor`/`herdr plugin list`/`pi list` are how you notice a skip after the
# fact.
#
# Sourced by post-create.sh, not executed standalone — it expects the caller's $HOME and
# `warn()` already in scope, and defines everything else it needs itself so it has no
# dependency on install.sh's own helpers (which do not exist in this process; this is a
# separate script, copied separately, run at a separate time).

have() { command -v "$1" > /dev/null 2>&1; }

# for_each_csv_entry <comma-separated string> <command...> — splits on `,`, trims
# leading/trailing whitespace from each entry, drops empty entries (so a leading/trailing/
# doubled comma is harmless), and runs `<command...> <entry>` for each survivor. No quoting
# gymnastics needed here the way install.sh's version of this idea needed sh_quote: this script
# already runs directly in the remote user's own shell, not spliced into a generated script for
# `su -c`.
for_each_csv_entry() {
  _csv="$1"
  shift
  _old_ifs="$IFS"
  IFS=','
  for _raw in $_csv; do
    IFS="$_old_ifs"
    _trimmed="$(printf '%s' "$_raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [ -n "$_trimmed" ]; then
      "$@" "$_trimmed"
    fi
    IFS=','
  done
  IFS="$_old_ifs"
}

# ensure_node <min version> — makes `node`/`npm` available on PATH for the rest of this script,
# the create-time equivalent of install.sh's node_prelude. Needed for the same underlying
# reason: postCreateCommand also runs a non-interactive shell, so /etc/bash.bashrc's nvm wiring
# (guarded on $PS1 by /etc/profile) is not sourced here either. Returns non-zero rather than
# exiting — a missing/too-old Node.js skips piPackages for this create, it does not take the
# rest of post-create.sh down with it.
ensure_node() {
  _min="$1"
  if ! have node; then
    for _nvm_dir in "${NVM_DIR:-}" /usr/local/share/nvm "$HOME/.nvm"; do
      [ -n "$_nvm_dir" ] || continue
      [ -s "$_nvm_dir/nvm.sh" ] || continue
      export NVM_DIR="$_nvm_dir"
      # nvm.sh is not written to be sourced under `set -e`; a non-fatal failure inside it must
      # not take this whole install down.
      set +e
      . "$_nvm_dir/nvm.sh" > /dev/null 2>&1
      set -e
      if have node; then break; fi
    done
  fi
  if ! have node || ! have npm; then
    warn "piPackages needs Node.js $_min or newer and npm; neither was found on PATH and nvm" \
      "was not found either — skipping piPackages this create."
    return 1
  fi
  if ! node -e 'const need=process.argv[1].split(".").map(Number),have=process.versions.node.split(".").map(Number);for(let i=0;i<3;i++){const n=need[i]||0,h=have[i]||0;if(h>n)process.exit(0);if(h<n)process.exit(1)}process.exit(0)' "$_min" > /dev/null 2>&1; then
    warn "piPackages needs Node.js $_min or newer; this container has $(node --version) —" \
      "skipping piPackages this create."
    return 1
  fi
  # Same reasoning as install.sh's own node_prelude: pin npm's global prefix so an
  # npm-installed package lands under ~/.local rather than the active nvm version's own
  # directory.
  export npm_config_prefix="$HOME/.local"
  return 0
}

# resolve_bin <binary name> — prints the absolute path to a CLI this Feature installs, on
# stdout, or nothing if it cannot be found. postCreateCommand's PATH is not guaranteed to
# include ~/.local/bin the way an interactive shell's would (Anthropic's/Herdr's installers add
# it via ~/.bashrc/~/.profile, which a non-interactive exec does not source) — install.sh's own
# install_agent_browser_chrome hits the identical problem and works around it the same way: an
# absolute path first, `command -v` as a fallback for whatever PATH this process does have.
resolve_bin() {
  if [ -x "$HOME/.local/bin/$1" ]; then
    printf '%s' "$HOME/.local/bin/$1"
  elif have "$1"; then
    command -v "$1"
  fi
}

_install_one_pi_package() {
  echo "agents: pi install $1"
  if ! "$PI_BIN" install "$1"; then
    warn "pi install $1 failed (network required, or pi rejected the source) — continuing."
  fi
}

# install_pi_packages <comma-separated pi package sources> — the create-time counterpart of
# install.sh's old build-time install_pi_packages. No `pi list` presence guard, same as before:
# reinstalling an already-installed source is a genuine no-op, so a rebuild does not pay for one.
install_pi_packages() {
  _pkgs="$1"
  [ -n "$_pkgs" ] || return 0
  PI_BIN="$(resolve_bin pi)"
  if [ -z "$PI_BIN" ]; then
    warn "piPackages is set but pi is not installed — skipping. (installPiCli should have" \
      "guaranteed this at build time; was the image built before that option was set?)"
    return 0
  fi
  # pi's own entry point has a `#!/usr/bin/env node` shebang, so invoking it at all — not just
  # its own `pi install` internals — needs node resolvable via PATH, not just by absolute path.
  ensure_node 22.19.0 || return 0
  for_each_csv_entry "$_pkgs" _install_one_pi_package
}

_install_one_herdr_plugin() {
  echo "agents: herdr plugin install $1"
  if ! "$HERDR_BIN" plugin install "$1" --yes; then
    warn "herdr plugin install $1 failed (network, git, or min_herdr_version) — continuing."
  fi
}

# install_herdr_plugins <comma-separated GitHub-shorthand plugin sources> — the create-time
# counterpart of install.sh's old build-time install_herdr_plugins. Same GitHub-shorthand-only
# contract; Herdr's own installer is what rejects anything else.
install_herdr_plugins() {
  _plugins="$1"
  [ -n "$_plugins" ] || return 0
  HERDR_BIN="$(resolve_bin herdr)"
  if [ -z "$HERDR_BIN" ]; then
    warn "herdrPlugins is set but herdr is not installed — skipping. (installHerdr should have" \
      "guaranteed this at build time; was the image built before that option was set?)"
    return 0
  fi
  if ! have git; then
    warn "herdrPlugins is set but git is not on PATH — skipping."
    return 0
  fi
  for_each_csv_entry "$_plugins" _install_one_herdr_plugin
}
