# Releasing

## Quick steps

1. `bash scripts/bump-version.sh` — it shows the current version and prompts
   for the new one (`X.Y.Z`, or `X.Y.Z-rc.N` for a prerelease); or pass it as
   an argument.
2. **Only if publishing core:** `bash scripts/bump-core-version.sh <x.y.z>`
   (`bump-version.sh` says whether `devc-core/` changed since the last tag).
3. Review the diff, commit, push.
4. On the host: `bash scripts/preflight-core-publish.sh`
5. `git tag v<x.y.z> && git push origin v<x.y.z>` — never `git push --tags`.
6. Wait for [`release.yml`](../../.github/workflows/release.yml) to go green.
7. **Only if you did step 2:** `cd devc-core && npm publish --access public`

The rest of this page explains each step and why it is ordered this way.

## Details

**One version for both binaries, moving in lockstep.** A single `vX.Y.Z` tag
gates `devc` and `devc-bridge` together, because the installer fetches all eight
tarballs from one release and must not reason about compatible pairs. The tag is
the source of truth and nothing rewrites a version during the build — a tag that
disagrees with any hand-maintained version fails the workflow before anything is
compiled.

**The Features in `features/` are not part of that.** Each carries its own
`version` and publishes on its own cadence, from a push to `main` that touches
`features/` — a Feature is pulled from ghcr by a consumer's `devcontainer.json`,
not installed by `install.sh`, so a one-line fix to one ships without a binary
release and an untouched Feature never gets a new digest. Bump the `version` of
whatever Feature you changed, in the same commit; anything you do not bump simply
does not publish. See
[Publishing Features](publishing-features.md#versions).

One exception: `devc-config` is pinned at an exact version by
`devc-core/overlay.ts`'s `DEVC_CONFIG_FEATURE`, since devc injects it into every
container it starts. Bumping that Feature means bumping the pin in the same
commit — and only a devc release delivers it.

**A Feature also has to be on the allowlist to publish at all.**
[`features/PUBLISH_ALLOWLIST.txt`](../../features/PUBLISH_ALLOWLIST.txt) is what keeps a
Feature under active development off ghcr.io until it's ready — see
[The publish allowlist](publishing-features.md#the-publish-allowlist).

**`@devc-tools/core` is not published by any workflow.** Move its version with
[`scripts/bump-core-version.sh`](../../scripts/bump-core-version.sh)
(`bash scripts/bump-core-version.sh 0.5.0`), never a bare `npm version`: besides
`package.json` and `package-lock.json`, `devc/deno.lock` and
`devc-bridge/host/deno.lock` record core's version (Deno links `../devc-core/` as
an npm package), and the script refreshes and verifies both. It is a manual
`npm publish`, and `devc-core/package.json` has no `prepublishOnly` hook while
its `files` is `["dist"]` — so an unbuilt `dist/` publishes an empty package.

**Publishing core is optional for a release, and its version only moves when
you publish it.** The binaries compile `devc-core/` from source, so a release
whose core is unchanged — or changed but not worth publishing yet — leaves
`devc-core/package.json` alone, even though its version is already on npm.
`bump-version.sh` says whether `devc-core/` changed since the last tag.

Run [`scripts/preflight-core-publish.sh`](../../scripts/preflight-core-publish.sh)
**on the host** before tagging. It checks the same preconditions `release.yml`
would refuse a tag over and runs the guards below, and it works out from the
registry whether this release publishes core — there is nothing to pass:

- **Core's version is already on npm** → core is not being published. It skips
  the tarball, notes if `devc-core/` changed since the last tag (those changes
  then wait for a later core bump), and prints the tag step.
- **Core's version is not on npm** → core is being published. It builds and
  smoke-tests the real tarball (npm versions are immutable, so a broken one is
  found here, not after `npm publish`) and prints the tag, then the publish.

It never tags, pushes or publishes.

It does _not_ check that you are logged in to npm: `npm publish` says so
itself, and re-running costs nothing. Only what is expensive or unfixable when
found late is worth checking early.

**Push the one tag by name — `git push origin vX.Y.Z`, never `git push
--tags`.** This checkout carries local-only tags from other work that `--tags`
would push to the public remote.

**Tag before you `npm publish`.** The two are independent (`devc` imports
`devc-core` from source, not from the registry), so the only question is which
is recoverable: a tag and its release can be deleted and re-cut, an npm version
can never be republished. Let `release.yml` go green first.

To cut a release — these steps, in this order, are the whole process; a
script's closing "Next" lines and [Quick steps](#quick-steps) summarize them and
never add to them:

1. Bump the version in **all three binaries** — `VERSION` in `devc/help.ts`,
   `devc-bridge/host/version.ts` and `devc-bridge/client/version.ts`, plus
   `devc/deno.json`'s `"version"` — guarded by `release.yml` (the three `VERSION`
   consts) and by `preflight-core-publish.sh` (`devc/deno.json` matching them).
   [`scripts/bump-version.sh`](../../scripts/bump-version.sh) does all four in one
   step: `bash scripts/bump-version.sh 0.2.0`. Prereleases are no exception: to
   tag `v0.1.0-rc.1`, every one of those versions must be `0.1.0-rc.1`, so
   nothing claims a version its release does not have. Nothing under
   `features/` moves for a release; if a Feature pins a devc-tools release in
   its `install.sh` (`DEVC_TOOLS_RELEASE`, only `devc-bridge` today), pointing
   it at a newer one is a change to that Feature, with its own version bump, on
   its own schedule.
2. **Only if publishing core:** `bash scripts/bump-core-version.sh <x.y.z>`.
   Skip this when it is not being published — including when its version is
   already on npm.
3. Commit and push, then on the host: `bash scripts/preflight-core-publish.sh`.
4. `git tag v0.1.0 && git push origin v0.1.0`.
5. [`release.yml`](../../.github/workflows/release.yml) builds each of the eight
   archives on a runner of its own architecture, runs `--version` on what it
   built, writes `checksums.txt`, stamps the tag into `install.sh` and publishes.
   Assets are named `<tool>-<version>-<triple>.tar.gz` — the version sits in the
   middle so the assets group by tool on the release page (digits sort before
   letters, so `devc-bridge-*` cannot wedge into the middle of `devc-*`) and a
   downloaded archive says which version it is. `install.sh` and `checksums.txt`
   stay version-free: the former is served from `releases/latest/download/`, so
   its name cannot move. It publishes no Features —
   [`publish-feature.yml`](../../.github/workflows/publish-feature.yml) does that on a
   push to `main`, one job per Feature, to `ghcr.io/devc-tools/features/<id>`.
6. **Only if you did step 2**, once `release.yml` is green:
   `cd devc-core && npm publish --access public`.

**The macOS binaries are unsigned.** `release.yml` cross-compiles them on a
Linux runner. GitHub's macOS runners kept becoming unavailable to this repo,
and these two binaries were the only reason the pipeline needed macOS at all,
so there is no `codesign` step and no native run to check them against.

Neither workflow has ever run, and the release path crosses machines this repo
is not developed on. Before the first real tag, work through
[docs/manual-verification.md](manual-verification.md) — the checks that
need GitHub Actions, a Docker host or a Mac, ordered cheapest-and-most-
informative first.

A tag with a `-suffix` publishes as a prerelease, so
`releases/latest/download/install.sh` keeps pointing at the last stable one. To
exercise the whole matrix before tagging, run `release.yml` from the Actions tab
with `dry_run` — it builds and uploads everything as workflow artifacts without
creating a release.
