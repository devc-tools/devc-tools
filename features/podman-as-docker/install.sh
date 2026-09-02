#!/bin/sh
# podman-as-docker Feature install — packages, static config, subuid/subgid, and the
# create-time/start-time scripts.
#
# Runs as root at image *build* time. The workspace is not mounted yet and neither is the
# graphroot volume, so nothing here can decide the storage driver (post-create.sh does,
# once the volume is real) or start anything (post-start.sh, every start). What lands here
# is everything that is a build-time fact: which packages exist, the registry search path,
# the network backend default, and the fixed directories this Feature's manifest names.
#
# The manifest declares NO capability. It declares securityOpt:["systempaths=unconfined",
# "apparmor=unconfined"], and the consumer supplies a seccomp profile through runArgs — see
# README.md's privilege-cost section for what each one buys and why. Nothing in this script
# grants privilege: the one privilege-adjacent thing it does is give newuidmap/newgidmap file
# capabilities (cap_setuid/cap_setgid) in place of their setuid bit, which is what lets an
# unprivileged user write its own namespace's uid map without root holding CAP_SYS_ADMIN.
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
BIN_DIR="${BIN_DIR:-/usr/local/bin}"                 # where the podman/docker shims land
UIDMAP_BIN_DIR="${UIDMAP_BIN_DIR:-/usr/bin}"         # where uidmap put newuidmap/newgidmap
SETCAP="${SETCAP:-setcap}"                           # the harness stubs this
CNI_DIR="${CNI_DIR:-/var/lib/cni}"
UID_MAP_FILE="${UID_MAP_FILE:-/proc/self/uid_map}"   # the nesting probe reads this
PASSWD_FILE="${PASSWD_FILE:-/etc/passwd}"

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
# All three provide /usr/bin/docker, and whichever Feature installs last wins silently.
# installsAfter cannot express "never run alongside X", so this is the next best thing:
# refuse a build that already has a non-podman docker on PATH, naming the conflict rather
# than leaving a container where `docker` quietly runs something other than what this
# Feature configured.
if have docker && ! docker --version 2> /dev/null | grep -qi podman; then
  die "/usr/bin/docker already exists and is not the podman-docker shim." \
    "podman-as-docker is mutually exclusive with docker-in-docker and" \
    "docker-outside-of-docker — remove the other Feature first."
fi

# --- packages -----------------------------------------------------------------------------
#
# Do not add containers-common: it does not exist on Ubuntu, podman pulls what it needs.
# fuse-overlayfs is installed defensively even though the default path never invokes it —
# native kernel overlay needs no mount_program once the graphroot is a real filesystem.
#
# netavark, aardvark-dns and iptables are Recommends of podman/netavark, which
# --no-install-recommends drops. Without netavark podman silently falls back to CNI and
# containers on a created network cannot resolve each other by name; with netavark but no
# iptables binary, netavark fails at firewall setup ("No such file or directory"). Measured.
# libcap2-bin provides setcap (below). runc is what the nested-rootless drop-in names as the
# runtime; installing it here rather than only when nested keeps that drop-in always valid.
# A failed install fails the build.
PACKAGES="podman uidmap slirp4netns fuse-overlayfs libcap2-bin runc netavark aardvark-dns iptables"
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

# --- newuidmap/newgidmap as file-capability binaries ---------------------------------------
#
# Writing a user namespace's uid_map needs CAP_SYS_ADMIN *over that namespace*. Its creator
# has it as the owner; a setuid-root helper — which is how Ubuntu ships newuidmap — runs as
# root instead, and container root only has CAP_SYS_ADMIN over the child if the container was
# granted SYS_ADMIN. That single fact is why this Feature used to declare capAdd:["SYS_ADMIN"].
# With cap_setuid/cap_setgid as file capabilities the helper keeps the caller's uid, owns the
# namespace, and the same kernel check passes with no capability anywhere in the container.
# Fail the build if this does not take: every later `podman run` would fail with the opaque
# "newuidmap: write to uid_map failed: Operation not permitted".
for _tool in newuidmap newgidmap; do
  [ -e "$UIDMAP_BIN_DIR/$_tool" ] || die "$UIDMAP_BIN_DIR/$_tool is missing — did the uidmap package install?"
  chmod u-s "$UIDMAP_BIN_DIR/$_tool"
done
"$SETCAP" cap_setuid+ep "$UIDMAP_BIN_DIR/newuidmap" ||
  die "setcap on newuidmap failed — rootless podman cannot map a user namespace without it"
"$SETCAP" cap_setgid+ep "$UIDMAP_BIN_DIR/newgidmap" ||
  die "setcap on newgidmap failed — rootless podman cannot map a user namespace without it"
echo "podman-as-docker: newuidmap/newgidmap carry file capabilities (setuid bit removed)"

# --- /var/lib/cni --------------------------------------------------------------------------
#
# Rootless podman's network setup bind-mounts an empty directory over /var/lib/cni — or, when
# that path does not exist, over its nearest existing parent, which is /var/lib. This
# Feature's graphroot lives under /var/lib, so without the directory the mount hides
# <graphroot>/networks and every `podman run --network <created>` fails with "network not
# found" while `podman network ls` still lists it. Measured. An empty directory is the fix.
mkdir -p "$CNI_DIR"

# --- the podman/docker shims -----------------------------------------------------------------
#
# Two tiny wrappers ahead of /usr/bin on PATH. Everywhere except one case they are a plain
# exec of the real binary. The one case: euid 0 on a rootless outer daemon (non-identity
# /proc/self/uid_map) — the rootless-remap Feature's arrangement, where the remote user is uid
# 0 so it can write the workspace. Podman run directly as uid 0 re-execs into a 0->0 user
# namespace and then takes its rootful path, which needs cgroups a devcontainer cannot give
# it. So the shim runs it one user namespace down, as uid 1000, where it is an ordinary
# rootless podman again; the nested container's root then maps 0 -> 1000 -> outer 0 -> the
# developer on the host. That namespace is created once and re-entered on every call: podman
# keeps a pause process per user namespace and later invocations join it, and a process in a
# *sibling* namespace is not privileged over it. The decision is made at run time from
# in-container facts, so this needs no containerEnv and is inert everywhere else.
#
# The holder is `unshare --user … sleep infinity`; its pid is recorded next to the API socket.
# nsenter --preserve-credentials is load-bearing (inner uid 0 is unmapped, so the default
# setuid(0) would fail), and the lock descriptor must not leak into the holder (9>&-), or every
# later call blocks on it.
mkdir -p "$BIN_DIR"
_shims="podman"
[ "$DOCKER_SHIM_OPT" = true ] && _shims="podman docker"
for _b in $_shims; do
  cat > "$BIN_DIR/$_b" << SHIM
#!/bin/sh
# podman-as-docker shim — see install.sh. Plain exec unless uid 0 on a rootless outer daemon.
if [ "\$(id -u)" = 0 ] && ! awk '\$1==0 && \$2==0 && \$3==4294967295 {f=1} END {exit !f}' /proc/self/uid_map; then
  d=$SOCKET_DIR
  mkdir -p "\$d"
  pid=""
  exec 9> "\$d/holder.lock"; flock 9
  if [ -r "\$d/holder.pid" ]; then
    pid=\$(cat "\$d/holder.pid")
    [ -r "/proc/\$pid/ns/user" ] && grep -qs '^sleep' "/proc/\$pid/comm" || pid=""
  fi
  if [ -z "\$pid" ]; then
    setsid unshare --user --map-user=1000 --map-group=1000 \\
      --map-users=10000:10000:50001 --map-groups=10000:10000:50001 -- sleep infinity \\
      < /dev/null > /dev/null 2>&1 9>&- &
    pid=\$!
    echo "\$pid" > "\$d/holder.pid"
    i=0; while [ \$i -lt 50 ] && ! grep -qs '^ *1000 ' "/proc/\$pid/uid_map"; do sleep 0.1; i=\$((i+1)); done
  fi
  exec 9>&-
  exec nsenter --user --target "\$pid" --preserve-credentials -- /usr/bin/$_b "\$@"
fi
exec /usr/bin/$_b "\$@"
SHIM
  chmod 0755 "$BIN_DIR/$_b"
done
echo "podman-as-docker: shims installed in $BIN_DIR: $_shims"

# --- subuid/subgid ---------------------------------------------------------------------
#
# Present in most devcontainer base images; absent in some slim ones. Getting this wrong
# produces the exact same string a missing SYS_ADMIN produces
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

# --- nested on a rootless daemon --------------------------------------------------------------
#
# Rootful Docker gives a container the identity uid map `0 0 4294967295`; a rootless daemon
# gives something else (`0 1000 1` / `1 100000 65536`, say), and the map is visible during
# `docker build`, so this Feature can tell at build time whether it is nested. When it is:
# the outer namespace owns only ids 0-65536, so the 100000+ subordinate range above is not
# usable and is replaced; crun cannot create its keyring and pivot_root is refused, so runc
# with no_pivot_root and keyring=false are set. Rootful consumers are untouched.
is_identity_map() {
  awk '$1 == 0 && $2 == 0 && $3 == 4294967295 { f = 1 } END { exit !f }' "$UID_MAP_FILE" 2> /dev/null
}
if ! is_identity_map; then
  _host_uid="$(awk '$1 == 0 { print $2; exit }' "$UID_MAP_FILE" 2> /dev/null)"
  echo "podman-as-docker: nested on a rootless daemon (container uid 0 is host uid ${_host_uid:-?}) — configuring for it"

  mkdir -p "$CONTAINERS_ETC_DIR/containers.conf.d"
  cat > "$CONTAINERS_ETC_DIR/containers.conf.d/50-devc-podman-nested-rootless.conf" << 'EOF'
# Written by podman-as-docker because this image was built on a rootless Docker daemon.
[containers]
keyring = false

[engine]
runtime = "runc"
no_pivot_root = true
EOF

  # Subordinate ranges inside the 0-65536 the outer namespace owns, clear of real users. Two
  # names: the remote user (level 1 of the shim's two-level launch is created by it, looked
  # up by name) and whichever name holds uid 1000 (podman runs as 1000 at level 1 and is
  # looked up by that name). Also root, in case the remote user is root itself.
  _range="10000:50001"
  _names="$REMOTE_USER"
  [ "$REMOTE_USER" != root ] && _names="$_names root"
  _holder="$(awk -F: '$3 == 1000 { print $1; exit }' "$PASSWD_FILE" 2> /dev/null)"
  case " $_names " in *" $_holder "*) ;; *) [ -n "$_holder" ] && _names="$_names $_holder" ;; esac
  for _file in "$SUBUID_FILE" "$SUBGID_FILE"; do
    _tmp="$_file.tmp.$$"
    grep -v -E "^($(echo "$_names" | tr ' ' '|')):" "$_file" > "$_tmp" || true
    for _n in $_names; do echo "$_n:$_range" >> "$_tmp"; done
    cat "$_tmp" > "$_file"; rm -f "$_tmp"
  done
  echo "podman-as-docker: subuid/subgid set to $_range for: $_names"
fi

# --- registry search path ---------------------------------------------------------------
#
# permissive matters: enforcing turns a bare `docker run ubuntu` into an interactive
# prompt, and there is no terminal in a postCreateCommand or CI step.
#
# csv_to_toml_array <comma-separated string> — splits on `,`, trims whitespace from each
# entry, drops empty entries, and prints a TOML string array literal (e.g.
# ["docker.io", "quay.io"]).
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
# Key names are the same on podman 4.x and 5.x: [containers] netns and
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
# treated as a back-reference or an expression terminator.
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

# The graphroot directory. Must exist and be owned before anything mounts onto it: Docker
# seeds a first-use empty volume from whatever is already at the mount point, which is what
# makes the declared volume come up owned by the remote user. post-create.sh repairs the
# ownership anyway, for a volume a consumer mounted themselves.
mkdir -p "$GRAPHROOT_DIR"
if [ -n "${_REMOTE_USER:-}" ]; then
  chown "$_REMOTE_USER" "$GRAPHROOT_DIR" 2> /dev/null || true
fi

# Do not write ~/.config/containers/storage.conf here — the driver is a run-time fact
# decided in post-create.sh once the graphroot's backing filesystem can actually be probed.

echo "podman-as-docker: dockerShim=$DOCKER_SHIM_OPT storageDriver=$STORAGE_DRIVER_OPT" \
  "rootlessNetworkCmd=$ROOTLESS_NETWORK_CMD_OPT dockerApiSocket=$DOCKER_API_SOCKET_OPT" \
  "composeProvider=$COMPOSE_PROVIDER_OPT silenceEmulationNotice=$SILENCE_EMULATION_NOTICE_OPT"
