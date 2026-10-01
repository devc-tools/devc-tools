#!/bin/bash
# Checks a podman-as-docker seccomp profile against the moby/profiles default it was built from.
#
#   bash scripts/check-seccomp-podman.sh                  # the Feature's own copy
#   bash scripts/check-seccomp-podman.sh path/to/seccomp-podman.json   # a copy in another repo
#
# The profile is moby/profiles seccomp/default.json at PINNED_COMMIT with one rule prepended
# (syscalls[0]). Two checks, both normalized with `jq -S` so formatting does not matter:
#
#   1. The profile minus that rule equals upstream at PINNED_COMMIT. Fails (exit 1) on any
#      difference — someone hand-edited it, or regenerated it from a different commit.
#   2. Upstream main still equals PINNED_COMMIT. If not (exit 3), upstream has moved; the diff is
#      what a refresh would pick up. To refresh, regenerate from the new commit and update
#      PINNED_COMMIT here and the commit named in features/podman-as-docker/README.md.
#
# Exit 2 on usage errors or a failed fetch. Needs curl and jq.
set -uo pipefail

PINNED_COMMIT=6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef

# Resolve a caller-relative path before moving to the repo root for the default.
profile="${1:-}"
[ -n "$profile" ] && [ -f "$profile" ] && profile="$(cd "$(dirname "$profile")" && pwd)/$(basename "$profile")"
cd "$(dirname "$0")/.."
profile="${profile:-features/podman-as-docker/seccomp-podman.json}"
if [ ! -f "$profile" ]; then
  echo "check-seccomp-podman: no such file: $profile" >&2
  exit 2
fi

fetch() {
  curl -fsSL "https://raw.githubusercontent.com/moby/profiles/$1/seccomp/default.json" | jq -S . ||
    { echo "check-seccomp-podman: could not fetch moby/profiles@$1" >&2; exit 2; }
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fetch "$PINNED_COMMIT" > "$tmp/pinned.json" || exit 2
fetch main > "$tmp/main.json" || exit 2
jq -S 'del(.syscalls[0])' "$profile" > "$tmp/base.json" || exit 2

echo "Added rule (syscalls[0]):"
jq -c '.syscalls[0]' "$profile"
echo

if ! diff -u --label "moby@${PINNED_COMMIT:0:12}" --label "$profile minus syscalls[0]" \
  "$tmp/pinned.json" "$tmp/base.json"; then
  echo
  echo "FAIL: $profile is not moby@${PINNED_COMMIT:0:12} plus one rule." >&2
  exit 1
fi
echo "OK: $profile is moby@${PINNED_COMMIT:0:12} plus one rule."

if ! diff -u --label "moby@${PINNED_COMMIT:0:12}" --label "moby@main" \
  "$tmp/pinned.json" "$tmp/main.json"; then
  echo
  echo "DRIFT: moby/profiles main has moved since ${PINNED_COMMIT:0:12} (diff above)." >&2
  exit 3
fi
echo "OK: moby/profiles main still matches ${PINNED_COMMIT:0:12}."
