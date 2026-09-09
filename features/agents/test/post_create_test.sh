#!/bin/bash
# agents offline harness — the real post-create.sh's ~/.claude half, run against a fake $HOME
# with no container involved:
#
#   bash features/agents/test/post_create_test.sh
#
# What this owns, and what the two fence harnesses do not:
#
#   - the unconditional `devc:seed-cleanup` block, which lives OUTSIDE the `devc:seed-link`
#     fence and so is unreachable from devc/tests/seed_link_test.sh, and
#   - the claudeSeed guard itself: that with no claude-seed.conf installed, the whole script
#     links nothing into ~/.claude. That is what makes "the default is off" a tested claim
#     rather than an asserted one.
#
# The conf-present arm is not reachable offline — the file lives under /usr/local/share, which
# needs root to write — so it is left to test/scenarios.json's with_seed scenario under Docker.
# What IS reachable, and pinned here, is the arm that ships by default.
set -uo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$FEATURE_DIR/post-create.sh"
SEED_PATH=/usr/local/share/devc-features/agents/claude-seed
CONF="$SEED_PATH.conf"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

# The whole point of case 1 is that the option is off, which here means the file is absent. If
# this container really does have one installed, every assertion below would be measuring the
# wrong thing — so say so rather than pass.
if [ -e "$CONF" ]; then
  echo "FAIL: $CONF exists in this environment; the default-off cases cannot be measured here"
  exit 1
fi

echo "case 1: no claude-seed.conf — the whole script links nothing, and prunes old seed links"
H="$WORK/c1/home"; mkdir -p "$H/.claude"
# What a container built by agents <= 0.5.0 comes back with: seed symlinks in ~/.claude. With
# the option off and nothing mounted onto the seed path, these dangle.
ln -s "$SEED_PATH/CLAUDE.md" "$H/.claude/CLAUDE.md"
ln -s "$SEED_PATH/settings.json" "$H/.claude/settings.json"
# Volume-local state that must survive untouched.
echo '{"k":1}' > "$H/.claude/.credentials.json"
mkdir -p "$H/.claude/projects"
echo "keep" > "$WORK/c1/elsewhere"
ln -s "$WORK/c1/elsewhere" "$H/.claude/unrelated-link"
( HOME="$H" bash "$SCRIPT" > "$WORK/c1/out.log" 2>&1 ) || {
  echo "  FAIL script exited nonzero"; cat "$WORK/c1/out.log"; fails=$((fails + 1)); }
check "the dangling seed link was removed" test ! -e "$H/.claude/CLAUDE.md"
check "and so was the second one" test ! -e "$H/.claude/settings.json"
check "no dangling link is left anywhere in ~/.claude" \
  test -z "$(find "$H/.claude" -mindepth 1 -maxdepth 1 -xtype l)"
check "nothing new was linked in — the seed is off" \
  test -z "$(find "$H/.claude" -mindepth 1 -maxdepth 1 -type l ! -name unrelated-link)"
check "the unrelated symlink survives" test -L "$H/.claude/unrelated-link"
check "volume-local .credentials.json survives" test -f "$H/.claude/.credentials.json"
check "volume-local projects/ survives" test -d "$H/.claude/projects"

echo "case 2: the cleanup fence touches only links pointing into the fixed seed path"
BLOCK="$WORK/cleanup.sh"
awk '/# devc:seed-cleanup \(start\)/{f=1;next} /# devc:seed-cleanup \(end\)/{f=0} f' \
  "$SCRIPT" > "$BLOCK"
grep -q 'rm -f' "$BLOCK" || { echo "FAIL: could not extract the seed-cleanup block"; exit 1; }
check "the block hardcodes the seed path rather than a third parameterized variable" \
  grep -qF "$SEED_PATH/*)" "$BLOCK"
H="$WORK/c2/home"; mkdir -p "$H/.claude/skills"
ln -s "$SEED_PATH/CLAUDE.md" "$H/.claude/CLAUDE.md"
ln -s "/usr/local/share/devc-features/agents/herdr-seed/config.toml" "$H/.claude/herdr-ish"
ln -s "../elsewhere/relative" "$H/.claude/relative-link"
( HOME="$H" bash "$BLOCK" > "$WORK/c2/out.log" 2>&1 ) || {
  echo "  FAIL cleanup block exited nonzero"; cat "$WORK/c2/out.log"; fails=$((fails + 1)); }
check "the seed link is gone" test ! -e "$H/.claude/CLAUDE.md"
check "a link into a DIFFERENT fixed path survives" test -L "$H/.claude/herdr-ish"
check "a relative link survives" test -L "$H/.claude/relative-link"
check "a subdirectory mountpoint survives" test -d "$H/.claude/skills"

echo "case 3: the claudeSeed guard wraps the fence from OUTSIDE the markers"
# devc/tests/seed_link_test.sh extracts everything strictly between the markers and re-points it
# with `sed` on ^SEED= / ^CLAUDE_DIR=. An `if` inside the markers would be extracted without its
# `fi`, and an indented body would stop matching those anchors. Both are pinned here.
check "the guard line sits immediately above the start marker" \
  bash -c "grep -A1 -F 'claude-seed.conf 2> /dev/null' \"$SCRIPT\" | grep -qF '# devc:seed-link (start)'"
check "a bare fi sits immediately below the end marker" \
  bash -c "grep -A1 -xF '# devc:seed-link (end)' \"$SCRIPT\" | grep -qx 'fi'"
check "the fence body still carries exactly two line-start assignments" \
  bash -c "[ \"\$(awk '/# devc:seed-link \(start\)/{f=1;next} /# devc:seed-link \(end\)/{f=0} f' \"$SCRIPT\" | grep -c '^SEED=\|^CLAUDE_DIR=')\" = 2 ]"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
