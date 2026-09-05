#!/bin/bash
# agents offline harness — the real create-time-plugins.sh, sourced and exercised directly
# against fake `pi`/`herdr`/`git`/`node` binaries on PATH, with a fake $HOME. No Docker, no
# root, no network:
#
#   bash features/agents/test/create_time_plugins_test.sh
#
# This is create-time-plugins.sh's own coverage — comma-splitting/trimming, the `--yes`/install
# invocations, the non-fatal warn-and-continue on a failed entry, and the missing-binary /
# missing-git skips. It replaces what install_options_test.sh's old cases 10-13 used to cover,
# back when this logic ran at build time inside install.sh itself — see create-time-plugins.sh's
# own header for why it moved to create time.
set -uo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

warn() { echo "agents: $*" >&2; }

# Each case below sources the real create-time-plugins.sh into a fresh subshell with $HOME
# pointed at a fresh fake home, and its own fake pi/herdr first on PATH.
fake_bin() { # fake_bin <dir> <name> <exit code> <invoke log path>
  cat > "$1/$2" << FAKEBIN
#!/bin/sh
echo "$2 \$*" >> "$4"
exit "$3"
FAKEBIN
  chmod +x "$1/$2"
}

echo "case 1: piPackages — comma-split, trimmed, empties dropped, each installed in order"
CASE="$WORK/c1"; mkdir -p "$CASE/home" "$CASE/stubs"
fake_bin "$CASE/stubs" pi 0 "$CASE/invoke.log"
: > "$CASE/invoke.log"
(
  HOME="$CASE/home" PATH="$CASE/stubs:$PATH"
  export HOME PATH
  # shellcheck source=../create-time-plugins.sh
  . "$FEATURE_DIR/create-time-plugins.sh"
  install_pi_packages " npm:@andrewjacop/pi-herdr ,,git:github.com/bmingles/pi-dev-extensions@main, "
) > /dev/null 2>&1
check "exactly two pi installs ran — empty/whitespace-only entries dropped" \
  test "$(grep -c '^pi ' "$CASE/invoke.log")" -eq 2
check "the first entry was trimmed" \
  grep -qxF 'pi install npm:@andrewjacop/pi-herdr' "$CASE/invoke.log"
check "the second entry was trimmed too, as one argument" \
  grep -qxF 'pi install git:github.com/bmingles/pi-dev-extensions@main' "$CASE/invoke.log"

echo "case 2: herdrPlugins — comma-split, trimmed, each installed with --yes"
CASE="$WORK/c2"; mkdir -p "$CASE/home" "$CASE/stubs"
fake_bin "$CASE/stubs" herdr 0 "$CASE/invoke.log"
: > "$CASE/invoke.log"
(
  HOME="$CASE/home" PATH="$CASE/stubs:$PATH"
  export HOME PATH
  . "$FEATURE_DIR/create-time-plugins.sh"
  install_herdr_plugins " bmingles/herdr-plugins/agent-caffeinate , owner/repo/sub,"
) > /dev/null 2>&1
check "exactly two plugin installs ran" test "$(grep -c '^herdr ' "$CASE/invoke.log")" -eq 2
check "the first plugin was trimmed and installed with --yes" \
  grep -qxF 'herdr plugin install bmingles/herdr-plugins/agent-caffeinate --yes' "$CASE/invoke.log"
check "the second plugin was trimmed too" \
  grep -qxF 'herdr plugin install owner/repo/sub --yes' "$CASE/invoke.log"

echo "case 3: a failed pi install warns and continues — later entries still run, no abort"
CASE="$WORK/c3"; mkdir -p "$CASE/home" "$CASE/stubs"
fake_bin "$CASE/stubs" pi 1 "$CASE/invoke.log"
: > "$CASE/invoke.log"
OUT="$WORK/c3.out"
(
  HOME="$CASE/home" PATH="$CASE/stubs:$PATH"
  export HOME PATH
  . "$FEATURE_DIR/create-time-plugins.sh"
  install_pi_packages "npm:one,npm:two"
) > "$OUT" 2>&1
STATUS=$?
check "the subshell itself still exits 0 — a failed entry does not abort the caller" \
  test "$STATUS" -eq 0
check "both entries were attempted despite the first failing" \
  test "$(grep -c '^pi ' "$CASE/invoke.log")" -eq 2
check "the failure was warned, naming the entry" grep -q 'pi install npm:one failed' "$OUT"

echo "case 4: a failed herdr plugin install warns and continues"
CASE="$WORK/c4"; mkdir -p "$CASE/home" "$CASE/stubs"
fake_bin "$CASE/stubs" herdr 1 "$CASE/invoke.log"
: > "$CASE/invoke.log"
OUT="$WORK/c4.out"
(
  HOME="$CASE/home" PATH="$CASE/stubs:$PATH"
  export HOME PATH
  . "$FEATURE_DIR/create-time-plugins.sh"
  install_herdr_plugins "owner/one,owner/two"
) > "$OUT" 2>&1
STATUS=$?
check "the subshell itself still exits 0" test "$STATUS" -eq 0
check "both plugins were attempted despite the first failing" \
  test "$(grep -c '^herdr ' "$CASE/invoke.log")" -eq 2
check "the failure was warned, naming the entry" grep -q 'herdr plugin install owner/one failed' "$OUT"

echo "case 5: pi not installed — skips with a warning, does not error"
CASE="$WORK/c5"; mkdir -p "$CASE/home" "$CASE/stubs"
# No `pi` on PATH at all in this case's stub dir.
OUT="$WORK/c5.out"
(
  HOME="$CASE/home" PATH="$CASE/stubs:/usr/bin:/bin"
  export HOME PATH
  . "$FEATURE_DIR/create-time-plugins.sh"
  install_pi_packages "npm:whatever"
) > "$OUT" 2>&1
STATUS=$?
check "exits 0 — a missing pi skips, it does not fail the create" test "$STATUS" -eq 0
check "it warns that pi is not installed" grep -q 'pi is not installed' "$OUT"

echo "case 6: herdr not installed — skips with a warning, does not error"
CASE="$WORK/c6"; mkdir -p "$CASE/home" "$CASE/stubs"
OUT="$WORK/c6.out"
(
  HOME="$CASE/home" PATH="$CASE/stubs:/usr/bin:/bin"
  export HOME PATH
  . "$FEATURE_DIR/create-time-plugins.sh"
  install_herdr_plugins "owner/repo"
) > "$OUT" 2>&1
STATUS=$?
check "exits 0 — a missing herdr skips, it does not fail the create" test "$STATUS" -eq 0
check "it warns that herdr is not installed" grep -q 'herdr is not installed' "$OUT"

echo "case 7: empty lists are a no-op — no binary needs to exist at all"
CASE="$WORK/c7"; mkdir -p "$CASE/home"
OUT="$WORK/c7.out"
(
  HOME="$CASE/home" PATH="/usr/bin:/bin"
  export HOME PATH
  . "$FEATURE_DIR/create-time-plugins.sh"
  install_pi_packages ""
  install_herdr_plugins ""
) > "$OUT" 2>&1
STATUS=$?
check "exits 0" test "$STATUS" -eq 0
check "nothing was warned — empty is a working state, not a broken one" test ! -s "$OUT"

echo "case 8: resolve_bin prefers ~/.local/bin over PATH"
CASE="$WORK/c8"; mkdir -p "$CASE/home/.local/bin" "$CASE/stubs"
fake_bin "$CASE/home/.local/bin" herdr 0 "$CASE/invoke.log"
fake_bin "$CASE/stubs" herdr 0 "$CASE/wrong-invoke.log"
: > "$CASE/invoke.log"; : > "$CASE/wrong-invoke.log"
(
  HOME="$CASE/home" PATH="$CASE/stubs:$PATH"
  export HOME PATH
  . "$FEATURE_DIR/create-time-plugins.sh"
  install_herdr_plugins "owner/repo"
) > /dev/null 2>&1
check "the ~/.local/bin copy was invoked" test -s "$CASE/invoke.log"
check "not the one merely on PATH" test ! -s "$CASE/wrong-invoke.log"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
