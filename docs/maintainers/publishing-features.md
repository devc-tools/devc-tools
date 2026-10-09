# Publishing Features (maintainers)

How Features in [`features/`](../../features/) get versioned and published to
`ghcr.io/devc-tools/features/*`. Building and testing a Feature is in
[features/CONTRIBUTING.md](../../features/CONTRIBUTING.md).

## Versions

**Every Feature versions itself.** The `version` in a `devcontainer-feature.json` is that
Feature's own, unrelated to the repo's `vX.Y.Z` tag and to the other Features. Two
Features at different versions is the normal state here, not drift. The binaries still
move in lockstep on one tag — see the
[release guide](releasing.md) — but a Feature is pulled from ghcr
by a consumer's `devcontainer.json`, not installed by `install.sh`, so nothing needs the
coupling. It only ever cost: a byte-identical Feature getting a new digest because some
unrelated tool changed, and a one-line Feature fix needing a full binary release.

The published tag tracks **each Feature's own** version line: `:0` while that Feature is
pre-1.0, `:1` at its first 1.x release.

**Bumping a version is what publishes.** A push to `main` touching `features/`
publishes each Feature from its own matrix job, so:

- to publish a Feature, bump its `version` in your own commit. Contributor PRs leave
  `version` alone, so merging one publishes nothing;
- leave it alone and the publish is a no-op. `devcontainer features publish` skips a
  version already in the registry, prints `Version X already exists, skipping`, and
  pushes nothing. So "I forgot to bump it" shows up as "nothing published" in the run
  that changed it, not silently at the next release.

A new Feature starts at `0.1.0`.

Adding a declared mount to a published Feature is new behavior every consumer gets
whether or not they ask for it — that is a version bump, not a silent edit.

## The publish allowlist

A Feature that reaches every guard still does not publish unless its id is listed in
[`PUBLISH_ALLOWLIST.txt`](../../features/PUBLISH_ALLOWLIST.txt), one id per line (`#` comments and blank
lines are ignored). This is the gate for a Feature under active development: add its
directory, get its manifest right, run its tests — it still sits invisible to ghcr.io
until you add it here. No half-finished Feature auto-publishes just because it touched
`main`.

It is deliberately the one static list in this collection. Everywhere else a Feature is
_discovered_ by walking `features/*/devcontainer-feature.json`, precisely so a guard can
never be left naming only the old Features. The allowlist does not reopen that failure:
leaving a Feature off it fails **safe** (it does not publish), where the old failure mode
failed **unsafe** (it published unguarded). `bash tests/features_test.sh` checks every
entry names a real Feature, so a stale or misspelled id is caught rather than silently
doing nothing forever.

It is **source-only**. `devcontainer features publish` packages one Feature's own
`features/<id>/` directory; `PUBLISH_ALLOWLIST.txt` lives at the collection root, outside
every Feature directory, so it is never part of a published artifact.

`publish-feature.yml`'s `discover` job builds its matrix from this file, and its
`collection-index` job stages a copy of only the allowlisted Feature directories before
republishing the collection index — both so a held-back Feature cannot appear in either
place.

### Publish status

Every Feature in the collection is currently allowlisted. Two caveats:

- **`devc-bridge` publishes only once its pinned release exists.** It pins
  `DEVC_TOOLS_RELEASE='v0.6.0'`; the guard runs `gh release view` on that tag, so a tag
  without a published GitHub release still fails it. Check with
  `bash tests/features_test.sh --check-release-pins` before assuming it will publish.
- **A newly created GHCR package is private.** Each has to be made public in the repo's
  Packages settings before an anonymous `devcontainer up` can pull it. Check the
  package's visibility before assuming a fresh publish is reachable.

Orphaned namespaces, referenced nowhere in this repo: everything under
`ghcr.io/bmingles/devc-tools/*` from before the org move, a short-lived
`ghcr.io/devc-tools/*` (no `features/` segment) from a run that published the Features
and then failed on the collection index, and `ghcr.io/devc-tools/features/project-hook`
from before `devc-config` was renamed.

When devc injects `devc-config` it is pinned at an **exact** version rather than `:0` — see
`devc-core/overlay.ts`'s `DEVC_CONFIG_FEATURE` — because that injection reaches every
container devc starts, with no opt-in anywhere. Bumping `devc-config`'s version therefore
means bumping that pin in the same commit, and shipping a devc release to deliver it;
`tests/workflow_guards_test.sh` asserts the two agree. A manual `"devc-config": {}` in your
own config still floats on `:0` like any other Feature here.

## The collection index package

`ghcr.io/devc-tools/features` — no trailing `/<id>` — is **not** a Feature and not an
image. It is a metadata-only OCI artifact holding one `devcontainer-collection.json`
layer that lists what is in this collection. `devcontainer features publish` pushes it on
every run and there is no flag to suppress it.

Because each Feature publishes from its own job, every one of those runs would otherwise
overwrite that document with a one-Feature view — so it would name whichever Feature
published last as the whole collection. The `collection-index` job repairs it: it runs
after the matrix, `needs: publish` so it is skipped unless **every** Feature published
cleanly, and re-publishes the whole collection. Every Feature is already at its current
version by then, so the CLI skips them all and only the index document is rewritten.

Nothing in this repo reads it — `devc` never resolves a Feature version, and
`devcontainer features info` goes through a Feature's own OCI annotations. It is kept
honest because it is visible on the repo's Packages page.

### Why the namespace is `<owner>/features`

That unconditional index push is also why `--namespace` cannot be the owner alone. The
CLI derives the index ref from the namespace with no `/<id>`, so
`--namespace devc-tools` would aim it at `ghcr.io/devc-tools` — a registry and an owner
with no package name, which GHCR rejects with `NAME_INVALID`. The CLI's own path
validation accepts a single segment, so nothing catches it until the registry does: every
Feature publishes successfully and _then_ the command fails.

`<owner>/features` keeps Features one segment shorter than `${{ github.repository }}`
would (`ghcr.io/devc-tools/features/<id>` rather than
`ghcr.io/devc-tools/devc-tools/<id>`) while still giving the index a valid home.
`tests/workflow_guards_test.sh` asserts no `--namespace` in the workflow is a single
segment.
