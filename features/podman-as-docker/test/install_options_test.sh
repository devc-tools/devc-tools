#!/bin/bash
# install.sh end to end, offline — every option's effect on the generated config files and
# the baked create/start scripts, the validation guards, and the mutual-exclusion check.
#
#   bash features/podman-as-docker/test/install_options_test.sh
#
# No Docker, no root, no real network: every absolute system path install.sh writes to
# (SHARE_DIR, SOCKET_DIR, GRAPHROOT_DIR, SUBUID_FILE, SUBGID_FILE, CONTAINERS_ETC_DIR) is
# redirected into a temp directory, and apt-get is stubbed on PATH ahead of the real one so
# no package is actually fetched — see run_install below.
set -uo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="$FEATURE_DIR/install.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

STUB_BIN="$WORK/stub-bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/apt-get" << 'EOF'
#!/bin/sh
echo "apt-get $*" >> "$APT_LOG"
exit 0
EOF
chmod +x "$STUB_BIN/apt-get"

# run_install <name> [VAR=value ...] — sets $share, $sockdir, $graphroot, $subuid, $subgid,
# $etcdir, $status, $log. Nothing here is a real system path.
run_install() {
  local name="$1"; shift
  share="$WORK/$name.share"
  sockdir="$WORK/$name.sock"
  graphroot="$WORK/$name.graph"
  subuid="$WORK/$name.subuid"
  subgid="$WORK/$name.subgid"
  etcdir="$WORK/$name.etc"
  log="$WORK/$name.log"
  APT_LOG="$WORK/$name.apt.log"
  : > "$APT_LOG"
  # A minimal PATH, not the host's own: on a dev machine with real Docker installed,
  # prepending the stub dir to $PATH still leaves the host's real `docker` reachable,
  # which trips the mutual-exclusion guard even in cases that have nothing to do with it.
  # /usr/bin:/bin carries every POSIX utility this script needs and no `docker`.
  env -u DOCKERSHIM -u STORAGEDRIVER -u ROOTLESSNETWORKCMD -u UNQUALIFIEDSEARCHREGISTRIES \
    -u DOCKERAPISOCKET -u COMPOSEPROVIDER -u SILENCEEMULATIONNOTICE \
    PATH="$STUB_BIN:/usr/bin:/bin" APT_LOG="$APT_LOG" \
    SHARE_DIR="$share" SOCKET_DIR="$sockdir" GRAPHROOT_DIR="$graphroot" \
    SUBUID_FILE="$subuid" SUBGID_FILE="$subgid" CONTAINERS_ETC_DIR="$etcdir" \
    "$@" sh "$INSTALL" > "$log" 2>&1
  status=$?
}

echo "case 1: a bare {} — defaults, every generated file"
run_install c1
check "install.sh succeeds" test "$status" -eq 0
check "post-create.sh is installed" test -f "$share/post-create.sh"
check "post-start.sh is installed" test -f "$share/post-start.sh"
check "both are executable" bash -c "[ -x '$share/post-create.sh' ] && [ -x '$share/post-start.sh' ]"
check "both still parse as shell" bash -c "sh -n '$share/post-create.sh' && sh -n '$share/post-start.sh'"

check "apt-get install requested podman" grep -q 'install.*podman' "$WORK/c1.apt.log"
check "  and podman-docker (dockerShim defaults true)" grep -q 'podman-docker' "$WORK/c1.apt.log"
check "  and fuse-overlayfs (defensive, unconditional)" grep -q 'fuse-overlayfs' "$WORK/c1.apt.log"
check "  and no compose package (composeProvider defaults none)" bash -c \
  "! grep -qE 'podman-compose|docker-compose' '$WORK/c1.apt.log'"

check "registries.conf.d defaults to docker.io" grep -qxF \
  'unqualified-search-registries = ["docker.io"]' \
  "$etcdir/registries.conf.d/99-devc-podman-as-docker.conf"
check "  short-name-mode is permissive" grep -qxF 'short-name-mode = "permissive"' \
  "$etcdir/registries.conf.d/99-devc-podman-as-docker.conf"

check "nodocker exists (silenceEmulationNotice defaults true)" test -e "$etcdir/nodocker"

check "containers.conf.d defaults netns to host" grep -qxF 'netns = "host"' \
  "$etcdir/containers.conf.d/99-devc-podman-as-docker.conf"
check "  and does not set default_rootless_network_cmd" bash -c \
  "! grep -q default_rootless_network_cmd '$etcdir/containers.conf.d/99-devc-podman-as-docker.conf'"

check "subuid gets an entry for root" grep -qxF 'root:100000:65536' "$subuid"
check "subgid gets an entry for root" grep -qxF 'root:100000:65536' "$subgid"

check "socket dir exists, mode 0700" bash -c \
  "[ -d '$sockdir' ] && [ \"\$(stat -f '%Lp' '$sockdir' 2>/dev/null || stat -c '%a' '$sockdir')\" = 700 ]"
check "graphroot dir exists" test -d "$graphroot"

check "storageDriver baked into post-create.sh (auto)" grep -qx \
  'STORAGE_DRIVER_OPT="auto"' "$share/post-create.sh"
check "graphroot baked into post-create.sh" grep -qxF \
  "GRAPHROOT_DIR=\"$graphroot\"" "$share/post-create.sh"
check "socket dir baked into post-start.sh" grep -qxF \
  "SOCKET_DIR=\"$sockdir\"" "$share/post-start.sh"
check "dockerApiSocket baked into post-start.sh (true)" grep -qx \
  'DOCKER_API_SOCKET_OPT="true"' "$share/post-start.sh"

echo "case 2: subuid/subgid already present is left untouched"
mkdir -p "$WORK/c2-fixtures"
printf 'vscode:100000:65536\n' > "$WORK/c2.subuid.seed"
run_install c2
cp "$WORK/c2.subuid.seed" "$subuid"
printf 'vscode:100000:65536\n' > "$subgid"
run_install c2b
check "an already-present entry is not duplicated" bash -c \
  "[ \"\$(grep -c '^root:' '$subuid')\" -le 1 ]"

echo "case 3: unqualifiedSearchRegistries splitting"
run_install c3 UNQUALIFIEDSEARCHREGISTRIES='docker.io, quay.io ,,ghcr.io'
check "trims whitespace and drops empty entries" grep -qxF \
  'unqualified-search-registries = ["docker.io", "quay.io", "ghcr.io"]' \
  "$etcdir/registries.conf.d/99-devc-podman-as-docker.conf"

echo "case 4: rootlessNetworkCmd — host (default), slirp4netns, pasta"
run_install c4a ROOTLESSNETWORKCMD=slirp4netns
check "slirp4netns: netns is private" grep -qxF 'netns = "private"' \
  "$etcdir/containers.conf.d/99-devc-podman-as-docker.conf"
check "  and default_rootless_network_cmd is slirp4netns" grep -qxF \
  'default_rootless_network_cmd = "slirp4netns"' \
  "$etcdir/containers.conf.d/99-devc-podman-as-docker.conf"

run_install c4b ROOTLESSNETWORKCMD=pasta
check "pasta: netns is private" grep -qxF 'netns = "private"' \
  "$etcdir/containers.conf.d/99-devc-podman-as-docker.conf"
check "  and default_rootless_network_cmd is pasta" grep -qxF \
  'default_rootless_network_cmd = "pasta"' \
  "$etcdir/containers.conf.d/99-devc-podman-as-docker.conf"

run_install c4c ROOTLESSNETWORKCMD=nonsense
check "an invalid rootlessNetworkCmd fails the build" test "$status" -ne 0
check "  naming the option" grep -qi rootlessNetworkCmd "$log"

echo "case 5: storageDriver and composeProvider validation"
run_install c5a STORAGEDRIVER=nonsense
check "an invalid storageDriver fails the build" test "$status" -ne 0
run_install c5b COMPOSEPROVIDER=nonsense
check "an invalid composeProvider fails the build" test "$status" -ne 0

echo "case 6: composeProvider package selection"
run_install c6a COMPOSEPROVIDER=podman-compose
check "podman-compose requested" grep -q 'podman-compose' "$WORK/c6a.apt.log"
run_install c6b COMPOSEPROVIDER=docker-compose
check "docker-compose requested" grep -qE 'install.*docker-compose' "$WORK/c6b.apt.log"

echo "case 7: dockerShim false installs no shim, silenceEmulationNotice false skips nodocker"
run_install c7 DOCKERSHIM=false SILENCEEMULATIONNOTICE=false
check "podman-docker not requested" bash -c "! grep -q 'podman-docker' '$WORK/c7.apt.log'"
check "nodocker not created" test ! -e "$etcdir/nodocker"

echo "case 8: mutual exclusion with an existing non-podman docker"
FAKE_DOCKER_BIN="$WORK/fake-docker-bin"
mkdir -p "$FAKE_DOCKER_BIN"
cat > "$FAKE_DOCKER_BIN/docker" << 'EOF'
#!/bin/sh
echo "Docker version 27.4.0, build bde2b89"
EOF
chmod +x "$FAKE_DOCKER_BIN/docker"
share="$WORK/c8.share"; sockdir="$WORK/c8.sock"; graphroot="$WORK/c8.graph"
subuid="$WORK/c8.subuid"; subgid="$WORK/c8.subgid"; etcdir="$WORK/c8.etc"
APT_LOG="$WORK/c8.apt.log"; : > "$APT_LOG"
env -u DOCKERSHIM PATH="$FAKE_DOCKER_BIN:$STUB_BIN:/usr/bin:/bin" APT_LOG="$APT_LOG" \
  SHARE_DIR="$share" SOCKET_DIR="$sockdir" GRAPHROOT_DIR="$graphroot" \
  SUBUID_FILE="$subuid" SUBGID_FILE="$subgid" CONTAINERS_ETC_DIR="$etcdir" \
  sh "$INSTALL" > "$WORK/c8.log" 2>&1
status=$?
check "a pre-existing non-podman docker fails the build" test "$status" -ne 0
check "  naming the conflict" grep -qi "mutually exclusive" "$WORK/c8.log"
check "  and installs nothing" test ! -e "$share/post-create.sh"

echo "case 9: the fixed socket path agrees across the manifest, install.sh and post-start.sh"
SOCKET_DEFAULT=/run/devc-features/podman-as-docker
MANIFEST="$FEATURE_DIR/devcontainer-feature.json"
check "install.sh defaults SOCKET_DIR to the Feature namespace" \
  grep -qF "SOCKET_DIR:-$SOCKET_DEFAULT" "$INSTALL"
check "post-start.sh agrees" grep -qF "SOCKET_DIR:-$SOCKET_DEFAULT" "$FEATURE_DIR/post-start.sh"
check "the manifest's containerEnv DOCKER_HOST names the same socket file" \
  grep -qF "$SOCKET_DEFAULT/podman.sock" "$MANIFEST"
check "post-start.sh writes to that same socket file" \
  grep -qF 'SOCK="$SOCKET_DIR/podman.sock"' "$FEATURE_DIR/post-start.sh"
check "the manifest's postCreateCommand/postStartCommand name where install.sh puts them" \
  bash -c "grep -qF '/usr/local/share/devc-features/podman-as-docker/post-create.sh' '$MANIFEST' &&
            grep -qF '/usr/local/share/devc-features/podman-as-docker/post-start.sh' '$MANIFEST'"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
