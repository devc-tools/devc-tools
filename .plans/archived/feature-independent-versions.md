# Features version independently — unpin the collection from the repo tag

## Goal

Stop publishing every devcontainer Feature on every `v*` tag at the repo's
version. Each Feature carries **its own** `version`, bumped when that Feature
changes, and `publish-feature.yml` runs on pushes to `main` that touch
`features/`. The devcontainers CLI already skips a version it finds in the
registry, so a run that changes nothing publishes nothing.

This **reverses a stated decision**: `design/devc-feature-split.md`'s "One repo,
one tag" bullet, and the one-repo-one-version section of `features/README.md`.

## Why

Decision 8 of [release-and-installer](archived/release-and-installer.md) — the
decision `publish-feature.yml` cites — is about the **installer**:

> A single tag `vX.Y.Z` gates **both tools**... Per-tool tags (`devc/v0.2.0`)
> would make **the installer** resolve two versions and reason about compatible
> pairs, for a **two-tool repo that installs as one thing**.

That argument is about the eight tarballs `install.sh` fetches from one release.
Features are not installed by `install.sh`; they are pulled from ghcr by a
consumer's `devcontainer.json`. `devc-feature-split.md` extended the rule to them
by analogy — "the same rule the binaries follow" — not by argument.

Nothing in the repo requires the coupling. `devc/default_config.ts:289` detects
devc-bridge **by Feature name at any tag**, and
`devc/tests/default_config_test.ts:857-860` pins that bare, `:0`, `:1` and
`:0.1.0` all match. devc never resolves a Feature version.

What the coupling costs:

- **Churn.** Every repo tag bumps every Feature, so every Feature always
  publishes. A byte-identical `node-nvmrc` gets a new digest because `devc`'s
  tmux handling changed, and every consumer on `:0` pulls it on their next
  rebuild.
- **The semver tags mislead.** When devc goes 0.2.0, `node-nvmrc:0.1` freezes
  forever and `:0.2` appears advertising a change that did not happen. Anyone
  pinned to `:0.1` silently stops receiving fixes.
- **Bidirectional release coupling.** A one-line fix in a Feature's `install.sh`
  needs a full repo tag: four-runner matrix, eight assets, a GitHub release. And
  the rule forbids shipping that fix without republishing binaries.

**Nothing has been published yet.** Neither workflow has ever run
(`README.md:119`), so there is no migration: both Features keep `0.1.0` and
simply stop moving in lockstep from here.

## Measured, not assumed

`@devcontainers/cli@0.88.0`, `dist/spec-node/devContainersSpecCLI.js` — the
tag-computation function returns early when the version being published is
already in the registry's tag list:

```
if (e.includes(A)) { t.write(`(!) WARNING: Version ${A} already exists, skipping ${A}...`, 4); return; }
```

and the `major` / `major.minor` / `latest` tags only move forward when the new
version is the max satisfying one (`semver.maxSatisfying` + `semver.compare`).
So publish-on-push is idempotent, and floating tags stay correct if versions ever
land out of order. **This is the load-bearing behavior of the whole plan** — if a
future CLI drops it, publish-on-push becomes republish-on-push.

Two further reads from the same source, both of which decision 6 depends on:

- **`publish` accepts a single Feature directory, not only a collection.** The
  publish command calls the same packaging entry point as `package`, which
  branches on `isSingle` — true when `devcontainer-feature.json` sits directly in
  the target folder — and then publishes each packaged Feature to
  `${registry}/${namespace}/${id}`. So `features publish ./features/node-nvmrc
  --namespace devc-tools` lands on **the identical ref** the collection
  publish would produce, `ghcr.io/devc-tools/node-nvmrc`. Nothing about
  the published artifact changes; only what one invocation covers.
- **Every run also pushes the collection document.** After the per-Feature loop,
  publish unconditionally pushes `devcontainer-collection.json` to
  `${registry}/${namespace}`, built from whatever was packaged in that run — the
  consequence decision 6 records.

## Existing touchpoints

- `.github/workflows/publish-feature.yml` — rewritten. The 40-line inline version
  guard (lines 44–96) is the bulk of what goes.
- `tests/workflow_guards_test.sh` — `step_run` (46–54), the three guard-scraping
  checks (110–131) and the shared-version assertion (160–167) all go; the
  `guards_both` dry-run/ref gating checks stay and are generalized.
- `features/devc-bridge/install.sh:26-30,44-47` — `FEATURE_VERSION` is renamed
  and its meaning made explicit.
- `features/devc-bridge/test/install_download_test.sh:45-46` — reads that name.
- `features/devc-bridge/README.md:133` and its options table (line 68).
- `features/devc-bridge/devcontainer-feature.json` — `clientVersion` description.
- `features/README.md` — the "Versions" section.
- `README.md:81-118` — the "Releasing" section.
- `docs/manual-verification.md` — §1 dry-run expectations (line 74), §3's
  strict-equality list (114–126) and publish step (137).
- `.plans/design/devc-feature-split.md:155-157` — the reversed bullet.
- The three pending Feature plans — see "Pending plans" below.

## Concept boundaries

- **`DEVC_TOOLS_RELEASE` is not a Feature version.** It names the devc-tools
  release a Feature downloads an asset from. Today `FEATURE_VERSION` does both
  jobs only because the two are forced equal; once they can differ, the name has
  to say which one it is. `features/devc-bridge/install.sh:41-47` already carries
  a comment explaining why the option is `CLIENT_VERSION` and not `VERSION` —
  extend that reasoning, do not contradict it.
- **The repo still has one binary version.** `release.yml`'s guard over the three
  `VERSION` consts is unchanged and decision 8 still stands for the binaries.
  Only Features are unpinned.
- **`version` in a `devcontainer-feature.json` is now per-Feature.** Two Features
  at different versions in the same collection is the normal state, not drift.

## Contracts

### `.github/workflows/publish-feature.yml`

```yaml
on:
  push:
    branches: [main]
    paths:
      - 'features/**'
      - '.github/workflows/publish-feature.yml'
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Package and validate only — do not publish'
        type: boolean
        default: true

permissions:
  contents: read
  packages: write
```

**Two jobs. One Feature per publish job — Features must not be able to block each
other.**

**`discover`** — checkout, then:

1. **Collection guard** — `bash tests/features_test.sh`. Offline, whole
   collection, ungated: a dry run must still check.
2. **Matrix** — emit a JSON array of Feature ids by walking
   `features/*/devcontainer-feature.json`, as a step output. **Derived, never
   spelled out** — a static list would reintroduce the exact failure
   [features-collection](archived/features-collection.md) removed, where the next
   Feature added is silently not covered. Fails when the array is empty.

**`publish`** — `needs: discover`, with

```yaml
strategy:
  fail-fast: false
  matrix:
    feature: ${{ fromJSON(needs.discover.outputs.features) }}
```

`fail-fast: false` is load-bearing, not hygiene: it is what stops one Feature's
guard failure from cancelling the others. Steps:

1. `actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0`
2. **Release pin guard** — `bash tests/features_test.sh --check-release-pins
   --feature "${{ matrix.feature }}"`, with `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.
   Ungated.
3. **Package** — `npx --yes @devcontainers/cli@<pinned> features package
   ./features/${{ matrix.feature }} --force-clean-output-folder --output-folder
   ./dist/features`
4. **Log in to ghcr.io** — plain `docker login`, as today.
5. **Publish** — `features publish ./features/${{ matrix.feature }} --namespace
   "${{ github.repository }}"`

Steps 4 and 5 are gated on
`${{ github.ref == 'refs/heads/main' && !inputs.dry_run }}`. Both conditions, for
the reason `tests/workflow_guards_test.sh`'s header already gives: a dispatch can
target a ref, so gating on the ref alone publishes from a run whose own checkbox
said not to.

**Pin the CLI version.** `@latest` in a release pipeline is out of step with a
repo that SHA-pins every action and pins `DENO_VERSION`. Pin to the version the
plan's measurement above was made against, and note in a comment that the
already-published skip is what makes publish-on-push safe.

### `tests/features_test.sh` (new)

Offline by default; one network-touching check behind a flag. Walks
`features/*/devcontainer-feature.json` — **never names a Feature** — and reports
every offender before exiting non-zero, keeping the property
[features-collection](archived/features-collection.md) established. Fails on an
empty glob.

Per Feature:

- `id` equals the directory basename (`features package` names the artifact from
  it; a mismatch surfaces as a baffling packaging error).
- `version` parses as semver.
- `name` and `description` are non-empty (`features package` refuses the Feature
  otherwise, and the failure is far from the cause).

Two flags:

- `--feature <id>` narrows every check to one Feature, which is what lets the
  publish matrix run a per-Feature guard. The default remains the whole
  collection, so a local run with no arguments checks everything.
- `--check-release-pins` adds the one network-touching check: for each
  `install.sh` in scope containing a `DEVC_TOOLS_RELEASE='<tag>'` assignment,
  `gh release view "<tag>"` must succeed. This is the guard the tag trigger was
  accidentally providing — publishing from `main` otherwise lets a Feature ship
  pinned to a release that has not been tagged yet. A Feature with no such
  assignment passes trivially; **absent is normal**, and only `devc-bridge` has
  one.

**What it deliberately does not check:** that a Feature's version was bumped when
its files changed. The registry already answers that — an unbumped Feature simply
does not publish, and the run says so.

### `features/devc-bridge/install.sh`

```sh
# The devc-tools release this Feature downloads its client from. NOT this Feature's own
# version — the two are independent (see .plans/archived/feature-independent-versions.md). Pinned
# deliberately: bumping it is a Feature change, and ships a client that has been tested
# with this install.sh. Duplicated from nothing — the manifest is JSON and no `jq` is
# guaranteed in an arbitrary base image.
DEVC_TOOLS_RELEASE='v0.1.0'
```

and at line 45, `[ -n "$CLIENT_VERSION" ] || CLIENT_VERSION="$DEVC_TOOLS_RELEASE"`.
The `v` prefix is fine and preferred — it names a tag, and line 47 already strips
it (`BARE_VERSION="${CLIENT_VERSION#v}"`).

The `clientVersion` option's description in `devcontainer-feature.json` must stop
saying "the version this Feature was published with" and say it defaults to the
devc-tools release this Feature pins.

## Decisions

1. **Publish on push to `main` under `features/`, not on a tag.** A Feature fix
   ships without a binary release, which is the point. The already-published skip
   makes it idempotent, and "you forgot to bump the version" surfaces immediately
   as "nothing published" rather than silently at the next release.
2. **Keep `dry_run` and the two-condition gate.** The mechanism is unchanged;
   only the ref it checks moves from `refs/tags/v*` to `refs/heads/main`. The
   packaging is still worth exercising from a dispatch before a push lands.
3. **The guard moves out of YAML into `tests/features_test.sh`.** Not just for
   size: the guard being inlined is _why_ `workflow_guards_test.sh` grew an `awk`
   function that scrapes a `run:` block out of the YAML by indentation and then
   asserts the extracted bash iterates a glob and mentions no Feature id. That
   tests the shape of a string because the thing itself is not callable. A script
   is callable, and — unlike today — runnable **before** you push.
4. **`guards_both` survives, generalized to take the expected ref expression.**
   Whether a publish step is gated on both the ref and `!inputs.dry_run` can only
   be read off the YAML, and it guards the one mistake here that cannot be walked
   back. That check is not the over-engineered part; the scrapers around it were.
5. **Both Features stay at `0.1.0`.** Nothing is published, so there is no
   migration and no version to skip past. `devc-bridge`'s
   `DEVC_TOOLS_RELEASE='v0.1.0'` points at the first binary release, which must
   exist before the Feature is published — hence the pin guard.
6. **One publish job per Feature, so no Feature can block another.**
   `features publish ./features` takes the collection as a unit: one failing
   guard fails the run, and `node-nvmrc` — which downloads nothing and pins no
   release — could not publish until `v0.1.0` was tagged. That is the exact
   coupling this plan exists to remove, reappearing in CI, so it is fixed rather
   than accepted. The publish job is a matrix over the discovered ids with
   `fail-fast: false`, each job packaging and publishing **its own Feature
   directory**. `node-nvmrc` publishes with no devc release tagged and no
   devc-bridge involvement; devc-bridge's job goes red on its unmet pin until
   `v0.1.0` exists, which is the guard doing its job rather than a blocker.

   **The one cost, recorded rather than hidden:** `features publish` also pushes
   a `devcontainer-collection.json` to `ghcr.io/<namespace>` at the end of every
   run, and in single-Feature mode that document describes only the Feature just
   published — so the last matrix job to finish leaves a collection artifact
   listing one Feature instead of all of them. Accepted, because nothing here
   reads it: `devc` never resolves a Feature version at all, and
   `devcontainer features info` resolves a Feature through its own
   `dev.containers.metadata` OCI annotation. The collection document is for the
   community index, which this repo is not in. If it ever matters, the fix is a
   final job running the whole-collection publish after the matrix — by then
   every Feature is already published, so the CLI skips them all and only the
   collection document is rewritten. **Do not add that job speculatively.**

   **Superseded after the first real publish — this paragraph was wrong twice.**
   The `collection-index` job now exists in `publish-feature.yml`. Both errors
   are worth keeping on the record:

   1. **"Nothing reads it" was true of tooling and false of people.** The
      artifact is listed on the repo's Packages page as
      `ghcr.io/devc-tools`, and it was found there and had to be
      explained. Being decorative to `devc` is not the same as being invisible.
   2. **"Stale" understated it — it _alternates_.** Whichever Feature published
      last becomes the entire collection according to the document. It was
      measured after the first publish: one layer, 2001 bytes, listing only
      `node-nvmrc`. Once `devc-bridge` publishes, its run would overwrite the
      same document to list only `devc-bridge`. Wrong-and-alternating is a worse
      resting state than wrong-and-fixed.

   The fix as sketched above also had a hole: an unconditional final job runs a
   **whole-collection** publish, which would push a Feature whose release pin the
   matrix had just rejected — defeating the pin guard. `needs: publish` closes
   it, because a job whose needs did not all succeed is skipped. So the repair
   runs only when every Feature published cleanly, and while `devc-bridge` is
   red the index simply keeps its previous value.
7. **No `generate-docs`, no documentation PR.** The starter's step emits a fixed
   `| Options Id | Description | Type | Default Value |` table from the manifest,
   using each `description` verbatim; this repo's manifest descriptions are
   multi-sentence paragraphs while `devc-bridge/README.md:68` and
   `node-nvmrc/README.md:86` carry deliberately condensed hand-written tables. The
   generated output would be worse. The flow is also backwards here: it commits
   docs _after_ publishing, so the README in the published artifact is
   permanently one release behind, and it needs `contents: write` +
   `pull-requests: write` on a workflow that gets by with `contents: read`.

## Pending plans

All three inherit the rule this plan reverses, and each specifies
`"version": "<repo version>"` in its manifest contract. Each becomes `"0.1.0"` —
the Feature's own starting version — with a one-line note that Feature versions
are independent of the repo tag.

- `.plans/feature-shell-dirs.md:47`
- `.plans/feature-git-config.md:45`
- `.plans/feature-claude-config.md:52`

None of them touches `publish-feature.yml` (PLAN.md:38 — "each of the three below
only adds a directory"), and that stays true. **This plan should land before
them**, so a new Feature joins at its own version rather than at the repo's and
then needing a correction.

`design/devc-feature-split.md`'s "One repo, one tag" bullet is marked superseded
with a pointer here, rather than deleted — the three plans read that document
first, and a silently changed rule is worse than a marked one.

## Checklist

- [x] `tests/features_test.sh` — new, per the contract above
- [x] `.github/workflows/publish-feature.yml` — rewritten; version guard gone,
      trigger moved, CLI pinned, `discover` + per-Feature `publish` matrix
- [x] `tests/workflow_guards_test.sh` — scrapers and version assertions removed,
      `guards_both` parameterized on the expected ref expression
- [x] `features/devc-bridge/install.sh` — `FEATURE_VERSION` → `DEVC_TOOLS_RELEASE`
- [x] `features/devc-bridge/test/install_download_test.sh` — reads the new name
- [x] `features/devc-bridge/devcontainer-feature.json` — `clientVersion`
      description
- [x] `features/devc-bridge/README.md` — the version note at line 133 and the
      options table
- [x] `features/README.md` — "Versions" section rewritten: per-Feature versions,
      bump-what-you-change, the release pin, the publish trigger
- [x] `README.md` — "Releasing" section: step 1 stops listing Feature versions,
      and a short paragraph says Features publish on their own cadence
- [x] `docs/manual-verification.md` — §1 and §3 stop asserting tag == every
      Feature version; §3 gains a Feature publish check off a `main` push
- [x] `.plans/design/devc-feature-split.md` — bullet marked superseded
- [x] `.plans/feature-shell-dirs.md`, `.plans/feature-git-config.md`,
      `.plans/feature-claude-config.md` — `<repo version>` → `0.1.0`
- [x] `.plans/PLAN.md` — register

## Validation

- [x] `bash tests/features_test.sh` — passes on this tree; fails when a manifest
      `id` is edited away from its directory, when a `version` is not semver, and
      on an empty `features/` (synthesized in a temp collection, as
      [features-collection](archived/features-collection.md) did)
- [x] `bash tests/features_test.sh --check-release-pins` with `gh` stubbed on
      PATH: passes when the stub reports the release exists, fails naming the
      Feature and the tag when it does not
- [x] `bash tests/features_test.sh --feature node-nvmrc --check-release-pins`
      with a `gh` stub that reports **every** release missing — **must pass**,
      because `node-nvmrc` pins none. This is the check that proves decision 6:
      devc-bridge's unmet pin cannot reach `node-nvmrc`'s job
- [x] `bash tests/features_test.sh --feature no-such-feature` fails rather than
      passing vacuously
- [x] `bash tests/workflow_guards_test.sh` — passes; and fails when the `Publish`
      step's `if:` is edited to drop either condition
- [x] `publish-feature.yml` parses as YAML and its `run:` steps, extracted from
      the parse, execute against this tree — the same technique
      [features-collection](archived/features-collection.md) used
- [x] `bash features/devc-bridge/test/install_download_test.sh` — passes against
      the renamed constant
- [x] Each Feature packages **on its own**: `npx @devcontainers/cli@<pinned>
      features package ./features/<id> --force-clean-output-folder
      --output-folder /tmp/f` for both ids, each producing one `.tgz` named for
      that Feature. Confirms the single-Feature mode decision 6 rests on
- [x] The matrix expression the `discover` job emits is valid JSON, contains both
      current ids, and is derived from the glob — verified by adding a throwaway
      `features/<id>/` and seeing it appear without editing the workflow
- [x] `deno fmt --check` clean
- [ ] (needs Actions) A `workflow_dispatch` **dry run** from `main`: the
      `node-nvmrc` matrix job is **green** while `devc-bridge`'s fails on its
      unmet pin naming `v0.1.0`, and `fail-fast: false` leaves the green one
      green. This is the acceptance test for decision 6
- [ ] (needs Actions) A real publish of `node-nvmrc` **with no devc release
      tagged**, then a second run with no change: the second must report
      `Version 0.1.0 already exists, skipping` and push nothing

## Not in this plan

- Any change to `release.yml` or to the binaries' one-version rule. Decision 8
  stands for what it was written about.
- A check that a Feature's README options table matches its manifest options.
  Genuinely cheap (~10 lines in `tests/features_test.sh`) and more useful once
  the collection is five Features, but it is a new assertion rather than a
  relocated one, and this plan is already reversing a decision. Separate plan.
- Republishing or retagging anything. Nothing is published yet.
- Feature-level changelogs.
