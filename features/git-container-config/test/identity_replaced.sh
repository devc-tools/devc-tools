#!/bin/bash
# Scenario `identity_replaced` — the identity file is replaced by rename *after* create, the way
# devc's initialize-command.sh replaces it on the host every time any project runs `devc up`.
#
# The consumer's half of the fix is binding the identity *directory* (see README.md), which a
# scenario cannot declare; this covers the Feature's half: include.path names the file by path
# and is resolved on every git invocation, so a file swapped in under that name is what git reads
# — no re-run of the create hook, no restart. Written in-container with a temp file + mv, the
# same shape as the host writer.
set -e

source dev-container-features-test-lib

IDENTITY=/usr/local/share/devc-features/git-container-config/identity/gitconfig

check "the identity resolves at create" bash -c \
  "[ \"\$(git config --get user.email)\" = before@example.com ]"

before_ino="$(stat -c %i "$IDENTITY")"
tmp="$(dirname "$IDENTITY")/.gitconfig.$$"
printf '[user]\n\temail = after@example.com\n\tname = Scenario Tester\n' > "$tmp"
mv -f "$tmp" "$IDENTITY"

check "the file really was replaced, not rewritten in place" bash -c \
  "[ \"\$(stat -c %i '$IDENTITY')\" != '$before_ino' ]"
check "the replaced identity resolves without re-running create" bash -c \
  "[ \"\$(git config --get user.email)\" = after@example.com ]"
check "and exactly one include.path still names it" bash -c \
  "[ \"\$(git config --global --get-all include.path)\" = '$IDENTITY' ]"

reportResults
