#!/bin/bash
# Guards the devcontainer Feature collection under features/: the handful of things that
# must be true before a Feature is published, each of which either cannot be walked back
# once it is on ghcr.io or surfaces far from its cause.
#
#   bash tests/features_test.sh                          # the whole collection
#   bash tests/features_test.sh --feature node-nvmrc     # one Feature
#   bash tests/features_test.sh --check-release-pins     # + the one network check (needs gh)
#
# The collection is **walked, never enumerated** — `features/*/devcontainer-feature.json`,
# so a Feature added beside the others is covered without editing this file, and an empty
# glob is a failure rather than a pass. A guard that finds nothing to check must not report
# success; that is the failure `.plans/archived/features-collection.md` existed to prevent.
# Every offender is reported before exiting, since "which of the five?" is the only question
# a failed publish run has to answer.
#
# This was forty lines of `run:` inside publish-feature.yml, which is *why*
# tests/workflow_guards_test.sh used to carry an awk function that scraped a block scalar
# out of the YAML by indentation and then asserted things about the extracted string. A
# script is callable: the workflow runs this, and so can you, before you push.
#
# What it deliberately does NOT check: that a Feature's `version` was bumped when its files
# changed. The registry already answers that — `devcontainer features publish` skips a
# version it finds in the registry, so an unbumped Feature simply does not publish and the
# run says so. See .plans/archived/feature-independent-versions.md.
#
# It also asserts every features/PUBLISH_ALLOWLIST.txt entry names a real Feature — the one
# static list in this collection, and the gate that keeps a Feature under active development
# off ghcr.io. See features/CONTRIBUTING.md#the-publish-allowlist.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

only=''
check_release_pins=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    # Narrowing to one Feature is what lets publish-feature.yml run this per matrix job, so
    # one Feature's failed guard cannot fail another Feature's publish. The default stays
    # the whole collection: a local run with no arguments checks everything.
    --feature)
      only="${2:-}"
      [ -n "$only" ] || { echo 'usage: --feature <id>' >&2; exit 2; }
      shift 2
      ;;
    --check-release-pins) check_release_pins=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

# --- what is in scope --------------------------------------------------------------------

feature_dirs=()
for manifest in features/*/devcontainer-feature.json; do
  # No nullglob here, so an unmatched glob arrives as its own literal.
  [ -f "$manifest" ] || continue
  dir="$(dirname "$manifest")"
  [ -z "$only" ] || [ "$(basename "$dir")" = "$only" ] || continue
  feature_dirs+=("$dir")
done

# An empty scope is a failure in both spellings, and for the same reason: a run that
# checked nothing must not be mistaken for a run that found nothing wrong. `--feature` with
# a typo'd id is the likelier one — in the publish matrix it would guard a Feature that is
# not the one about to be published.
if [ "${#feature_dirs[@]}" -eq 0 ]; then
  if [ -n "$only" ]; then
    echo "  FAIL --feature $only — no features/$only/devcontainer-feature.json"
  else
    echo '  FAIL no features/*/devcontainer-feature.json found — has the collection moved?'
  fi
  echo
  echo '1 FAILED'
  exit 1
fi

# --- the manifest ------------------------------------------------------------------------

manifest_field() { # manifest_field <feature dir> <field>
  jq -r --arg f "$2" '.[$f] // ""' "$1/devcontainer-feature.json"
}

# `features package` derives the artifact name from `id`, so a mismatch publishes under a
# name nothing references — and reads as a baffling packaging error rather than the typo it
# is.
id_matches_dir() { # id_matches_dir <feature dir>
  local id
  id="$(manifest_field "$1" id)" || return 1
  [ "$id" = "$(basename "$1")" ] && return 0
  echo "       (id '$id' does not match directory '$(basename "$1")')"
  return 1
}

# Each Feature carries its own version now, so there is no other version to compare against
# — but the CLI derives the whole tag set (`latest`, major, major.minor, the full version)
# from it with semver, and only advances the floating tags when the new version is the max
# satisfying one. Something it cannot parse publishes under tags nobody can pin.
SEMVER_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
version_is_semver() { # version_is_semver <feature dir>
  local version
  version="$(manifest_field "$1" version)" || return 1
  [[ "$version" =~ $SEMVER_RE ]] && return 0
  echo "       (version '$version' is not semver — publishing derives every tag from it)"
  return 1
}

# `features package` refuses a Feature missing either, and the error it prints is a long way
# from the manifest that caused it.
field_is_nonempty() { # field_is_nonempty <feature dir> <field>
  local value
  value="$(manifest_field "$1" "$2")" || return 1
  [ -n "$value" ] && return 0
  echo "       ($2 is empty or absent — features package refuses the Feature)"
  return 1
}

echo "every Feature's manifest is publishable (${#feature_dirs[@]} in scope)"
for dir in "${feature_dirs[@]}"; do
  check "$dir — id equals its directory name" id_matches_dir "$dir"
  check "$dir — version is semver" version_is_semver "$dir"
  check "$dir — name is non-empty" field_is_nonempty "$dir" name
  check "$dir — description is non-empty" field_is_nonempty "$dir" description
done

# --- the release pin (the one network check) ---------------------------------------------
#
# A Feature that downloads a release asset bakes DEVC_TOOLS_RELEASE='<tag>' into its
# install.sh, naming the devc-tools release it fetches from — NOT its own version; the two
# are independent. Publishing used to be tag-triggered, which meant the release always
# existed by the time a Feature shipped pinned to it. Publishing from `main` does not, so
# the guard the tag was accidentally providing is made explicit here.
#
# Absent is normal: only a Feature that fetches something pins anything, and a Feature that
# downloads nothing must not be made to invent a version to keep a guard happy.

release_pin() { # release_pin <feature dir> — prints the pinned tag, or nothing
  [ -f "$1/install.sh" ] || return 0
  sed -n "s/^DEVC_TOOLS_RELEASE='\(.*\)'\$/\1/p" "$1/install.sh"
}

release_exists() { # release_exists <tag> <feature dir>
  if ! command -v gh >/dev/null 2>&1; then
    echo '       (gh is not on PATH — this check needs it; the workflow passes GH_TOKEN)'
    return 1
  fi
  # No --repo: gh resolves it from the checkout's own remote, so this asks about the repo
  # the Feature is published from rather than a name spelled out in two places.
  gh release view "$1" >/dev/null 2>&1 && return 0
  echo "       ($2/install.sh pins DEVC_TOOLS_RELEASE='$1', which is not a release of this repo)"
  echo '       (tag and publish that release before publishing a Feature that downloads from it)'
  return 1
}

if [ "$check_release_pins" -eq 1 ]; then
  echo
  echo 'every pinned devc-tools release exists'
  for dir in "${feature_dirs[@]}"; do
    tag="$(release_pin "$dir")"
    if [ -z "$tag" ]; then
      echo "  ok   $dir — pins no release (downloads nothing)"
      continue
    fi
    check "$dir — pinned release $tag exists" release_exists "$tag" "$dir"
  done
fi

# --- the publish allowlist ----------------------------------------------------------------
#
# features/PUBLISH_ALLOWLIST.txt is the gate that keeps a Feature under active development off
# ghcr.io: publish-feature.yml's matrix is built from this file, not from the tree walk
# above, so a Feature can pass every check in this script and still not publish until its id
# is added here. That is a static list, deliberately, unlike everything else in this
# collection — but it fails *safe* (an unlisted Feature just does not publish) rather than
# the way a static list failed before .plans/archived/features-collection.md (an uncovered
# Feature published unguarded), so it does not reopen that failure.
#
# What is checked here is narrower than "is this a good idea": only that every entry names a
# real Feature. A stale or misspelled id would otherwise sit in the file doing nothing,
# forever, with no signal — the same "which of the five?" problem the rest of this script
# exists to answer. Always runs, unscoped by --feature: the allowlist is a collection-wide
# document, not a per-Feature one.

allowlist_entries() { # prints one id per line; comments and blank lines stripped
  grep -vE '^[[:space:]]*(#|$)' "$1"
}

allowlist_names_real_feature() { # allowlist_names_real_feature <id>
  [ -f "features/$1/devcontainer-feature.json" ] && return 0
  echo "       (PUBLISH_ALLOWLIST lists '$1', which has no features/$1/devcontainer-feature.json)"
  return 1
}

ALLOWLIST=features/PUBLISH_ALLOWLIST.txt
echo
if [ ! -f "$ALLOWLIST" ]; then
  # Missing, not empty: an empty-but-present file is a valid "publish nothing right now"
  # state. Missing means the gate itself is gone, which would otherwise stop every Feature
  # from ever publishing again with no failure to say so.
  echo "  FAIL $ALLOWLIST is missing — the publish gate has nothing to check against"
  fails=$((fails + 1))
else
  echo "every $ALLOWLIST entry names a real Feature"
  while IFS= read -r id; do
    check "PUBLISH_ALLOWLIST — $id" allowlist_names_real_feature "$id"
  done < <(allowlist_entries "$ALLOWLIST")
fi

echo
if [ "$fails" -eq 0 ]; then echo 'ALL PASS'; else echo "$fails FAILED"; fi
exit "$((fails > 0))"
