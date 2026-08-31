#!/bin/sh
# podman-as-docker Feature install — packages, static config, subuid/subgid, and the
# create-time/start-time scripts.
#
# Runs as root at image *build* time. The workspace is not mounted yet and neither is the
# graphroot volume, so nothing here can decide the storage driver (Step 4/post-create.sh
# does, once the volume is real) or start anything (post-start.sh, every start). What
# lands here is everything that is a build-time fact: which packages exist, the registry
# search path, the network backend default, and the fixed directories this Feature's
# manifest names.
#
# The manifest declares capAdd:["SYS_ADMIN"] and
# securityOpt:["systempaths=unconfined", "apparmor=unconfined"] unconditionally — see
# README.md's privilege-cost section, and the devc-dev sibling repo's
# .plans/implemented/feature-podman-as-docker.md § Step 1 for what was originally
# measured. apparmor=unconfined was added in 0.1.1, after 0.1.0's own CI (a real Linux
# Docker Engine host, unlike the Docker Desktop VM Step 1 was measured on) found the
# docker-default AppArmor profile's blanket "deny mount" rule blocking Podman's own
# mount setup with `permission denied` — invisible on Docker Desktop, which enforces no
# AppArmor profile at all. Nothing in this script grants privilege; it only consumes
# what the manifest already declared.
set -e

die() {
  echo "podman-as-docker: $*" >&2
  exit 1
}

have() { command -v "$1" > /dev/null 2>&1; }

# Every absolute system path this script writes to is overridable, all defaulting to the
# real path — the offline test harness (test/install_options_test.sh) redirects them all
# into a temp directory so it can run this script unprivileged and assert on its output
# without touching a real /etc.
SUBUID_FILE="${SUBUID_FILE:-/etc/subuid}"
SUBGID_FILE="${SUBGID_FILE:-/etc/subgid}"
CONTAINERS_ETC_DIR="${CONTAINERS_ETC_DIR:-/etc/containers}"

# Options reach install.sh uppercased with non-word characters stripped (the CLI's
# getSafeId), and booleans arrive as the strings "true"/"false". Defaults are repeated
# here rather than trusted from the manifest so the script also runs standalone.
DOCKER_SHIM_OPT="${DOCKERSHIM:-true}"
STORAGE_DRIVER_OPT="${STORAGEDRIVER:-auto}"
ROOTLESS_NETWORK_CMD_OPT="${ROOTLESSNETWORKCMD:-host}"
UNQUALIFIED_SEARCH_REGISTRIES_OPT="${UNQUALIFIEDSEARCHREGISTRIES:-docker.io}"
DOCKER_API_SOCKET_OPT="${DOCKERAPISOCKET:-true}"
COMPOSE_PROVIDER_OPT="${COMPOSEPROVIDER:-none}"
SILENCE_EMULATION_NOTICE_OPT="${SILENCEEMULATIONNOTICE:-true}"

case "$STORAGE_DRIVER_OPT" in
  auto | vfs | overlay) ;;
  *) die "storageDriver must be auto, vfs or overlay, not '$STORAGE_DRIVER_OPT'" ;;
esac
case "$ROOTLESS_NETWORK_CMD_OPT" in
  host | slirp4netns | pasta) ;;
  *) die "rootlessNetworkCmd must be host, slirp4netns or pasta, not" \
    "'$ROOTLESS_NETWORK_CMD_OPT'" ;;
esac
case "$COMPOSE_PROVIDER_OPT" in
  none | podman-compose | docker-compose) ;;
  *) die "composeProvider must be none, podman-compose or docker-compose, not" \
    "'$COMPOSE_PROVIDER_OPT'" ;;
esac

# --- mutual exclusion with docker-in-docker / docker-outside-of-docker --------------------
#
# All three provide /usr/bin/docker, and whichever Feature installs last wins silently —
# see the plan's Concept boundaries. installsAfter cannot express "never run alongside X",
# so this is the next best thing: refuse a build that already has a non-podman docker on
# PATH, naming the conflict rather than leaving a container where `docker` quietly runs
# something other than what this Feature configured.
if have docker && ! docker --version 2> /dev/null | grep -qi podman; then
  die "/usr/bin/docker already exists and is not the podman-docker shim." \
    "podman-as-docker is mutually exclusive with docker-in-docker and" \
    "docker-outside-of-docker — remove the other Feature first."
fi

# --- packages -----------------------------------------------------------------------------
#
# Do not add containers-common: it does not exist on Ubuntu, podman pulls what it needs.
# fuse-overlayfs is installed defensively even though the default path never invokes it —
# native kernel overlay needs no mount_program once the graphroot is a real filesystem
# (measured; see the plan). A failed install fails the build, as every Feature here does.
PACKAGES="podman uidmap slirp4netns fuse-overlayfs"
[ "$DOCKER_SHIM_OPT" = true ] && PACKAGES="$PACKAGES podman-docker"
case "$COMPOSE_PROVIDER_OPT" in
  podman-compose) PACKAGES="$PACKAGES podman-compose" ;;
  docker-compose) PACKAGES="$PACKAGES docker-compose" ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
# shellcheck disable=SC2086
apt-get install -y --no-install-recommends $PACKAGES ||
  die "package install failed (network required): $PACKAGES"
rm -rf /var/lib/apt/lists/*

echo "podman-as-docker: installed: $PACKAGES"

# --- subuid/subgid ---------------------------------------------------------------------
#
# Measured present in this repo's own base image; absent in some slim images. Getting this
# wrong produces the exact same string a missing SYS_ADMIN produces
# (`newuidmap: write to uid_map failed`) — see README.md's troubleshooting section, which
# is the only place the two are told apart.
REMOTE_USER="${_REMOTE_USER:-root}"

ensure_id_range() { # ensure_id_range <file> <user>
  _file="$1"; _user="$2"
  if grep -q "^$_user:" "$_file" 2> /dev/null; then
    return 0
  fi
  # usermod always targets the real /etc/subuid|subgid, so it is only tried when this
  # script is writing there for real — the test harness's redirected files fall straight
  # through to the plain-append branch below instead.
  if [ "$_file" = /etc/subuid ] || [ "$_file" = /etc/subgid ]; then
    if have usermod; then
      case "$_file" in
        /etc/subuid) usermod --add-subuids 100000-165535 "$_user" 2> /dev/null && return 0 ;;
        /etc/subgid) usermod --add-subgids 100000-165535 "$_user" 2> /dev/null && return 0 ;;
      esac
    fi
  fi
  echo "$_user:100000:65536" >> "$_file" 2> /dev/null &&
    return 0
  die "could not add a subordinate id range for $_user to $_file"
}
[ -f "$SUBUID_FILE" ] || : > "$SUBUID_FILE"
[ -f "$SUBGID_FILE" ] || : > "$SUBGID_FILE"
ensure_id_range "$SUBUID_FILE" "$REMOTE_USER"
ensure_id_range "$SUBGID_FILE" "$REMOTE_USER"
echo "podman-as-docker: subuid/subgid confirmed for $REMOTE_USER"

# --- registry search path ---------------------------------------------------------------
#
# permissive matters: enforcing turns a bare `docker run ubuntu` into an interactive
# prompt, and there is no terminal in a postCreateCommand or CI step.
#
# csv_to_toml_array <comma-separated string> — splits on `,`, trims whitespace from each
# entry, drops empty entries, and prints a TOML string array literal (e.g.
# ["docker.io", "quay.io"]). Same split/trim/drop-empty shape as agents/install.sh's
# csv_quoted_entries — copied, not shared (features/README.md: no features/common/) — but
# quoted for TOML rather than for a shell word, since that is what this value becomes.
csv_to_toml_array() {
  _csv="$1"
  _out=""
  _old_ifs="$IFS"
  IFS=','
  for _raw in $_csv; do
    IFS="$_old_ifs"
    _trimmed="$(printf '%s' "$_raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [ -n "$_trimmed" ]; then
      _escaped="$(printf '%s' "$_trimmed" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
      [ -n "$_out" ] && _out="$_out, "
      _out="$_out\"$_escaped\""
    fi
    IFS=','
  done
  IFS="$_old_ifs"
  printf '[%s]' "$_out"
}

mkdir -p "$CONTAINERS_ETC_DIR/registries.conf.d"
cat > "$CONTAINERS_ETC_DIR/registries.conf.d/99-devc-podman-as-docker.conf" << EOF
unqualified-search-registries = $(csv_to_toml_array "$UNQUALIFIED_SEARCH_REGISTRIES_OPT")
short-name-mode = "permissive"
EOF
echo "podman-as-docker: registries.conf.d written" \
  "(unqualifiedSearchRegistries='$UNQUALIFIED_SEARCH_REGISTRIES_OPT')"

# --- nodocker ----------------------------------------------------------------------------
#
# podman-docker's own convention (not a devc-features namespace) — one empty file
# suppresses the "Emulate Docker CLI using podman" banner podman-docker prints on every
# `docker` invocation. Scripts that parse `docker` output break without it.
if [ "$SILENCE_EMULATION_NOTICE_OPT" = true ]; then
  mkdir -p "$CONTAINERS_ETC_DIR"
  : > "$CONTAINERS_ETC_DIR/nodocker"
  echo "podman-as-docker: $CONTAINERS_ETC_DIR/nodocker created"
fi

# --- network backend default -------------------------------------------------------------
#
# netns="host" is the unconditional default (see the rootlessNetworkCmd option): both
# userspace backends need /dev/net/tun, which is absent by default and not grantable by a
# Feature, so defaulting to either would fail every `docker run` in the bare-{} case with
# no runArgs to search for. default_rootless_network_cmd only matters once netns is
# private, i.e. once a consumer opts in to slirp4netns/pasta.
#
# Key names confirmed against both podman major versions this Feature was measured on:
# 4.9.3 (Ubuntu 24.04) and 5.7.0 (Ubuntu 26.04) — [containers] netns and
# [network] default_rootless_network_cmd exist, unchanged, on both.
mkdir -p "$CONTAINERS_ETC_DIR/containers.conf.d"
{
  echo '[containers]'
  if [ "$ROOTLESS_NETWORK_CMD_OPT" = host ]; then
    echo 'netns = "host"'
  else
    echo 'netns = "private"'
  fi
  echo
  echo '[network]'
  if [ "$ROOTLESS_NETWORK_CMD_OPT" != host ]; then
    echo "default_rootless_network_cmd = \"$ROOTLESS_NETWORK_CMD_OPT\""
  fi
} > "$CONTAINERS_ETC_DIR/containers.conf.d/99-devc-podman-as-docker.conf"
echo "podman-as-docker: network default rootlessNetworkCmd='$ROOTLESS_NETWORK_CMD_OPT'"

# --- fixed paths in this Feature's namespace ----------------------------------------------
#
# /usr/local/share/devc-features/<id>/ is the Feature namespace; overridable for the test
# harness. The socket and graphroot directories are under /run and /var/lib respectively —
# not under SHARE_DIR — because those two are named directly in the manifest's
# containerEnv and mounts, which cannot reference SHARE_DIR's own default.
SHARE_DIR="${SHARE_DIR:-/usr/local/share/devc-features/podman-as-docker}"
SOCKET_DIR="${SOCKET_DIR:-/run/devc-features/podman-as-docker}"
GRAPHROOT_DIR="${GRAPHROOT_DIR:-/var/lib/devc-features/podman-as-docker/storage}"

# bake <file> <var> <value> — the manifest's postCreateCommand/postStartCommand take no
# arguments, so options cross into the copied scripts by rewriting their own
# `VAR="${VAR:-default}"` lines. awk -v, not sed: a `&` or `|` in a value must not be
# treated as a back-reference or an expression terminator. Copied from node-nvmrc's
# install.sh — same shape, not shared (features/README.md: no features/common/).
bake() {
  _bake_tmp="$1.bake.$$"
  awk -v var="$2" -v line="$2=\"$3\"" '
    index($0, var "=") == 1 { print line; next }
                            { print }
  ' "$1" > "$_bake_tmp"
  mv -f "$_bake_tmp" "$1"
  grep -qxF "$2=\"$3\"" "$1" || die "could not bake $2 into $(basename "$1")"
}

FEATURE_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$SHARE_DIR"
cp "$FEATURE_DIR/post-create.sh" "$SHARE_DIR/post-create.sh"
cp "$FEATURE_DIR/post-start.sh" "$SHARE_DIR/post-start.sh"
bake "$SHARE_DIR/post-create.sh" STORAGE_DRIVER_OPT "$STORAGE_DRIVER_OPT"
bake "$SHARE_DIR/post-create.sh" GRAPHROOT_DIR "$GRAPHROOT_DIR"
bake "$SHARE_DIR/post-start.sh" SOCKET_DIR "$SOCKET_DIR"
bake "$SHARE_DIR/post-start.sh" DOCKER_API_SOCKET_OPT "$DOCKER_API_SOCKET_OPT"
chmod 0755 "$SHARE_DIR/post-create.sh" "$SHARE_DIR/post-start.sh"
echo "podman-as-docker: create-time and start-time scripts installed under $SHARE_DIR"

# The socket directory. /run is an ordinary directory in a Docker image (not tmpfs unless
# declared), so this survives to run time.
mkdir -p "$SOCKET_DIR"
chmod 0700 "$SOCKET_DIR"
if [ -n "${_REMOTE_USER:-}" ]; then
  chown "$_REMOTE_USER" "$SOCKET_DIR" 2> /dev/null || true
fi

# The graphroot directory. Must exist and be owned before anything mounts onto it — same
# belt-and-braces the agents Feature applies to ~/.claude, for the same unmeasured reason
# (whether Docker seeds a first-use volume's ownership from what was already at the path).
# post-create.sh's ownership repair stays regardless of how that lands.
mkdir -p "$GRAPHROOT_DIR"
if [ -n "${_REMOTE_USER:-}" ]; then
  chown "$_REMOTE_USER" "$GRAPHROOT_DIR" 2> /dev/null || true
fi

# Do not write ~/.config/containers/storage.conf here — the driver is a run-time fact
# decided in post-create.sh once the graphroot's backing filesystem can actually be probed.

echo "podman-as-docker: dockerShim=$DOCKER_SHIM_OPT storageDriver=$STORAGE_DRIVER_OPT" \
  "rootlessNetworkCmd=$ROOTLESS_NETWORK_CMD_OPT dockerApiSocket=$DOCKER_API_SOCKET_OPT" \
  "composeProvider=$COMPOSE_PROVIDER_OPT silenceEmulationNotice=$SILENCE_EMULATION_NOTICE_OPT"
