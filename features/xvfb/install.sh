#!/bin/sh
# xvfb Feature install — apt-get install Xvfb plus the library groups the options select, and
# place `xvfb-ensure` and the start-time script with the options baked in.
#
# Runs as root at image *build* time. Everything this Feature ever installs is installed here:
# xvfb-ensure never calls apt-get, so a container that built is a container that can render.
set -e

# The package-name checks below are character-range `case` patterns; in a non-C locale `[a-z]`
# can match more than ASCII lowercase.
LC_ALL=C
export LC_ALL

die() {
  echo "xvfb: $*" >&2
  exit 1
}

# Options reach install.sh uppercased with non-word characters stripped (the CLI's getSafeId),
# and booleans arrive as the strings "true"/"false".
X11_LIBRARIES="${X11LIBRARIES:-true}"
OPENGL_OPT="${OPENGL:-true}"
FONTS_OPT="${FONTS:-true}"
VULKAN_OPT="${VULKAN:-false}"
TOOLS_OPT="${TOOLS:-false}"
EXTRA_PACKAGES="${EXTRAPACKAGES-}"
# The `display` option arrives as $DISPLAY — the same name X clients read. Harmless here
# (nothing in this script is an X client), but it is why the value is copied out under another
# name straight away, and why the offline harness has to unset its own $DISPLAY first.
DISPLAY_OPT="${DISPLAY:-99}"
SCREEN_OPT="${SCREEN:-1920x1080x24}"
START_ON_CONTAINER_START="${STARTONCONTAINERSTART:-false}"

# --- 1. validate, before anything touches the network --------------------------------------
#
# The same two patterns xvfb-ensure applies to --display and --screen: a value that would be
# refused at run time fails the build instead of every later call. Both are also baked into a
# double-quoted shell assignment (see bake() below), which these character sets keep inert.
case "$DISPLAY_OPT" in
  '' | *[!0-9]*) die "display must be digits only (\"99\" means DISPLAY=:99): $DISPLAY_OPT" ;;
esac
echo "$SCREEN_OPT" | grep -Eq '^[0-9]+x[0-9]+x(8|16|24|32)$' ||
  die "screen must be <width>x<height>x<depth> with a depth of 8, 16, 24 or 32: $SCREEN_OPT"

# --- 2. the requested package set ------------------------------------------------------------
#
# Ubuntu 24.04 names throughout. A group belongs here only if it serves "use this display" for
# *any* client; one application's own dependency list goes through extraPackages instead (see
# the README's VS Code recipe, and CONTRIBUTING.md's note on this Feature).

# The Feature's reason to exist. xauth is what xvfb-run needs; x11-utils carries xdpyinfo,
# xvfb-ensure's liveness probe.
PACKAGES='xvfb xauth x11-utils'

[ "$X11_LIBRARIES" = true ] && PACKAGES="$PACKAGES libx11-6 libxext6 libxi6 libxrandr2 libxcursor1 libxinerama1 libxrender1 libxkbcommon0 libfontconfig1"
[ "$OPENGL_OPT" = true ] && PACKAGES="$PACKAGES libgl1 libegl1 libgl1-mesa-dri"
[ "$FONTS_OPT" = true ] && PACKAGES="$PACKAGES fonts-dejavu-core"
[ "$VULKAN_OPT" = true ] && PACKAGES="$PACKAGES libvulkan1 mesa-vulkan-drivers"
[ "$TOOLS_OPT" = true ] && PACKAGES="$PACKAGES imagemagick xdotool"

# extraPackages: comma-separated, whitespace around an entry ignored, empty entries skipped.
# Each one ends up as an apt-get argument, so anything that is not Debian package-name syntax
# is refused outright rather than passed along to be read as an option or a version pin.
_rest="$EXTRA_PACKAGES"
while [ -n "$_rest" ]; do
  case "$_rest" in
    *,*)
      _entry="${_rest%%,*}"
      _rest="${_rest#*,}"
      ;;
    *)
      _entry="$_rest"
      _rest=''
      ;;
  esac
  _entry="$(printf '%s' "$_entry" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  [ -n "$_entry" ] || continue
  case "$_entry" in
    [!a-z0-9]* | *[!a-z0-9.+-]*) die "extraPackages entry is not a package name: $_entry" ;;
  esac
  PACKAGES="$PACKAGES $_entry"
done

# --- 3. resolve names against this base, then install ----------------------------------------

command -v apt-get > /dev/null 2>&1 ||
  die 'needs apt-get — this Feature supports Debian and Ubuntu base images only'

export DEBIAN_FRONTEND=noninteractive
apt-get update

# The `t64` fallback. Ubuntu 24.04 renamed several libraries with a `t64` suffix (the 64-bit
# time_t transition); Ubuntu 22.04 and Debian bookworm only have the old names. So a name ending
# in `t64` is installed as written where the base knows it and without the suffix where it does
# not — which is what lets one extraPackages list work on both. None of the groups above has a
# `t64` name today; this exists for extraPackages.
RESOLVED=''
for _pkg in $PACKAGES; do
  case "$_pkg" in
    *t64)
      if ! apt-cache show "$_pkg" > /dev/null 2>&1; then
        _bare="${_pkg%t64}"
        apt-cache show "$_bare" > /dev/null 2>&1 ||
          die "neither $_pkg nor $_bare is a package this base image knows"
        _pkg="$_bare"
      fi
      ;;
  esac
  case " $RESOLVED " in
    *" $_pkg "*) ;;
    *) RESOLVED="$RESOLVED $_pkg" ;;
  esac
done

# One install for the whole set. $RESOLVED is deliberately unquoted: it is a space-separated
# list of names each already checked against the package-name pattern above.
# shellcheck disable=SC2086
apt-get install -y --no-install-recommends $RESOLVED

# An X server run by a non-root user creates this itself, but warns that it is not root-owned
# every time. Creating it here, sticky like /tmp, keeps xvfb-ensure's log about real problems.
X11_UNIX_DIR="${X11_UNIX_DIR:-/tmp/.X11-unix}"
mkdir -p "$X11_UNIX_DIR"
chmod 1777 "$X11_UNIX_DIR"

# --- 4. install layout ------------------------------------------------------------------------
#
# /usr/local/share/devc-features/<id>/ is the Feature namespace, kept separate from devc's own
# /usr/local/share/devc/. Overridable for the test harness.
SHARE_DIR="${SHARE_DIR:-/usr/local/share/devc-features/xvfb}"
ENSURE_BIN="$SHARE_DIR/bin/xvfb-ensure"
ENSURE_LINK="${XVFB_ENSURE_LINK:-/usr/local/bin/xvfb-ensure}"

# The manifest's postStartCommand takes no arguments and xvfb-ensure is called with none, so the
# options have to cross into both at build time. They are baked by rewriting their
# `VAR="${VAR:-default}"` lines, which keeps the files in the repo readable and runnable on
# their own.
bake() { # bake <file> <var> <value>
  _bake_tmp="$1.bake.$$"
  # awk with the replacement passed as a -v value, rather than sed: a `&` in a value is a
  # back-reference in a sed replacement and a `|` would end the expression.
  awk -v var="$2" -v line="$2=\"$3\"" '
    index($0, var "=") == 1 { print line; next }
                            { print }
  ' "$1" > "$_bake_tmp"
  mv -f "$_bake_tmp" "$1"
  # A rename or a reformat upstream would otherwise leave the option silently unwired, with the
  # `${VAR:-default}` fallback quietly standing in for whatever the consumer asked for.
  grep -qxF "$2=\"$3\"" "$1" || die "could not bake $2 into $(basename "$1")"
}

FEATURE_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$(dirname "$ENSURE_BIN")"
cp "$FEATURE_DIR/xvfb-ensure" "$ENSURE_BIN"
bake "$ENSURE_BIN" DEFAULT_DISPLAY "$DISPLAY_OPT"
bake "$ENSURE_BIN" DEFAULT_SCREEN "$SCREEN_OPT"
chmod 0755 "$ENSURE_BIN"

# Unconditional, so a developer can shadow the install by bind-mounting over
# /usr/local/share/devc-features/xvfb — the same unconditional symlink pattern as godot's.
mkdir -p "$(dirname "$ENSURE_LINK")"
ln -sfn "$ENSURE_BIN" "$ENSURE_LINK"

cp "$FEATURE_DIR/post-start.sh" "$SHARE_DIR/post-start.sh"
bake "$SHARE_DIR/post-start.sh" START_ON_CONTAINER_START_OPT "$START_ON_CONTAINER_START"
chmod 0755 "$SHARE_DIR/post-start.sh"

echo "xvfb: installed$RESOLVED"
echo "xvfb: xvfb-ensure installed at $ENSURE_LINK (display :$DISPLAY_OPT, screen $SCREEN_OPT)"
echo "xvfb: start-time script installed at $SHARE_DIR/post-start.sh (startOnContainerStart=$START_ON_CONTAINER_START)"
