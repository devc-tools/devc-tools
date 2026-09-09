#!/bin/bash
# agents offline harness — the real install.sh, run repeatedly against a temp SHARE_DIR
# and a temp $_REMOTE_USER_HOME, with `curl` and `runuser` stubbed on PATH so no network call and
# no real privilege switch happens. No Docker, no root, no network:
#
#   bash features/agents/test/install_options_test.sh
#
# What this cannot cover, because it needs a real container: whether the CLI installers
# (claude.ai/install.sh, gh.io/copilot-install, pi.dev/install.sh) actually work, and whether
# `runuser`/`su` really drop privileges the way the stub here does not even attempt to. Both need
# test/run-features-test.sh under Docker. What this DOES pin, against the real install.sh: that
# the two fixed paths post-create.sh depends on are really created and really named the way it
# expects, the idempotent-CLI-already-installed skip, that a failed download fails the build, and
# the node prelude the npm-installed CLI (pi) depends on — that it finds node through nvm when
# node is not on PATH, and that it pins npm's global prefix to ~/.local.
#
# There are no path options left to bake or to guard against injection — see README.md's "Why
# there are no path options". The two greps in case 1 are what replaced the bake guard: a rename
# of either path on one side of the pair fails here rather than silently producing a Feature that
# seeds a directory nothing reads.
set -uo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

# --- stubs: curl (no network) and runuser (no real privilege switch) ---------------------------
#
# Real runuser/su need root and a real target user, neither available here — that half is left
# to test/run-features-test.sh under Docker. The stub still runs the installer script for real
# (via `bash`), just as the current user with $HOME repointed, so everything except the actual
# privilege drop is exercised.
STUBS="$WORK/stubs"
mkdir -p "$STUBS"

cat > "$STUBS/curl" << 'CURL'
#!/bin/sh
echo "curl $*" >> "$CURL_LOG"
[ "${CURL_FAIL:-}" = 1 ] && exit 1
url=""
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
case "$url" in
  *claude*) bin=claude ;;
  *copilot*) bin=copilot ;;
  *herdr*) bin=herdr ;;
  *pi*) bin=pi ;;
  *) bin=unknown ;;
esac
# The emitted script runs in the installer's own environment, so having it record what it was
# handed is how the node prelude's two guarantees — node on PATH, npm's global prefix pinned to
# ~/.local — get asserted without a real installer.
#
# The fake binary it drops also logs its own future invocations to $CLI_INVOKE_LOG (when set)
# and exits with $FAKE_BIN_EXIT (default 0). install.sh itself never invokes pi/herdr by bare
# name any more — piPackages/herdrPlugins installs moved to create time (see
# create_time_plugins_test.sh) — so nothing here currently sets FAKE_BIN_EXIT; the mechanism is
# kept generic rather than stripped, since agent-browser's own invoke-log cases below still rely
# on the same fake-binary shape.
cat << SCRIPT
printf '$bin npm_config_prefix=%s\\n' "\$npm_config_prefix" >> "\$INSTALLER_ENV_LOG"
printf '$bin node=%s\\n' "\$(command -v node || echo none)" >> "\$INSTALLER_ENV_LOG"
printf '$bin CLAUDE_CONFIG_DIR=%s\\n' "\${CLAUDE_CONFIG_DIR:-unset}" >> "\$INSTALLER_ENV_LOG"
mkdir -p "\$HOME/.local/bin"
printf '#!/bin/sh\necho "$bin \$*" >> "\${CLI_INVOKE_LOG:-/dev/null}"\nexit "\${FAKE_BIN_EXIT:-0}"\n' > "\$HOME/.local/bin/$bin"
chmod +x "\$HOME/.local/bin/$bin"
SCRIPT
CURL
chmod +x "$STUBS/curl"

# install_npm_cli (agent-browser) runs `npm install -g <pkg>` directly, not piped into a second
# shell the way curl's installer scripts are — so, unlike the curl stub above, this one performs
# its side effects itself rather than printing a script for something else to execute.
cat > "$STUBS/npm" << 'NPM'
#!/bin/sh
echo "npm $*" >> "$NPM_LOG"
[ "${NPM_FAIL:-}" = 1 ] && exit 1
pkg=""
for a in "$@"; do case "$a" in -*|install) ;; *) pkg="$a" ;; esac; done
case "$pkg" in
  agent-browser) bin=agent-browser ;;
  *) bin=unknown ;;
esac
# Same two prelude guarantees the curl stub records: npm's global prefix pinned, node found.
printf '%s npm_config_prefix=%s\n' "$bin" "$npm_config_prefix" >> "$INSTALLER_ENV_LOG"
printf '%s node=%s\n' "$bin" "$(command -v node || echo none)" >> "$INSTALLER_ENV_LOG"
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/$bin" << FAKEBIN
#!/bin/sh
echo "$bin \$*" >> "\${CLI_INVOKE_LOG:-/dev/null}"
exit "\${FAKE_BIN_EXIT:-0}"
FAKEBIN
chmod +x "$HOME/.local/bin/$bin"
NPM
chmod +x "$STUBS/npm"

cat > "$STUBS/runuser" << 'RUNUSER'
#!/bin/sh
echo "runuser $*" >> "$RUNUSER_LOG"
while [ $# -gt 0 ]; do
  case "$1" in
    -l) shift; user="$1"; shift ;;
    -c) shift; cmd="$1"; shift ;;
    *) shift ;;
  esac
done
echo "$user" >> "$RUNUSER_USER_LOG"
# A real `runuser -l`/`su -` starts a login shell, and a login shell on a devcontainers base
# image sources ~/.profile, which adds ~/.local/bin to PATH once that directory exists (Ubuntu's
# stock .profile does exactly this). This stub does not source any profile, so it approximates
# that one effect directly — the one later steps in this suite (piPackages, herdrPlugins) depend
# on: a CLI installed in an earlier run_as_remote_user call must be findable by bare name in a
# later one, the same as it would be in a real container.
HOME="$FAKE_REMOTE_HOME" PATH="$FAKE_REMOTE_HOME/.local/bin:$PATH" bash -c "$cmd"
RUNUSER
chmod +x "$STUBS/runuser"

# This devcontainer has a real `claude` (and possibly `copilot`/`pi`) already on PATH — this file
# IS this Feature's own test suite, run inside a container built from an `agents`-like setup.
# Left in the PATH handed down to install.sh, the installer's own idempotent
# `! command -v claude` guard would find the real one and skip the fake install silently, so every
# case below would "pass" without curl ever running. Strip those directories out.
CLEAN_PATH="$PATH"
for real_bin in claude copilot pi herdr; do
  real_path="$(command -v "$real_bin" 2> /dev/null || true)"
  if [ -n "$real_path" ]; then
    real_dir="$(dirname "$real_path")"
    CLEAN_PATH="$(printf '%s' "$CLEAN_PATH" | tr ':' '\n' | grep -vxF "$real_dir" | paste -sd: -)"
  fi
done

# --- a fake node toolchain, and a fake nvm that puts it on PATH --------------------------------
#
# The node prelude in install.sh only checks that `node` and `npm` are *findable*; the real
# installer that would use them is itself stubbed above. So these need to be no more than
# executable files with the right names.
NODE_STUBS="$WORK/node-stubs"
mkdir -p "$NODE_STUBS"
cat > "$NODE_STUBS/node" << 'FAKENODE'
#!/bin/sh
# The prelude calls `node -e <compare script> <min>` to gate on version, and `node --version`
# only to name what it found. FAKE_NODE_TOO_OLD=1 makes the gate say "too old" without needing a
# second real Node.js installed just for this.
case "${1:-}" in
  -e) [ "${FAKE_NODE_TOO_OLD:-}" = 1 ] && exit 1; exit 0 ;;
  --version) echo "${FAKE_NODE_VERSION:-v99.0.0}" ;;
  *) echo fake-node ;;
esac
FAKENODE
printf '#!/bin/sh\necho fake-npm\n' > "$NODE_STUBS/npm"
chmod +x "$NODE_STUBS/node" "$NODE_STUBS/npm"

# This devcontainer has a real node on PATH (and a real /usr/local/share/nvm), which is what
# makes the prelude's happy path testable at all — and, in the other direction, is why the
# "no node and no nvm anywhere" failure arm is NOT testable here: the prelude would find the
# container's own nvm and succeed. That arm is left to a real container, and the paired-constant
# grep below is what guards the part of it this harness can reach.
NO_NODE_PATH="$CLEAN_PATH"
for real_bin in node npm; do
  real_path="$(command -v "$real_bin" 2> /dev/null || true)"
  if [ -n "$real_path" ]; then
    real_dir="$(dirname "$real_path")"
    NO_NODE_PATH="$(printf '%s' "$NO_NODE_PATH" | tr ':' '\n' | grep -vxF "$real_dir" | paste -sd: -)"
  fi
done

# setup <name> [VAR=value ...] — run the real install.sh with this case's env, into a fresh
# SHARE_DIR and a fresh fake remote-user HOME. $CASE/share itself is deliberately NOT
# pre-created: on a real image, /usr/local/share/devc-features/agents does not exist before
# install.sh runs, and install.sh is the one that has to create it before writing anything
# under it (a real bug: it once wrote pi-packages.conf/herdr-plugins.conf straight into
# SHARE_DIR with no mkdir -p first, which every case here missed because this pre-created the
# directory for it).
setup() {
  local name="$1"; shift
  CASE="$WORK/$name"
  rm -rf "$CASE"
  mkdir -p "$CASE/home"
  : > "$CASE/curl.log"; : > "$CASE/runuser.log"; : > "$CASE/runuser_user.log"
  : > "$CASE/installer_env.log"; : > "$CASE/npm.log"
  env -u INSTALLCLAUDECLI -u INSTALLCOPILOTCLI -u INSTALLPICLI \
    -u INSTALLHERDR -u PIPACKAGES -u HERDRPLUGINS \
    -u INSTALLAGENTBROWSER -u AGENTBROWSERCHROME \
    SHARE_DIR="$CASE/share" \
    _REMOTE_USER="$(id -un)" _REMOTE_USER_HOME="$CASE/home" \
    FAKE_REMOTE_HOME="$CASE/home" \
    CURL_LOG="$CASE/curl.log" RUNUSER_LOG="$CASE/runuser.log" RUNUSER_USER_LOG="$CASE/runuser_user.log" \
    INSTALLER_ENV_LOG="$CASE/installer_env.log" CLI_INVOKE_LOG="$CASE/invoke.log" \
    NPM_LOG="$CASE/npm.log" \
    CLAUDE_CONFIG_DIR=/decoy/inherited-from-the-build-env \
    PATH="${CASE_PATH:-$STUBS:$CLEAN_PATH}" \
    "$@" sh "$FEATURE_DIR/install.sh" > "$CASE/install.log" 2> "$CASE/install.err"
  status=$?
  HOOK="$CASE/share/post-create.sh"
  INVOKE_LOG="$CASE/invoke.log"
}

echo "case 1: bare install — defaults"
setup c1
check "install.sh exits 0" test "$status" -eq 0
check "post-create.sh installed" test -f "$HOOK"
check "the hook derives CLAUDE_DIR from \$HOME rather than a baked path" \
  grep -qxF 'CLAUDE_DIR="$HOME/.claude"' "$HOOK"
check "the hook names the same seed path install.sh creates" \
  grep -qxF 'SEED=/usr/local/share/devc-features/agents/claude-seed' "$HOOK"
# The manifest declares a volume at a literal target (no substitution variable names the remote
# user's home — see declared-volume-spike M1). The hook does not compare paths against that
# literal: it asks whether ~/.claude is genuinely a mount point, which is also correct when a
# consumer declared the mount themselves. These assertions stop the two drifting apart.
check "the manifest declares the literal conventional target" \
  grep -qF '"target": "/home/vscode/.claude"' "$FEATURE_DIR/devcontainer-feature.json"
check "the hook decides by testing the mount, not by comparing to a path" \
  grep -qF 'claude_dir_is_mounted "$HOME/.claude"' "$HOOK"
check "the hook pins no literal home" bash -c "! grep -q 'DECLARED_CLAUDE_DIR' \"$HOOK\""
check "the manifest keys its volume on \${devcontainerId}, not the workspace basename" \
  grep -qF '"source": "claude-code-config-${devcontainerId}"' "$FEATURE_DIR/devcontainer-feature.json"
# containerEnv is what replaced the old ~/.claude.json symlink fold: Claude Code writes
# .claude.json into $CLAUDE_CONFIG_DIR, so pointing that at the volume's own target is what makes
# one mount capture everything. The value must be the same literal the mount target above names —
# a Feature's containerEnv is baked as a build-time Dockerfile ENV, so no substitution reaches it.
check "the manifest declares containerEnv with the same literal the mount targets" \
  grep -qF '"CLAUDE_CONFIG_DIR": "/home/vscode/.claude"' "$FEATURE_DIR/devcontainer-feature.json"
check "the hook no longer folds ~/.claude.json — nothing left to relocate" \
  bash -c "! grep -q 'claude.json' \"$HOOK\""
check "the seed mount point was created, empty" test -d "$CASE/share/claude-seed"
check "the seed mount point really is empty" \
  test -z "$(ls -A "$CASE/share/claude-seed")"
check "~/.claude was pre-created" test -d "$WORK/c1/home/.claude"
check "claude was installed (curl invoked once)" test "$(wc -l < "$WORK/c1/curl.log")" -eq 1
check "claude binary landed under the fake remote HOME" test -x "$WORK/c1/home/.local/bin/claude"
check "copilot was NOT installed — installCopilotCli defaults false" \
  test ! -e "$WORK/c1/home/.local/bin/copilot"
check "pi was NOT installed — installPiCli defaults false" \
  test ! -e "$WORK/c1/home/.local/bin/pi"
check "agent-browser was NOT installed — installAgentBrowser defaults false" \
  test ! -e "$WORK/c1/home/.local/bin/agent-browser"
check "no npm invocation happened — agentBrowserChrome's non-empty default is ignored" \
  test ! -s "$WORK/c1/npm.log"
check "the CLI install ran as the configured remote user" \
  grep -qxF "$(id -un)" "$WORK/c1/runuser_user.log"
# A real `runuser -l`/`su -` is a *login* shell and clears the environment, so the manifest's
# baked CLAUDE_CONFIG_DIR ENV never reaches the installer — and the Claude installer ends by
# running `claude install`, which writes .claude.json wherever that variable points. install.sh
# re-exports it, derived from the remote user's home. Without that the image would ship a
# build-time ~/.claude.json beside the volume, which is exactly what this Feature stopped doing.
# The decoy value in setup() is what makes this an assertion about the export, not the ambient env.
check "the Claude installer saw CLAUDE_CONFIG_DIR pointing into the remote user's ~/.claude" \
  grep -qxF "claude CLAUDE_CONFIG_DIR=$WORK/c1/home/.claude" "$WORK/c1/installer_env.log"

echo "case 2: installCopilotCli=true — both CLIs land"
setup c2 INSTALLCOPILOTCLI=true
check "install.sh exits 0" test "$status" -eq 0
check "claude installed" test -x "$WORK/c2/home/.local/bin/claude"
check "copilot installed too" test -x "$WORK/c2/home/.local/bin/copilot"
check "curl invoked twice (claude, then copilot)" test "$(wc -l < "$WORK/c2/curl.log")" -eq 2

echo "case 2b: installPiCli=true — all three CLIs land"
setup c2b INSTALLCOPILOTCLI=true INSTALLPICLI=true
check "install.sh exits 0" test "$status" -eq 0
check "claude installed" test -x "$WORK/c2b/home/.local/bin/claude"
check "copilot installed too" test -x "$WORK/c2b/home/.local/bin/copilot"
check "pi installed too" test -x "$WORK/c2b/home/.local/bin/pi"
check "curl invoked three times (claude, copilot, pi)" \
  test "$(wc -l < "$WORK/c2b/curl.log")" -eq 3
# The npm-installed CLI is the only one that gets the node prelude, so exactly one env record is
# written — and it must show npm's global prefix pinned. Unpinned, npm under nvm would resolve
# the prefix to the *active node version's* directory and drop pi out of PATH on the next
# version switch; see install.sh's prelude.
check "the pi install pinned npm's global prefix to the fake remote ~/.local" \
  grep -qxF "pi npm_config_prefix=$WORK/c2b/home/.local" "$WORK/c2b/installer_env.log"
check "and claude's install got no prelude — the pin is scoped to the npm-installed CLI" \
  grep -qxF "claude npm_config_prefix=" "$WORK/c2b/installer_env.log"

echo "case 2c: node is not on PATH — the prelude sources nvm and finds it"
# The real-world build-time case, and the bug this prelude exists for: the node Feature has
# installed node, but it is wired into /etc/bash.bashrc, which a non-interactive shell like the
# installer's never sources. Point NVM_DIR at a fake nvm.sh (the first entry the prelude probes)
# and hand install.sh a PATH with no node on it at all.
rm -rf "${WORK:?}/c2c"
mkdir -p "$WORK/c2c/home/.nvm"
: > "$WORK/c2c/curl.log"; : > "$WORK/c2c/runuser.log"; : > "$WORK/c2c/runuser_user.log"
: > "$WORK/c2c/installer_env.log"
printf 'export PATH="%s:$PATH"\n' "$NODE_STUBS" > "$WORK/c2c/home/.nvm/nvm.sh"
env -u INSTALLCLAUDECLI -u INSTALLCOPILOTCLI -u INSTALLPICLI \
  SHARE_DIR="$WORK/c2c/share" _REMOTE_USER="$(id -un)" _REMOTE_USER_HOME="$WORK/c2c/home" \
  FAKE_REMOTE_HOME="$WORK/c2c/home" CURL_LOG="$WORK/c2c/curl.log" \
  RUNUSER_LOG="$WORK/c2c/runuser.log" RUNUSER_USER_LOG="$WORK/c2c/runuser_user.log" \
  INSTALLER_ENV_LOG="$WORK/c2c/installer_env.log" NVM_DIR="$WORK/c2c/home/.nvm" \
  INSTALLCLAUDECLI=false INSTALLPICLI=true PATH="$STUBS:$NO_NODE_PATH" \
  sh "$FEATURE_DIR/install.sh" > "$WORK/c2c/install.log" 2> "$WORK/c2c/install.err"
status=$?
check "install.sh exits 0 — nvm supplied the toolchain" test "$status" -eq 0
check "pi installed" test -x "$WORK/c2c/home/.local/bin/pi"
check "the installer really saw the nvm-supplied node, not one already on PATH" \
  grep -qxF "pi node=$NODE_STUBS/node" "$WORK/c2c/installer_env.log"

echo "case 2d: node is present but too old — the build fails naming the version"
# Without this gate the installer's own preflight would fail, exit 1, and install_cli could only
# report it as "network required" — the misleading message the whole prelude exists to stop.
rm -rf "${WORK:?}/c2e"
mkdir -p "$WORK/c2e/home/.nvm"
: > "$WORK/c2e/curl.log"; : > "$WORK/c2e/runuser.log"; : > "$WORK/c2e/runuser_user.log"
: > "$WORK/c2e/installer_env.log"
printf 'export PATH="%s:$PATH"\n' "$NODE_STUBS" > "$WORK/c2e/home/.nvm/nvm.sh"
env -u INSTALLCLAUDECLI -u INSTALLCOPILOTCLI -u INSTALLPICLI \
  SHARE_DIR="$WORK/c2e/share" _REMOTE_USER="$(id -un)" _REMOTE_USER_HOME="$WORK/c2e/home" \
  FAKE_REMOTE_HOME="$WORK/c2e/home" CURL_LOG="$WORK/c2e/curl.log" \
  RUNUSER_LOG="$WORK/c2e/runuser.log" RUNUSER_USER_LOG="$WORK/c2e/runuser_user.log" \
  INSTALLER_ENV_LOG="$WORK/c2e/installer_env.log" NVM_DIR="$WORK/c2e/home/.nvm" \
  FAKE_NODE_TOO_OLD=1 FAKE_NODE_VERSION=v20.20.2 \
  INSTALLCLAUDECLI=false INSTALLPICLI=true PATH="$STUBS:$NO_NODE_PATH" \
  sh "$FEATURE_DIR/install.sh" > "$WORK/c2e/install.log" 2> "$WORK/c2e/install.err"
status=$?
check "install.sh exits non-zero" test "$status" -ne 0
check "it names the version it needs and the one it found" \
  grep -q 'needs Node.js 22.19.0 or newer; the container has v20.20.2' "$WORK/c2e/install.err"
check "it does NOT blame the network" \
  bash -c "! grep -q 'network required' '$WORK/c2e/install.err'"
check "the installer was never downloaded — the gate ran first" \
  test ! -s "$WORK/c2e/curl.log"

echo "case 2e: the node prelude and install.sh agree on the toolchain-missing exit code"
# The "no node and no nvm anywhere" arm cannot run here — see the NO_NODE_PATH comment above.
# What this harness can still guard is the pair of constants that arm depends on: the prelude
# exits with a code install.sh must recognize, and a rename on one side alone would silently
# turn a missing toolchain back into the misleading "network required" message.
check "install.sh declares the toolchain-missing status" \
  grep -qxF 'NODE_MISSING_STATUS=78' "$FEATURE_DIR/install.sh"
check "and the prelude exits with that same code" \
  grep -qxF '  exit 78' "$FEATURE_DIR/install.sh"
check "the prelude names Node.js in its failure messages, not the network" \
  grep -q 'Node.js \$NODE_MIN or newer and npm are required' "$FEATURE_DIR/install.sh"
check "and the minimum pi is installed with is the version its package declares" \
  grep -q 'install_cli Pi pi https://pi.dev/install.sh 22.19.0' "$FEATURE_DIR/install.sh"

echo "case 3: installClaudeCli=false, installCopilotCli=false, installPiCli=false — no CLI installed, no curl at all"
setup c3 INSTALLCLAUDECLI=false
check "install.sh exits 0" test "$status" -eq 0
check "no curl invocation happened" test ! -s "$WORK/c3/curl.log"
check "claude was not installed" test ! -e "$WORK/c3/home/.local/bin/claude"
check "~/.claude is still pre-created regardless" test -d "$WORK/c3/home/.claude"
check "and so is the seed mount point" test -d "$WORK/c3/share/claude-seed"

echo "case 4: the CLI is already installed — the idempotent guard skips curl entirely"
# Deliberately not calling setup() here — it runs the real install.sh once by itself, which
# would install the fake claude first and make "curl was never invoked" pass for the wrong
# reason. Build this case's directories by hand instead, so install.sh runs exactly once.
rm -rf "${WORK:?}/c4"
mkdir -p "$WORK/c4/home/.local/bin"
printf '#!/bin/sh\necho already-there\n' > "$WORK/c4/home/.local/bin/claude"
chmod +x "$WORK/c4/home/.local/bin/claude"
env -u INSTALLCLAUDECLI -u INSTALLCOPILOTCLI -u INSTALLPICLI \
  SHARE_DIR="$WORK/c4/share" _REMOTE_USER="$(id -un)" _REMOTE_USER_HOME="$WORK/c4/home" \
  FAKE_REMOTE_HOME="$WORK/c4/home" CURL_LOG="$WORK/c4/curl.log" RUNUSER_LOG="$WORK/c4/runuser.log" \
  RUNUSER_USER_LOG="$WORK/c4/runuser_user.log" INSTALLER_ENV_LOG="$WORK/c4/installer_env.log" \
  PATH="$STUBS:$CLEAN_PATH" \
  sh "$FEATURE_DIR/install.sh" > "$WORK/c4/install.log" 2> "$WORK/c4/install.err"
status=$?
check "install.sh still exits 0" test "$status" -eq 0
check "curl was never invoked — already installed" test ! -s "$WORK/c4/curl.log"
check "the pre-existing binary is untouched" \
  test "$(cat "$WORK/c4/home/.local/bin/claude")" = "$(printf '#!/bin/sh\necho already-there')"

echo "case 5: a failed download fails the build"
setup c5 CURL_FAIL=1
check "install.sh exits non-zero" test "$status" -ne 0
check "it names the failure" grep -q 'network required' "$WORK/c5/install.err"
check "no post-create.sh was left half-installed" test ! -f "$HOOK"

echo "case 6: a failed download with all CLIs disabled does not matter — curl is never reached"
setup c6 INSTALLCLAUDECLI=false CURL_FAIL=1
check "install.sh exits 0" test "$status" -eq 0

echo "case 7: piPackages empty (the default) with installPiCli=true — a no-op, no pi invocation"
setup c7 INSTALLPICLI=true
check "install.sh exits 0" test "$status" -eq 0
check "pi CLI itself still installed" test -x "$WORK/c7/home/.local/bin/pi"

echo "case 8: piPackages set, installPiCli left at its default false — a hard error, not a silent skip"
setup c8 PIPACKAGES=npm:some-package
check "install.sh exits non-zero" test "$status" -ne 0
check "the error names piPackages" grep -q 'piPackages' "$WORK/c8/install.err"
check "and names installPiCli" grep -q 'installPiCli' "$WORK/c8/install.err"
check "no post-create.sh was left half-installed" test ! -f "$WORK/c8/share/post-create.sh"
check "the gate ran before any download" test ! -s "$WORK/c8/curl.log"

echo "case 9: herdrPlugins set, installHerdr left at its default false — a hard error, not a silent skip"
setup c9 HERDRPLUGINS=owner/repo
check "install.sh exits non-zero" test "$status" -ne 0
check "the error names herdrPlugins" grep -q 'herdrPlugins' "$WORK/c9/install.err"
check "and names installHerdr" grep -q 'installHerdr' "$WORK/c9/install.err"
check "the gate ran before any download" test ! -s "$WORK/c9/curl.log"

echo "case 10: piPackages with installPiCli=true — persisted verbatim, not installed at build time"
# The actual `pi install` no longer happens here at all — see create-time-plugins.sh, tested
# separately in create_time_plugins_test.sh. What install.sh still owns is validating the
# installPiCli pairing (case 8) and persisting the raw, un-comma-split option string for
# post-create.sh to read later — comma-splitting and trimming happen at create time now.
setup c10 INSTALLPICLI=true \
  PIPACKAGES=" npm:@andrewjacop/pi-herdr ,,git:github.com/bmingles/pi-dev-extensions@main, "
check "install.sh exits 0" test "$status" -eq 0
check "pi CLI itself was installed" test -x "$WORK/c10/home/.local/bin/pi"
check "no pi install invocation happened at build time" \
  test ! -s "$INVOKE_LOG"
check "the raw option string was persisted verbatim, for post-create.sh to parse" \
  test "$(cat "$WORK/c10/share/pi-packages.conf")" = \
  " npm:@andrewjacop/pi-herdr ,,git:github.com/bmingles/pi-dev-extensions@main, "

echo "case 11: piPackages empty — no pi-packages.conf is written at all"
setup c11 INSTALLPICLI=true
check "install.sh exits 0" test "$status" -eq 0
check "no conf file for an empty option" test ! -e "$WORK/c11/share/pi-packages.conf"

echo "case 12: herdrPlugins with installHerdr=true — persisted verbatim, not installed at build time"
setup c12 INSTALLHERDR=true \
  HERDRPLUGINS=" bmingles/herdr-plugins/agent-caffeinate , owner/repo/sub,"
check "install.sh exits 0" test "$status" -eq 0
check "herdr CLI itself was installed" test -x "$WORK/c12/home/.local/bin/herdr"
check "no herdr plugin install invocation happened at build time" \
  test ! -s "$INVOKE_LOG"
check "the raw option string was persisted verbatim, for post-create.sh to parse" \
  test "$(cat "$WORK/c12/share/herdr-plugins.conf")" = \
  " bmingles/herdr-plugins/agent-caffeinate , owner/repo/sub,"

echo "case 13: herdrPlugins empty — no herdr-plugins.conf is written at all"
setup c13 INSTALLHERDR=true
check "install.sh exits 0" test "$status" -eq 0
check "no conf file for an empty option" test ! -e "$WORK/c13/share/herdr-plugins.conf"

echo "case 14: installAgentBrowser=true — installed with npm, under the node prelude"
# agentBrowserChrome=none isolates install_npm_cli from install_agent_browser_chrome, so this
# case pins down only the CLI install half.
setup c14 INSTALLAGENTBROWSER=true AGENTBROWSERCHROME=none
check "install.sh exits 0" test "$status" -eq 0
check "npm install -g agent-browser ran" grep -qxF 'npm install -g agent-browser' "$WORK/c14/npm.log"
check "under the fake remote ~/.local prefix" \
  grep -qxF "agent-browser npm_config_prefix=$WORK/c14/home/.local" "$WORK/c14/installer_env.log"
check "with node on PATH" \
  bash -c "! grep -qxF 'agent-browser node=none' '$WORK/c14/installer_env.log'"
check "agent-browser landed under the fake remote HOME" \
  test -x "$WORK/c14/home/.local/bin/agent-browser"
check "no browser-install invocation reached the fake binary — agentBrowserChrome=none" \
  test ! -s "$WORK/c14/invoke.log"

echo "case 15: agent-browser already installed — the idempotent guard skips npm entirely"
rm -rf "${WORK:?}/c15"
mkdir -p "$WORK/c15/home/.local/bin"
printf '#!/bin/sh\necho already-there\n' > "$WORK/c15/home/.local/bin/agent-browser"
chmod +x "$WORK/c15/home/.local/bin/agent-browser"
env -u INSTALLCLAUDECLI -u INSTALLCOPILOTCLI -u INSTALLPICLI -u INSTALLHERDR \
  SHARE_DIR="$WORK/c15/share" _REMOTE_USER="$(id -un)" _REMOTE_USER_HOME="$WORK/c15/home" \
  FAKE_REMOTE_HOME="$WORK/c15/home" CURL_LOG="$WORK/c15/curl.log" RUNUSER_LOG="$WORK/c15/runuser.log" \
  RUNUSER_USER_LOG="$WORK/c15/runuser_user.log" INSTALLER_ENV_LOG="$WORK/c15/installer_env.log" \
  NPM_LOG="$WORK/c15/npm.log" \
  INSTALLCLAUDECLI=false INSTALLAGENTBROWSER=true AGENTBROWSERCHROME=none \
  PATH="$STUBS:$CLEAN_PATH" \
  sh "$FEATURE_DIR/install.sh" > "$WORK/c15/install.log" 2> "$WORK/c15/install.err"
status=$?
check "install.sh exits 0" test "$status" -eq 0
check "npm was never invoked — already installed" test ! -s "$WORK/c15/npm.log"
check "the pre-existing binary is untouched" \
  test "$(cat "$WORK/c15/home/.local/bin/agent-browser")" = "$(printf '#!/bin/sh\necho already-there')"

echo "case 16: npm install fails — the build fails, naming it (not the network)"
setup c16 NPM_FAIL=1 INSTALLAGENTBROWSER=true AGENTBROWSERCHROME=none
check "install.sh exits non-zero" test "$status" -ne 0
check "it names the failure" grep -q 'network required' "$WORK/c16/install.err"

echo "case 17: node too old for agent-browser — the build fails naming the version, not the network"
# Same shape as case 2d/2e for pi: install_npm_cli shares node_prelude, so a too-old Node hits
# the identical gate before npm is ever invoked.
rm -rf "${WORK:?}/c17"
mkdir -p "$WORK/c17/home/.nvm"
: > "$WORK/c17/curl.log"; : > "$WORK/c17/runuser.log"; : > "$WORK/c17/runuser_user.log"
: > "$WORK/c17/installer_env.log"; : > "$WORK/c17/npm.log"
printf 'export PATH="%s:$PATH"\n' "$NODE_STUBS" > "$WORK/c17/home/.nvm/nvm.sh"
env -u INSTALLCLAUDECLI -u INSTALLCOPILOTCLI -u INSTALLPICLI \
  SHARE_DIR="$WORK/c17/share" _REMOTE_USER="$(id -un)" _REMOTE_USER_HOME="$WORK/c17/home" \
  FAKE_REMOTE_HOME="$WORK/c17/home" CURL_LOG="$WORK/c17/curl.log" \
  RUNUSER_LOG="$WORK/c17/runuser.log" RUNUSER_USER_LOG="$WORK/c17/runuser_user.log" \
  INSTALLER_ENV_LOG="$WORK/c17/installer_env.log" NPM_LOG="$WORK/c17/npm.log" \
  NVM_DIR="$WORK/c17/home/.nvm" FAKE_NODE_TOO_OLD=1 FAKE_NODE_VERSION=v20.20.2 \
  INSTALLCLAUDECLI=false INSTALLAGENTBROWSER=true AGENTBROWSERCHROME=none \
  PATH="$STUBS:$NO_NODE_PATH" \
  sh "$FEATURE_DIR/install.sh" > "$WORK/c17/install.log" 2> "$WORK/c17/install.err"
status=$?
check "install.sh exits non-zero" test "$status" -ne 0
check "it names the version it needs and the one it found" \
  grep -q 'needs Node.js 22.19.0 or newer; the container has v20.20.2' "$WORK/c17/install.err"
check "it does NOT blame the network" \
  bash -c "! grep -q 'network required' '$WORK/c17/install.err'"
check "npm was never invoked — the gate ran first" test ! -s "$WORK/c17/npm.log"

echo "case 18: agentBrowserChrome=with-deps (the default) — installed with --with-deps"
setup c18 INSTALLAGENTBROWSER=true AGENTBROWSERCHROME=with-deps
check "install.sh exits 0" test "$status" -eq 0
check "the browser install ran with --with-deps" \
  grep -qxF 'agent-browser install --with-deps' "$WORK/c18/invoke.log"
check "exactly one browser-install invocation reached the fake binary" \
  test "$(grep -c '^agent-browser install' "$WORK/c18/invoke.log")" -eq 1

echo "case 19: agentBrowserChrome=browser-only — installed with no flag"
setup c19 INSTALLAGENTBROWSER=true AGENTBROWSERCHROME=browser-only
check "install.sh exits 0" test "$status" -eq 0
check "the browser install ran with no flag" \
  grep -qxF 'agent-browser install' "$WORK/c19/invoke.log"
check "with-deps was NOT passed" \
  bash -c "! grep -q -- '--with-deps' '$WORK/c19/invoke.log'"

echo "case 20: agentBrowserChrome=none — no browser install at all"
setup c20 INSTALLAGENTBROWSER=true AGENTBROWSERCHROME=none
check "install.sh exits 0" test "$status" -eq 0
check "no browser-install invocation reached the fake binary" test ! -s "$WORK/c20/invoke.log"

echo "case 21: agentBrowserChrome set, installAgentBrowser left at its default false — the" \
  "documented ignore, not a die"
# Unlike piPackages/herdrPlugins, this option has a non-empty default, so install.sh cannot tell
# an explicit value from the default it was handed — it is read only when installAgentBrowser is
# true and silently ignored otherwise (see the option's own description and the README), so this
# must exit 0 with no npm or agent-browser invocation at all rather than a build failure.
setup c21 AGENTBROWSERCHROME=with-deps
check "install.sh exits 0 — not a die" test "$status" -eq 0
check "no npm invocation happened" test ! -s "$WORK/c21/npm.log"
check "agent-browser was not installed" test ! -e "$WORK/c21/home/.local/bin/agent-browser"

# Not covered here: herdrPlugins with git absent from PATH. install_herdr_plugins's `have git`
# guard is straightforward to read, but faking "no git" offline is not: this container's PATH
# has git in /usr/local/bin, /usr/bin AND /bin, and /bin and /usr/bin also carry sh, bash, and
# most of the coreutils this harness itself depends on (usrmerge) — stripping every directory
# that resolves git strips the shell out from under the test too. Left to a real container in
# test/run-features-test.sh, where a base image legitimately lacking git is a realistic case.

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
