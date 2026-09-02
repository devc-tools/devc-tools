#!/bin/sh
# rootless-remap Feature install — runs as root at image build time.
#
# On a rootless Docker daemon the container's user namespace maps container uid 0 to the host
# user and uid 1+ to the host's subordinate range, so a workspace bind mount owned by the host
# user is root:root inside and the conventional remote user cannot write a single project file.
# uid 0 is the only container identity that owns the mount. This Feature makes the remote user
# uid 0 — keeping its name, home and shell — and does nothing on a rootful daemon.
#
# Measured in devc-dev: docs/rootless-linux-findings.md (M-1..M-7, § Keeping remoteUser: vscode).
set -e

die() {
  echo "rootless-remap: $*" >&2
  exit 1
}

# Every absolute path is overridable so the offline harness can run this unprivileged.
UID_MAP_FILE="${UID_MAP_FILE:-/proc/self/uid_map}"
GID_MAP_FILE="${GID_MAP_FILE:-/proc/self/gid_map}"
PASSWD_FILE="${PASSWD_FILE:-/etc/passwd}"
GROUP_FILE="${GROUP_FILE:-/etc/group}"
SUBUID_FILE="${SUBUID_FILE:-/etc/subuid}"
SUBGID_FILE="${SUBGID_FILE:-/etc/subgid}"
SHARE_DIR="${SHARE_DIR:-/usr/local/share/devc-features/rootless-remap}"
CHOWN_HOME="${CHOWN_HOME:-true}"   # the harness turns the recursive chown off
HOLD_USER="devc-uid-hold"

REMOTE_USER="${_REMOTE_USER:-}"

FEATURE_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$SHARE_DIR"
cp "$FEATURE_DIR/post-create.sh" "$SHARE_DIR/post-create.sh"
chmod 0755 "$SHARE_DIR/post-create.sh"
rm -f "$SHARE_DIR/remapped"

is_identity_map() {
  awk '$1 == 0 && $2 == 0 && $3 == 4294967295 { f = 1 } END { exit !f }' "$UID_MAP_FILE" 2> /dev/null
}

if is_identity_map; then
  echo "rootless-remap: rootful daemon (identity uid map) — nothing to remap"
  exit 0
fi

host_uid="$(awk '$1 == 0 { print $2; exit }' "$UID_MAP_FILE" 2> /dev/null)"
host_gid="$(awk '$1 == 0 { print $2; exit }' "$GID_MAP_FILE" 2> /dev/null)"
[ -n "$host_uid" ] || die "could not read the host uid from $UID_MAP_FILE"
[ -n "$host_gid" ] || host_gid="$host_uid"
echo "rootless-remap: rootless daemon detected — container uid 0 is host uid $host_uid"

if [ -z "$REMOTE_USER" ]; then
  echo "rootless-remap: _REMOTE_USER is unset — nothing to remap (the container user is the image default)"
  exit 0
fi
if [ "$REMOTE_USER" = root ]; then
  echo "rootless-remap: the remote user is already root — nothing to remap"
  exit 0
fi

entry="$(grep "^$REMOTE_USER:" "$PASSWD_FILE" || true)"
[ -n "$entry" ] || die "$REMOTE_USER is not in $PASSWD_FILE"
old_uid="$(echo "$entry" | cut -d: -f3)"
gecos="$(echo "$entry" | cut -d: -f5)"
home="$(echo "$entry" | cut -d: -f6)"
shell="$(echo "$entry" | cut -d: -f7)"

if [ "$old_uid" = 0 ]; then
  echo "rootless-remap: $REMOTE_USER is already uid 0"
else
  # uid 0, gid 0, and FIRST in the file so getpwuid(0) answers "$REMOTE_USER" — that is what
  # keeps `whoami`, `stat -c %U` and $HOME saying vscode rather than root. Rewritten through a
  # temp file cat'd over the original so the file's mode and ownership survive.
  tmp="$(mktemp)"
  {
    echo "$REMOTE_USER:x:0:0:$gecos:$home:$shell"
    grep -v "^$REMOTE_USER:" "$PASSWD_FILE"
  } > "$tmp"
  cat "$tmp" > "$PASSWD_FILE"
  rm -f "$tmp"
  if [ "$CHOWN_HOME" = true ] && [ -d "$home" ]; then
    chown -R 0:0 "$home"
  fi
  echo "rootless-remap: $REMOTE_USER remapped to uid 0/gid 0 (was $old_uid); home $home kept"
fi

# The devcontainer CLI's default updateRemoteUserUID step rebuilds a layer that renumbers the
# remote user to the host's uid — which would undo the remap and leave a user whose writes are
# owned by an unmapped subuid (M-7: fails green). That step skips with "User with UID exists"
# when some user already holds the target uid, so hold it with a placeholder. Measured: the
# -uid layer is built and the remap survives.
if ! awk -F: -v u="$host_uid" '$3 == u { f = 1 } END { exit !f }' "$PASSWD_FILE"; then
  echo "$HOLD_USER:x:$host_uid:$host_gid:holds the host uid so updateRemoteUserUID is a no-op:/nonexistent:/usr/sbin/nologin" >> "$PASSWD_FILE"
  echo "rootless-remap: uid $host_uid held by $HOLD_USER"
fi
if ! awk -F: -v g="$host_gid" '$3 == g { f = 1 } END { exit !f }' "$GROUP_FILE"; then
  echo "$HOLD_USER:x:$host_gid:" >> "$GROUP_FILE"
fi

# Subordinate ranges for nested rootless podman (podman-as-docker's two-level launch): nearly
# every id the outer namespace owns (1-65535) minus uid 1000, as two lines — a small
# block cannot map uid 65534 (nobody), which many images carry, and `docker pull` then fails
# with "potentially insufficient UIDs". Written for the remapped user and for whoever holds uid
# 1000; both exclude 1000 because podman runs as 1000 one level down and reads the lines of
# whatever name $USER holds, refusing any that include its own uid. podman-as-docker writes
# identical lines if it runs later, so the order of the two Features does not matter.
ranges_for_uid() { # ranges_for_uid <uid> — prints the range suffixes, one per line
  # Always excludes 1000: podman runs as uid 1000 one namespace down and reads the lines of
  # whatever name $USER holds (podman prefers $USER over getpwuid), so every name's lines
  # must exclude 1000 or podman refuses them ("includes the user UID"). A non-root remote
  # user with some other uid also excludes its own.
  _u="$1"
  if [ "$_u" -eq 0 ] || [ "$_u" -eq 1000 ]; then
    echo "1:999"; echo "1001:64535"
  elif [ "$_u" -lt 1000 ]; then
    [ "$_u" -gt 1 ] && echo "1:$(( _u - 1 ))"; echo "$(( _u + 1 )):$(( 999 - _u ))"; echo "1001:64535"
  else
    echo "1:999"; echo "1001:$(( _u - 1001 ))"; [ "$_u" -lt 65535 ] && echo "$(( _u + 1 )):$(( 65535 - _u ))"
  fi
}
holder="$(awk -F: '$3 == 1000 { print $1; exit }' "$PASSWD_FILE")"
for f in "$SUBUID_FILE" "$SUBGID_FILE"; do
  [ -f "$f" ] || : > "$f"
  tmp="$f.tmp.$$"
  grep -v -E "^($REMOTE_USER${holder:+|$holder}):" "$f" > "$tmp" || true
  for r in $(ranges_for_uid 0); do echo "$REMOTE_USER:$r" >> "$tmp"; done
  [ -n "$holder" ] && for r in $(ranges_for_uid 1000); do echo "$holder:$r" >> "$tmp"; done
  cat "$tmp" > "$f"; rm -f "$tmp"
done
echo "rootless-remap: subuid/subgid set to the outer namespace's range minus uid 1000 for $REMOTE_USER${holder:+ and $holder}"

: > "$SHARE_DIR/remapped"
