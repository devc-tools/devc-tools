#!/bin/bash
# xvfb-ensure end to end, offline — the stdout contract, start-or-reuse order, stale and
# unremovable locks, --status, --stop and argument validation.
#
#   bash features/xvfb/test/xvfb_ensure_test.sh
#
# No Docker, no X: fake `Xvfb` and `xdpyinfo` scripts sit on PATH ahead of anything real. A
# fake server "comes up" by creating a marker file named after its display, which is all the
# fake xdpyinfo checks — so "is a server answering on :N" is a fact this harness controls. The
# fake Xvfb is otherwise a real long-running process, started through the real setsid/nohup
# path, so "it outlives the caller" and "--stop signals the right pid" are exercised for real.
#
# XVFB_ENSURE_STATE_DIR points the lock/pid/log directory at a scratch dir in place of /tmp.
set -uo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENSURE="$FEATURE_DIR/xvfb-ensure"
WORK="$(mktemp -d)"

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}
check_err() { # check_err <desc> <expected-substring> — in the last run's stderr
  local desc="$1" pat="$2"
  if grep -qF -- "$pat" "$WORK/err.log"; then
    echo "  ok   $desc"
  else
    echo "  FAIL $desc (no '$pat' on stderr)"; sed 's/^/       | /' "$WORK/err.log"
    fails=$((fails + 1))
  fi
}

STUB_BIN="$WORK/stub-bin"
mkdir -p "$STUB_BIN"

# The fake server. `Xvfb :N ...`: refuses to start when $FAKE/fail-N exists; otherwise takes the
# lock the way a real one does, marks itself live, and waits to be signalled.
cat > "$STUB_BIN/Xvfb" << 'EOF2'
#!/bin/sh
n="${1#:}"
echo "$$ $*" >> "$FAKE/starts"
[ -e "$FAKE/fail-$n" ] && { echo "fake Xvfb: told to fail on :$n" >&2; exit 1; }
lock="$XVFB_ENSURE_STATE_DIR/.X$n-lock"
printf '%10d\n' "$$" > "$lock"
: > "$FAKE/live-:$n"
trap 'rm -f "$FAKE/live-:$n" "$lock"; exit 0' TERM INT
while :; do sleep 0.1; done
EOF2
# The fake probe. `xdpyinfo -display <d>`: answers iff a server marked that display live.
cat > "$STUB_BIN/xdpyinfo" << 'EOF2'
#!/bin/sh
d="${DISPLAY:-}"
[ "${1:-}" = -display ] && d="$2"
echo "$d" >> "$FAKE/probes"
[ -e "$FAKE/live-$d" ]
EOF2
chmod 755 "$STUB_BIN/Xvfb" "$STUB_BIN/xdpyinfo"

# Every fake server any case started, live or not — killed on the way out, since by design they
# do not die with this script.
cleanup() {
  local pid
  for pid in $(cat "$WORK"/*/fake/starts 2> /dev/null | cut -d' ' -f1); do
    kill "$pid" 2> /dev/null
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

# new_case <name> — a fresh state dir and fake-server dir. Sets $state and $fake.
new_case() {
  state="$WORK/$1/state"; fake="$WORK/$1/fake"
  mkdir -p "$state" "$fake"
  : > "$fake/starts"; : > "$fake/probes"
}

# run [VAR=value ...] -- [args...] — runs the real xvfb-ensure. Sets $out, $status; stderr goes
# to $WORK/err.log. $DISPLAY is unset unless a case passes one.
run() {
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do envs+=("$1"); shift; done
  [ "$#" -gt 0 ] && shift
  out="$(env -u DISPLAY -u DEFAULT_DISPLAY -u DEFAULT_SCREEN PATH="$STUB_BIN:$PATH" \
    XVFB_ENSURE_STATE_DIR="$state" FAKE="$fake" "${envs[@]}" \
    sh "$ENSURE" "$@" 2> "$WORK/err.log")"
  status=$?
}

starts() { wc -l < "$fake/starts" | tr -d ' '; }
one_line() { [ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" -eq 1 ]; }
alive() { kill -0 "$1" 2> /dev/null; }
# A pid that is certainly not running: one that just was.
dead_pid() { sh -c 'echo $$'; }
# fake_server <N> — a live server this command did not start: no pidfile of ours names it.
fake_server() {
  PATH="$STUB_BIN:$PATH" XVFB_ENSURE_STATE_DIR="$state" FAKE="$fake" \
    setsid sh "$STUB_BIN/Xvfb" ":$1" > /dev/null 2>&1 < /dev/null &
  local i=0
  while [ ! -e "$fake/live-:$1" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  : > "$fake/starts.before"; cp "$fake/starts" "$fake/starts.before"
}

echo "case 1: nothing running — starts a server on the default display"
new_case c1
run --
check "exits 0" test "$status" -eq 0
check "stdout is the export line" test "$out" = 'export DISPLAY=":99"'
check "and nothing else" one_line
check "eval of it sets DISPLAY" bash -c "eval '$out' && [ \"\$DISPLAY\" = :99 ]"
check "one server was started" test "$(starts)" -eq 1
check "with the default screen, no TCP listener, no reset, and GLX named" grep -qF \
  ':99 -screen 0 1920x1080x24 -nolisten tcp -noreset +extension GLX' "$fake/starts"
check "a pidfile names it" test -f "$state/xvfb-99.pid"
c1_pid="$(cat "$state/xvfb-99.pid")"
check "the pidfile holds the server's own pid" \
  test "$c1_pid" = "$(cut -d' ' -f1 "$fake/starts")"
check "which outlived the caller" alive "$c1_pid"
check "in a session of its own" \
  test "$(ps -o sid= -p "$c1_pid" | tr -d ' ')" != "$(ps -o sid= -p $$ | tr -d ' ')"
check "its log is beside the pidfile" test -f "$state/xvfb-99.log"
check_err "the diagnostic went to stderr" 'started Xvfb on display :99'

echo "case 2: a second call reuses it and starts nothing"
run --
check "exits 0" test "$status" -eq 0
check "the identical line" test "$out" = 'export DISPLAY=":99"'
check "and nothing else" one_line
check "still one server" test "$(starts)" -eq 1
check "the same one" test "$(cat "$state/xvfb-99.pid")" = "$c1_pid"

echo "case 3: --status reports it and starts nothing"
run -- --status
check "exits 0" test "$status" -eq 0
check "the same export line" test "$out" = 'export DISPLAY=":99"'
check "and nothing else" one_line
check "still one server" test "$(starts)" -eq 1

echo "case 4: --stop stops it, and --status then finds nothing"
run -- --stop
check "exits 0" test "$status" -eq 0
check "stdout is empty" test -z "$out"
check "the server is gone" bash -c "! kill -0 $c1_pid 2>/dev/null"
check "the pidfile is removed" test ! -e "$state/xvfb-99.pid"
run -- --status
check "--status exits 1" test "$status" -eq 1
check "with nothing on stdout" test -z "$out"
check "and still started nothing" test "$(starts)" -eq 1
run -- --stop
check "--stop with nothing running still exits 0" test "$status" -eq 0
check "with nothing on stdout" test -z "$out"

echo "case 5: a live \$DISPLAY is reused as it is"
new_case c5
: > "$fake/live-:7"
run DISPLAY=:7 --
check "exits 0" test "$status" -eq 0
check "prints that display" test "$out" = 'export DISPLAY=":7"'
check "and nothing else" one_line
check "starts nothing" test "$(starts)" -eq 0
check "it was the first thing asked" test "$(head -1 "$fake/probes")" = ':7'
: > "$fake/live-localhost:10.0"
run DISPLAY=localhost:10.0 --
check "a forwarded host display is reused too" test "$out" = 'export DISPLAY="localhost:10.0"'
run DISPLAY=:7 -- --status
check "--status reports a live \$DISPLAY the same way" test "$out" = 'export DISPLAY=":7"'

echo "case 6: a dead \$DISPLAY is not reused"
new_case c6
run DISPLAY=:7 --
check "exits 0" test "$status" -eq 0
check "a virtual display is started instead" test "$out" = 'export DISPLAY=":99"'
check "one server was started" test "$(starts)" -eq 1
run -- --stop

echo "case 7: --display overrides a live \$DISPLAY"
new_case c7
: > "$fake/live-:7"
run DISPLAY=:7 -- --display 50
check "exits 0" test "$status" -eq 0
check "the requested display, not the live one" test "$out" = 'export DISPLAY=":50"'
check "the live \$DISPLAY was never even asked" bash -c "! grep -qx ':7' '$fake/probes'"
check "one server was started, on 50" grep -q ' :50 ' "$fake/starts"
run -- --display=50 --status
check "--display=N is the same option" test "$out" = 'export DISPLAY=":50"'
run -- --stop --display 50

echo "case 8: a \$DISPLAY that is not a display name is never echoed back"
new_case c8
run "DISPLAY=:7\"; touch $WORK/PWNED; \"" --
check "exits 0" test "$status" -eq 0
check "a virtual display is printed instead" test "$out" = 'export DISPLAY=":99"'
eval "$out"
check "and eval of the output ran nothing" test ! -e "$WORK/PWNED"
check_err "it says why" 'not a display name'
unset DISPLAY
run -- --stop

echo "case 9: a live server on a later candidate is reused without starting another"
new_case c9
fake_server 101
run --
check "exits 0" test "$status" -eq 0
check "prints the live candidate" test "$out" = 'export DISPLAY=":101"'
check "and nothing else" one_line
check "starts nothing of its own" cmp -s "$fake/starts" "$fake/starts.before"
check "and writes no pidfile for a server it did not start" \
  bash -c "! ls '$state'/xvfb-*.pid >/dev/null 2>&1"

echo "case 10: --stop never touches a server it did not start"
c10_pid="$(cut -d' ' -f1 "$fake/starts")"
run -- --stop
check "exits 0" test "$status" -eq 0
check "the foreign server is still running" alive "$c10_pid"
check "and still answering" test -e "$fake/live-:101"
run -- --stop --display 101
check "even when its display is named" alive "$c10_pid"
kill "$c10_pid"

echo "case 11: a stale lock is cleared, then started on"
new_case c11
printf '%10d\n' "$(dead_pid)" > "$state/.X99-lock"
run --
check "exits 0" test "$status" -eq 0
check "starts on the display whose lock was stale" test "$out" = 'export DISPLAY=":99"'
check "and nothing else on stdout" one_line
check_err "says it removed the lock" 'removed stale lock'
check "one server was started" test "$(starts)" -eq 1
run -- --stop

echo "case 12: an unremovable lock is skipped to the next candidate"
new_case c12
# A non-empty directory where the lock would be: `rm -f` cannot remove it, whoever runs this.
mkdir -p "$state/.X99-lock/pinned"
run --
check "exits 0" test "$status" -eq 0
check "starts on the next candidate" test "$out" = 'export DISPLAY=":100"'
check "and nothing else on stdout" one_line
check_err "says which lock it could not remove" 'stale lock that cannot be removed'
check "the unremovable lock is left alone" test -d "$state/.X99-lock/pinned"
check "exactly one server was started" test "$(starts)" -eq 1
check "on 100" grep -q ' :100 ' "$fake/starts"
run -- --stop

echo "case 13: a lock held by a live process that is not answering is left alone"
new_case c13
sleep 30 &
c13_holder=$!
printf '%10d\n' "$c13_holder" > "$state/.X99-lock"
run --
check "exits 0" test "$status" -eq 0
check "starts on the next candidate" test "$out" = 'export DISPLAY=":100"'
check "the held lock is untouched" test -f "$state/.X99-lock"
check_err "names the holder" "locked by pid $c13_holder"
kill "$c13_holder" 2> /dev/null
run -- --stop

echo "case 14: a server that fails to start falls through to the next candidate"
new_case c14
: > "$fake/fail-99"; : > "$fake/fail-100"
run --
check "exits 0" test "$status" -eq 0
check "the first candidate that comes up wins" test "$out" = 'export DISPLAY=":101"'
check "and nothing else on stdout" one_line
check "three starts were attempted" test "$(starts)" -eq 3
check "no pidfile is left for a failed start" \
  bash -c "[ ! -e '$state/xvfb-99.pid' ] && [ ! -e '$state/xvfb-100.pid' ]"
check_err "each failure names its log" "see $state/xvfb-99.log"
check "which holds the server's own complaint" grep -q 'told to fail on :99' "$state/xvfb-99.log"
run -- --stop

echo "case 15: every candidate failing exits 1, naming them"
new_case c15
for n in 99 100 101 102 103 104; do : > "$fake/fail-$n"; done
run --
check "exits 1" test "$status" -eq 1
check "stdout is empty" test -z "$out"
check "all six candidates were tried" test "$(starts)" -eq 6
check_err "the message names the candidates" ':99 :100 :101 :102 :103 :104'
check "no pidfile is left behind" bash -c "! ls '$state'/xvfb-*.pid >/dev/null 2>&1"

echo "case 16: --display and --screen reach the server"
new_case c16
run -- --display 7 --screen 640x480x16
check "exits 0" test "$status" -eq 0
check "prints the requested display" test "$out" = 'export DISPLAY=":7"'
check "the server got the requested screen" grep -qF ':7 -screen 0 640x480x16 ' "$fake/starts"
: > "$fake/fail-8"; : > "$fake/fail-9"; : > "$fake/fail-10"; : > "$fake/fail-11"
: > "$fake/fail-12"; : > "$fake/fail-13"
run -- --display 8
check "candidates run from the requested number" test "$status" -eq 1
check_err "N through N+5" ':8 :9 :10 :11 :12 :13'
run -- --stop

echo "case 17: --stop --display stops only that display"
new_case c17
run -- --display 20
run -- --display 30
pid20="$(cat "$state/xvfb-20.pid")"; pid30="$(cat "$state/xvfb-30.pid")"
run -- --stop --display 20
check "exits 0" test "$status" -eq 0
check "the named one is gone" bash -c "! kill -0 $pid20 2>/dev/null"
check "the other is still running" alive "$pid30"
check "and keeps its pidfile" test -f "$state/xvfb-30.pid"
run -- --stop
check "a bare --stop stops the rest" bash -c "! kill -0 $pid30 2>/dev/null"
check "leaving no pidfile" bash -c "! ls '$state'/xvfb-*.pid >/dev/null 2>&1"

echo "case 18: --stop does not signal a recycled pid"
new_case c18
sleep 30 &
c18_bystander=$!
echo "$c18_bystander" > "$state/xvfb-99.pid"
run -- --stop
check "exits 0" test "$status" -eq 0
check "a process that is not an Xvfb is left running" alive "$c18_bystander"
check "the stale pidfile is still removed" test ! -e "$state/xvfb-99.pid"
kill "$c18_bystander" 2> /dev/null

echo "case 19: argument validation"
new_case c19
for bad in ':99' '9a' '-1' '' '9;id'; do
  run -- --display "$bad"
  check "--display $(printf '%q' "$bad") exits 2" test "$status" -eq 2
  check "with nothing on stdout" test -z "$out"
  check_err "and prints usage" 'usage: xvfb-ensure'
done
for bad in '1920x1080' '1920x1080x12' '1920X1080x24' 'x1080x24' '1920x1080x24;id'; do
  run -- --screen "$bad"
  check "--screen $(printf '%q' "$bad") exits 2" test "$status" -eq 2
  check "with nothing on stdout" test -z "$out"
  check_err "and prints usage" 'usage: xvfb-ensure'
done
run -- --display
check "--display with no value exits 2" test "$status" -eq 2
run -- --screen
check "--screen with no value exits 2" test "$status" -eq 2
run -- --bogus
check "an unknown argument exits 2" test "$status" -eq 2
check_err "naming it" 'unknown argument: --bogus'
run -- --help
check "--help exits 0" test "$status" -eq 0
check "and keeps stdout empty — it is reserved for the export line" test -z "$out"
check "nothing was ever started by any of these" test "$(starts)" -eq 0

echo "case 20: the baked defaults are what a bare call uses"
new_case c20
run DEFAULT_DISPLAY=42 DEFAULT_SCREEN=800x600x8 --
check "the default display" test "$out" = 'export DISPLAY=":42"'
check "the default screen" grep -qF ':42 -screen 0 800x600x8 ' "$fake/starts"
run DEFAULT_DISPLAY=42 -- --stop

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
