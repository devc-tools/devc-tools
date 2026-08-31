#!/bin/sh
# devc-tools installer — fetch the prebuilt binaries for this machine and put them
# where devc and devc-bridge expect to find each other.
#
#   curl -fsSL https://github.com/devc-tools/devc-tools/releases/latest/download/install.sh | sh
#
# This file is the source of truth and is edited here, but it is *shipped as a release
# asset*, not run from `main`: the copy GitHub serves at .../releases/latest/download/
# is the script that release was built and tested with, with its own version stamped in
# (see the `devc:stamp` fence below). A script served from `main` would be a live edit
# against every past release.
#
# Env knobs — it is piped to `sh`, so there are no flags:
#
#   DEVC_VERSION       install this tag instead (e.g. v0.1.0); a leading `v` is optional
#   DEVC_INSTALL_DIR   where `devc`/`devc-bridge` go        (default ~/.local/bin)
#   DEVC_TOOLS         subset to install, from: devc bridge client (default: all that
#                      apply to this platform)
#   DEVC_BRIDGE_CLIENT_DIR
#                      where the container client goes      (default
#                      ~/.config/devc-bridge/client) — the same variable
#                      devc-bridge/client/build-client.sh honors, so the developer and
#                      installer paths stay in step
#   DEVC_RELEASE_BASE  release URL base (mirrors, and the test harness's file:// fixture)
#   DEVC_API_LATEST    latest-release API URL, used only by an unstamped copy
#
# Never uses sudo. If the install dir is not on PATH it says so and prints the line to
# add, rather than silently installing something unreachable.
#
# The whole body is inside functions, invoked on the very last line: a download truncated
# mid-script then defines some functions and does nothing, instead of executing half an
# install.

set -eu

# --- release identity ----------------------------------------------------------------
# The publish job rewrites the assignment between these markers with the tag it is
# publishing, so the uploaded copy installs its own release's binaries — no GitHub API
# call, no rate limit, and no way to drift from the assets it was published beside. The
# copy in the repo is unstamped and falls back to the API.
# devc:stamp (start)
DEVC_RELEASE_VERSION=''
# devc:stamp (end)

DEVC_REPO='devc-tools/devc-tools'

# --- output --------------------------------------------------------------------------

say() { printf 'devc-tools: %s\n' "$1"; }
warn() { printf 'devc-tools: %s\n' "$1" >&2; }
die() {
  printf 'devc-tools: %s\n' "$1" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

# --- platform ------------------------------------------------------------------------

# Sets OS_NAME, HOST_TRIPLE and CLIENT_TRIPLE from `uname`.
#
# Assets are named by Deno's own target triples — the exact strings `deno compile
# --target` takes — so there is one vocabulary between the workflow that builds them and
# this script, rather than two mappings to keep in step.
#
# CLIENT_TRIPLE is the easy one to get backwards: the devc-bridge *container* client is
# always a Linux binary, and it is matched to the **host's architecture**, because Docker
# Desktop runs containers matching the host. On an arm64 Mac that is
# aarch64-unknown-linux-gnu, not anything apple-darwin.
detect_platform() {
  os="$(uname -s)"
  machine="$(uname -m)"

  case "$machine" in
    x86_64 | amd64) arch='x86_64' ;;
    arm64 | aarch64) arch='aarch64' ;;
    *) die "unsupported architecture $machine (supported: x86_64, arm64/aarch64)" ;;
  esac

  case "$os" in
    Darwin)
      OS_NAME='macOS'
      HOST_TRIPLE="$arch-apple-darwin"
      ;;
    Linux)
      OS_NAME='Linux'
      HOST_TRIPLE="$arch-unknown-linux-gnu"
      ;;
    *)
      die "unsupported OS $os (supported: macOS, Linux — Windows is out of scope)"
      ;;
  esac

  CLIENT_TRIPLE="$arch-unknown-linux-gnu"
}

# --- what to install -----------------------------------------------------------------

# Sets TOOLS. `devc` and the container client apply everywhere; the devc-bridge *host*
# CLI is macOS-only — every command it ships is macOS (`caffeinate`), so there is nothing
# a Linux host could usefully run even though the daemon itself is portable.
select_tools() {
  if [ "$OS_NAME" = 'macOS' ]; then
    default_tools='devc bridge client'
  else
    default_tools='devc client'
  fi

  if [ -z "${DEVC_TOOLS:-}" ]; then
    TOOLS="$default_tools"
    return
  fi

  TOOLS=''
  for t in $(printf '%s' "$DEVC_TOOLS" | tr ',' ' '); do
    case "$t" in
      devc | client) ;;
      bridge)
        [ "$OS_NAME" = 'macOS' ] ||
          die "DEVC_TOOLS=bridge: the devc-bridge host CLI is macOS-only"
        ;;
      *) die "DEVC_TOOLS: unknown tool $t (known: devc, bridge, client)" ;;
    esac
    TOOLS="$TOOLS $t"
  done
  [ -n "$TOOLS" ] || die 'DEVC_TOOLS is set but empty'
}

want() {
  case " $TOOLS " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

# --- version -------------------------------------------------------------------------

# Sets VERSION. Precedence: an explicit DEVC_VERSION (a deliberate downgrade or pin),
# then the stamp this release was published with, then the GitHub API — which only an
# unstamped copy, i.e. one run from a clone, ever reaches.
resolve_version() {
  if [ -n "${DEVC_VERSION:-}" ]; then
    VERSION="$DEVC_VERSION"
  elif [ -n "$DEVC_RELEASE_VERSION" ]; then
    VERSION="$DEVC_RELEASE_VERSION"
  else
    api="${DEVC_API_LATEST:-https://api.github.com/repos/$DEVC_REPO/releases/latest}"
    fetch "$api" "$TMP/latest.json"
    VERSION="$(
      sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        "$TMP/latest.json" | head -1
    )"
    [ -n "$VERSION" ] || die "could not read the latest release tag from $api"
  fi
  # Tags carry the `v`; a human typing DEVC_VERSION=0.1.0 means the same thing.
  case "$VERSION" in
    v*) ;;
    *) VERSION="v$VERSION" ;;
  esac
  # Asset filenames carry the *bare* version — the `v` belongs to the tag and to the URL
  # path, not to the file. Keeping the version in the filename is what stops `devc-bridge-*`
  # from sorting into the middle of `devc-*` on the release page (digits sort before
  # letters), and makes a downloaded archive self-identifying.
  BARE_VERSION="${VERSION#v}"
}

# --- fetch + verify ------------------------------------------------------------------

fetch() { # fetch <url> <dest>
  if have curl; then
    curl -fsSL -o "$2" "$1" || die "download failed: $1"
  elif have wget; then
    wget -q -O "$2" "$1" || die "download failed: $1"
  else
    die 'need curl or wget to download'
  fi
}

sha256_of() { # sha256_of <file>
  if have sha256sum; then
    sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die 'need sha256sum or shasum to verify downloads'
  fi
}

# A `curl | sh` that pipes an unverified binary onto PATH is the thing this script exists
# to make routine, so it must not be the thing it does casually. Every archive is checked
# against the release's own checksums.txt before anything is written outside the temp dir.
verify() { # verify <asset>
  expected="$(awk -v n="$1" '
    { name = $2; sub(/^\*/, "", name) }   # sha256sum -b writes *name
    name == n { print $1; exit }
  ' "$TMP/checksums.txt")"
  [ -n "$expected" ] || die "checksums.txt has no entry for $1"
  actual="$(sha256_of "$TMP/$1")"
  [ "$expected" = "$actual" ] || die \
    "checksum mismatch for $1 (expected $expected, got $actual) — nothing was installed"
}

# Download + verify + unpack one archive into its own slot under $TMP/staged/. Nothing
# lands in a real destination here, so a bad checksum on the last asset still leaves the
# machine untouched.
#
# One slot per tool because **two distinct binaries are named `devc-bridge`** — the host
# CLI and the container client — and on macOS the installer places both. A shared unpack
# dir would have the second archive silently overwrite the first.
stage() { # stage <slot> <asset> <binary-name>
  fetch "$RELEASE_BASE/download/$VERSION/$2" "$TMP/$2"
  verify "$2"
  mkdir -p "$TMP/staged/$1"
  tar -xzf "$TMP/$2" -C "$TMP/staged/$1" || die "could not unpack $2"
  [ -f "$TMP/staged/$1/$3" ] || die "$2 does not contain $3"
}

# --- install -------------------------------------------------------------------------

# Extract-then-rename, into a temp name in the *destination* directory: a rename within
# one directory is atomic, so a failure cannot leave a half-written binary in place and a
# container reading the client through its live bind mount never sees one either.
install_binary() { # install_binary <slot> <staged-name> <dest-dir> <dest-name>
  mkdir -p "$3" || die "could not create $3"
  tmpf="$3/.$4.tmp.$$"
  cp "$TMP/staged/$1/$2" "$tmpf" || die "could not write to $3"
  chmod 0755 "$tmpf"
  mv -f "$tmpf" "$3/$4" || die "could not install $3/$4"
}

# --- advice --------------------------------------------------------------------------

# Report, never block. An installer that refuses because Docker is not running is worse
# than one that says so.
#
# Docker is the whole list. `devcontainer` and the `node` it runs on used to be checked
# here too; the devcontainer CLI is now embedded in the devc binary, so a machine with
# neither on PATH is fully equipped.
check_prereqs() {
  missing=''
  for tool in docker; do
    have "$tool" || missing="$missing $tool"
  done
  [ -n "$missing" ] || return 0
  warn "not found on PATH:$missing"
  warn '(devc needs docker at run time; install it when convenient)'
}

check_path() {
  case ":${PATH}:" in
    *":$INSTALL_DIR:"*) return 0 ;;
  esac
  warn "$INSTALL_DIR is not on your PATH. Add it:"
  printf '\n    export PATH="%s:$PATH"\n\n' "$INSTALL_DIR" >&2
}

# --- main ----------------------------------------------------------------------------

main() {
  INSTALL_DIR="${DEVC_INSTALL_DIR:-$HOME/.local/bin}"
  CLIENT_DIR="${DEVC_BRIDGE_CLIENT_DIR:-$HOME/.config/devc-bridge/client}"
  RELEASE_BASE="${DEVC_RELEASE_BASE:-https://github.com/$DEVC_REPO/releases}"

  detect_platform
  select_tools

  TMP="$(mktemp -d "${TMPDIR:-/tmp}/devc-install.XXXXXX")" ||
    die 'could not create a temp dir'
  trap 'rm -rf "$TMP"' EXIT INT TERM

  resolve_version
  say "installing $VERSION for $OS_NAME ($HOST_TRIPLE)"

  fetch "$RELEASE_BASE/download/$VERSION/checksums.txt" "$TMP/checksums.txt"

  # Stage everything first; install only once all of it has verified, so a corrupt or
  # tampered asset aborts with nothing written anywhere.
  if want devc; then stage devc "devc-$BARE_VERSION-$HOST_TRIPLE.tar.gz" devc; fi
  if want bridge; then
    stage bridge "devc-bridge-host-$BARE_VERSION-$HOST_TRIPLE.tar.gz" devc-bridge
  fi
  if want client; then
    stage client "devc-bridge-client-$BARE_VERSION-$CLIENT_TRIPLE.tar.gz" devc-bridge
  fi

  if want devc; then install_binary devc devc "$INSTALL_DIR" devc; fi
  if want bridge; then
    install_binary bridge devc-bridge "$INSTALL_DIR" devc-bridge
  fi
  # Overwrites unconditionally — devc's placeholder or a previous client. The binary is
  # not user-owned: it is a build artifact with a fixed name, and a stale one is a bug.
  if want client; then
    install_binary client devc-bridge "$CLIENT_DIR" devc-bridge
  fi

  echo
  say "installed $VERSION:"
  if want devc; then printf '  %-52s devc\n' "$INSTALL_DIR/devc"; fi
  if want bridge; then
    printf '  %-52s devc-bridge (host)\n' "$INSTALL_DIR/devc-bridge"
  fi
  if want client; then
    printf '  %-52s devc-bridge (container client, %s)\n' \
      "$CLIENT_DIR/devc-bridge" "$CLIENT_TRIPLE"
  fi
  echo

  check_path
  check_prereqs

  # devc's compiled binary used to print an `Info Failed to resolve '<x>' for allow-run`
  # line on stderr for each allowlisted binary missing from PATH. It no longer has an
  # allowlist to resolve: embedding the devcontainer CLI put a host `initializeCommand`'s
  # `/bin/sh -c` inside devc's own sandbox, which permits every host command anyway, so
  # the allowlist was giving up nothing real by staying. See devc/README.md.
  say 'run `devc --help` to get started'
}

main "$@"
