# `features/` as a real collection — publish more than one

## Goal

Make `features/` hold **many** Features instead of exactly one, before four new
ones arrive. Today every mechanism around it — the version guard, the test
wrapper, the README — names `devc-bridge` literally, so adding a second Feature
silently publishes it **unguarded**: `features publish ./features` walks the
whole directory, but the guard only checks `features/devc-bridge/`.

Nothing about the published `devc-bridge` artifact changes. This is the
scaffolding the `feature-*` plans land on.

### Why first

Four plans that each edit `.github/workflows/publish-feature.yml` to bolt on
another literal id is four chances to get the guard subtly wrong, and they are
implemented sequentially by cold agents. Generalize once; the feature plans then
only add directories.

## Existing touchpoints

- `.github/workflows/publish-feature.yml` — version guard hardcodes
  `features/devc-bridge/devcontainer-feature.json` and the `FEATURE_VERSION` in
  `features/devc-bridge/install.sh`. `Package` / `Publish` already operate on the
  collection (`./features`) and need no change.
- `tests/workflow_guards_test.sh` — asserts the publishing steps are gated on tag
  **and** `!inputs.dry_run`. Its closing comment explains why the version guard is
  deliberately tag-only. Extend, don't rewrite.
- `features/devc-bridge/test/run-features-test.sh` — stages a `src/<id>` +
  `test/<id>` collection layout in a tempdir because the repo keeps Features
  self-contained. Every new Feature needs the identical wrapper.
- `README.md` (repo root) — Releasing section, version rules.

## Contracts

### Version guard — one loop, every Feature

Replace the two hardcoded reads with a walk of `features/*/devcontainer-feature.json`.
For each Feature directory:

- `jq -r .version` must equal the tag minus its leading `v`.
- **If** the Feature's `install.sh` contains a line matching
  `^FEATURE_VERSION='(.*)'$`, that value must equal the manifest `version`.
  Absent is fine — only `devc-bridge` bakes its version, because only it names a
  release asset. A Feature that _does_ bake one must not be allowed to drift, and
  a Feature that does not must not be forced to invent one.
- `id` must equal the directory basename (`features package` requires it, and a
  mismatch is otherwise a confusing publish-time error).
- Fail with `::error::` naming **the Feature** — a message that says only
  "version mismatch" is useless once there are five.
- Exit non-zero if the glob matches nothing: an empty collection means someone
  moved the tree, and a silently passing guard is the failure mode this plan
  exists to prevent.

Keep the step tag-gated only (`if: startsWith(github.ref, 'refs/tags/v')`) — a
dry run against a tag should still check. `tests/workflow_guards_test.sh` already
documents that exemption; leave that comment true.

### Shared test wrapper

`features/<id>/test/run-features-test.sh` stays **per Feature** (a Feature
directory must be self-contained to publish), but all copies are the same file
except for the `cp` list. Two things this plan owns:

- `features/devc-bridge/test/run-features-test.sh` copies exactly
  `devcontainer-feature.json` and `install.sh`. New Features ship extra files
  (`scripts/*.sh`). Change the copy to `cp -R "$FEATURE_DIR"/. "$STAGE/src/$ID/"`
  followed by `rm -rf "$STAGE/src/$ID/test"`, so a Feature's whole directory
  minus its tests is staged — no per-Feature file list to keep in step.
- `features/README.md` (new) — what the collection is, the one-file-per-Feature
  layout, the `run-features-test.sh` convention, the version rule (**every**
  Feature carries the repo's version and moves with the repo tag), and a table of
  the published Features with their `ghcr.io/devc-tools/features/<id>` refs.

### Guard test

Extend `tests/workflow_guards_test.sh` with a section asserting the guard is
generic, not that it works (it runs in Actions, not here):

- the `Version guard` step's `run:` block contains **no** literal `devc-bridge`;
- it iterates `features/*/devcontainer-feature.json`;
- for every directory under `features/`, `id` equals the basename and `version`
  equals every other Feature's `version` — the "one repo, one version" rule,
  checkable offline and the thing most likely to rot.

## Concept boundaries

- **Collection vs Feature.** `features/` is the _collection_;
  `features/<id>/` is a _Feature_. `devcontainer features test` insists on
  `src/<id>` + `test/<id>` and `publish` insists on the flat layout — hence the
  staging wrapper. Do not "fix" the layout.
- `FEATURE_VERSION` in `devc-bridge/install.sh` names **the release asset to
  download**. It is not a general convention and new Features should not add one
  unless they fetch a release asset.

## Checklist

- [x] `.github/workflows/publish-feature.yml` — version guard loops over
      `features/*/devcontainer-feature.json`; per-Feature error messages; empty
      glob fails; `FEATURE_VERSION` checked only where present
- [x] `features/devc-bridge/test/run-features-test.sh` — stage the whole Feature
      directory minus `test/`
- [x] `features/README.md` — collection layout, version rule, published refs
      table, how to run a Feature's tests
- [x] `tests/workflow_guards_test.sh` — generic-guard + one-version assertions
- [x] `README.md` — Releasing section mentions that a tag moves every Feature in
      `features/`, not just the bridge (`docs/manual-verification.md` §3 said
      "all four" too, and was generalized with it)
- [x] `.plans/PLAN.md` — register

## Validation

- [x] `bash tests/workflow_guards_test.sh` passes — 10 checks, ALL PASS. Its two
      new sections were also confirmed to **fail** when they should: a guard
      edited back to `features/devc-bridge/devcontainer-feature.json` trips the
      "names no Feature literally" check, and a second Feature at a different
      `version` trips the one-version check
- [x] The guard's `run:` block, extracted and executed against this tree with
      `GITHUB_REF=refs/tags/v0.1.0`, passes; with `v9.9.9` it fails naming
      `devc-bridge` — the same extract-and-run technique
      `.plans/archived/release-and-installer.md` used for its workflow steps.
      Extracted through a real YAML parse (`jsr:@std/yaml`), so what ran is the
      shell in the file. Also run against synthetic collections: an empty
      `features/` fails, two Features (one with `FEATURE_VERSION`, one without)
      pass, and a tree with an `id`/directory mismatch, a stale version and a
      stale `FEATURE_VERSION` fails reporting **all three** with the offending
      directory in each message
- [ ] (needs Docker) `bash features/devc-bridge/test/run-features-test.sh` still
      passes with the widened staging copy — **not run, no Docker here.** What
      was checked is the staging itself, with a stub `DEVCONTAINER_CLI`: the
      tempdir gets `src/devc-bridge/{devcontainer-feature.json,install.sh,README.md}`
      and `test/devc-bridge/test.sh`, and no `src/devc-bridge/test/`
- [x] `deno fmt --check` clean — 118 files

## Not in this plan

- The four new Features. This plan must leave `features/` containing exactly
  `devc-bridge` and the published artifact byte-identical in behavior.
- **Any change to `on:`.** Publishing stays deliberately manual and
  tag-triggered: `push: tags: ['v*']` plus a `workflow_dispatch` whose `dry_run`
  defaults to true, with the publish steps gated on the tag **and**
  `!inputs.dry_run`. A merge to `main` publishes nothing today and must still
  publish nothing after this plan — do not add a `branches:` trigger, and do not
  relax either gate. Widening the guard's _coverage_ is this plan; widening what
  fires it is not.
