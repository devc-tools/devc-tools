#!/bin/bash
# Asserts one thing about the publishing workflows, and it is the one that fails silently in
# the worst way — by publishing something: **every step that publishes something
# irreversible is gated on BOTH the expected ref AND the run not being a dry run.**
#
#   bash tests/workflow_guards_test.sh
#
# Why this exists: `workflow_dispatch` can target any ref, a *tag* included. Gating a publish
# on the ref alone therefore publishes from a run whose own `dry_run` checkbox said not to —
# a GitHub release people may already have curled, and a ghcr.io tag that cannot be
# un-pushed. Both workflows shipped that way; this harness is what keeps the fix from being
# undone by a later edit that only looks at the ref.
#
# The two workflows expect *different* refs, which is why the expression is a parameter here
# rather than baked in: release.yml publishes binaries from a `v*` tag, while
# publish-feature.yml publishes Features from a push to `main`, each Feature at its own
# version (see .plans/archived/feature-independent-versions.md).
#
# `inputs` is null outside workflow_dispatch, so `!inputs.dry_run` is true on an ordinary
# push or tag and normal releases are unaffected.
#
# What the workflows *check* rather than publish is not covered here. That is
# `tests/features_test.sh`, which the publish workflow runs and which — unlike a guard
# inlined in YAML — is callable directly, so this harness no longer scrapes a `run:` block
# out of the file to make assertions about the shell inside it.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

# The `if:` line belonging to a named step: the first one within the few lines following it.
step_guard() { # step_guard <file> <step name>
  awk -v name="- name: $2" '
    index($0, name) { found = 1; next }
    found && /^ *if:/ { sub(/^ *if: */, ""); print; exit }
    found && /^ *- (name|uses):/ { exit }
  ' "$1"
}

guards_both() { # guards_both <file> <step name> <expected ref expression>
  local guard
  guard="$(step_guard "$1" "$2")"
  [ -n "$guard" ] || { echo "       (no if: found for '$2' in $1)"; return 1; }
  case "$guard" in
    *"$3"*) ;;
    *) echo "       (not gated on $3: $guard)"; return 1 ;;
  esac
  case "$guard" in
    *'!inputs.dry_run'*) ;;
    *) echo "       (not dry-run-gated: $guard)"; return 1 ;;
  esac
  return 0
}

echo 'publishing steps are gated on the expected ref AND on dry_run'
check 'release.yml — Publish release' \
  guards_both .github/workflows/release.yml 'Publish release' \
  "startsWith(github.ref, 'refs/tags/v')"
check 'publish-feature.yml — Publish Feature' \
  guards_both .github/workflows/publish-feature.yml 'Publish Feature' \
  "github.ref == 'refs/heads/main'"
check 'publish-feature.yml — Log in to ghcr.io (Feature)' \
  guards_both .github/workflows/publish-feature.yml 'Log in to ghcr.io (Feature)' \
  "github.ref == 'refs/heads/main'"

echo
echo 'every `features publish` invocation is one of the steps checked above'

# The checks above name their steps, so a publish step added later under a new name would be
# silently uncovered — the same shape as the bug features-collection removed, where a guard
# that named one Feature let the next one publish unguarded. Counting the invocations is
# crude, but it makes adding a third one impossible to do quietly: this fails until someone
# adds a guards_both check for it and bumps the count deliberately.
# Comment lines are stripped first: this file explains itself at length, and the prose names
# the command it is explaining. Counting those would make the check fail on a docs edit.
GUARDED_PUBLISH_STEPS=1
publish_invocations_are_all_guarded() {
  local n
  n="$(grep -vE '^[[:space:]]*#' .github/workflows/publish-feature.yml \
       | grep -c 'features publish')"
  [ "$n" -eq "$GUARDED_PUBLISH_STEPS" ] && return 0
  echo "       ($n \`features publish\` invocations, but $GUARDED_PUBLISH_STEPS are guarded above)"
  echo '       (add a guards_both check for the new step, then bump GUARDED_PUBLISH_STEPS)'
  return 1
}
check 'publish-feature.yml — no unguarded `features publish`' \
  publish_invocations_are_all_guarded

echo
echo 'the devcontainer CLI is pinned to one version repo-wide'
# Three pins of @devcontainers/cli must agree: publish-feature.yml runs it to publish Features,
# devc/deno.json *embeds* it in the devc binary (see .plans/devc-embedded-devcontainer-cli.md),
# and devc-core/package.json depends on it as the library's default runner (see
# .plans/devc-core-npm-library.md). Drifting them means the CLI that validates and publishes a
# Feature, the one devc installs, and the one @devc-tools/core runs under Node are three
# different things — measurably different behavior, found by whoever hits it rather than here.
# Comments saying "keep these in step" is how they drift; this is the assertion.
pins_agree() {
  local wf devc core
  wf="$(sed -n "s/.*DEVCONTAINERS_CLI: *'@devcontainers\/cli@\([^']*\)'.*/\1/p" \
        .github/workflows/publish-feature.yml)"
  devc="$(sed -n 's/.*"npm:@devcontainers\/cli@\([^"]*\)".*/\1/p' devc/deno.json)"
  core="$(sed -n 's/.*"@devcontainers\/cli": *"\([^"]*\)".*/\1/p' devc-core/package.json)"
  [ -n "$wf" ] || { echo '       (no DEVCONTAINERS_CLI pin in publish-feature.yml)'; return 1; }
  [ -n "$devc" ] || { echo '       (no @devcontainers/cli pin in devc/deno.json imports)'; return 1; }
  [ -n "$core" ] || { echo '       (no @devcontainers/cli pin in devc-core/package.json)'; return 1; }
  [ "$wf" = "$devc" ] && [ "$devc" = "$core" ] && return 0
  echo "       (publish-feature.yml pins $wf, devc/deno.json pins $devc, devc-core/package.json pins $core)"
  return 1
}
check 'publish-feature.yml, devc/deno.json and devc-core/package.json pin the same version' \
  pins_agree

echo
echo 'the devc-config Feature devc injects is pinned to its own manifest version'
# devc contributes DEVC_CONFIG_FEATURE to every container it starts, unlike every other
# Feature reference in the repo — a comment saying "keep these in step" is how this drifts, and
# a drifted pin here is invisible until someone bumps the Feature's version and devc keeps
# injecting the old one. See .plans/archived/devc-inject-project-hook.md.
devc_config_pin_agrees() {
  local overlay manifest
  overlay="$(grep -A1 '^export const DEVC_CONFIG_FEATURE' devc-core/overlay.ts \
    | sed -n "s/.*ghcr.io\/devc-tools\/devc-config:\([^']*\)'.*/\1/p")"
  manifest="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' \
    features/devc-config/devcontainer-feature.json)"
  [ -n "$overlay" ] || { echo '       (no DEVC_CONFIG_FEATURE pin in devc-core/overlay.ts)'; return 1; }
  [ -n "$manifest" ] || { echo '       (no "version" in features/devc-config/devcontainer-feature.json)'; return 1; }
  [ "$overlay" = "$manifest" ] && return 0
  echo "       (devc-core/overlay.ts pins $overlay, features/devc-config/devcontainer-feature.json is $manifest)"
  return 1
}
check 'devc-core/overlay.ts DEVC_CONFIG_FEATURE and the manifest version agree' \
  devc_config_pin_agrees

echo
echo 'both workflows still declare the dry_run input they are gated on'
for f in .github/workflows/release.yml .github/workflows/publish-feature.yml; do
  check "$(basename "$f") declares dry_run" grep -q '^      dry_run:' "$f"
done

echo
if [ "$fails" -eq 0 ]; then echo 'ALL PASS'; else echo "$fails FAILED"; fi
exit "$((fails > 0))"
