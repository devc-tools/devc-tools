# devc injects the `project-hook` Feature — the baseline reaches every container

## Goal

`devc up` contributes the published `project-hook` Feature to **whatever
`devcontainer.json` is in play**, so a project's `devc-post-create.sh` runs in
every container devc starts — including a project-mode repo whose
`.devcontainer/` devc does not write to and has never seen. The user configures
nothing.

This is also the **swap** for `project-hook`: `devc-core/default/scripts/project-hook.sh`
is deleted in the same change. It has to be. devc's baseline still runs its own
copy from `post-create.sh`, so injecting the Feature without retiring the copy
runs a project's hook **twice** — and a `devc-post-create.sh` is arbitrary and
need not be idempotent.

Depends on [feature-project-hook](feature-project-hook.md) being **published**. A
baseline referencing an unpublished `ghcr.io` ref breaks every `devc up` — the
failure [devc-bridge-feature](devc-bridge-feature.md) already had to
reverse once.

## Why this one is not a manual swap

The other Features in the split are opt-in: a consumer writes one line in their
own config, and devc's swap is deleting a script it no longer needs. This one
inverts that. The Feature is only interesting if it arrives **without being
asked for**, which means devc has to add it to configs it does not own — and
that raises four questions a manual swap never has to answer:

1. **Where the injection happens** and at what precedence, so a user who does
   declare it still wins.
2. **How a user turns it off**, since it now reaches repos that never opted in.
3. **How devc avoids installing it twice** when the in-play config already
   declares it — the pinned CLI dedupes `--additional-features` against
   `devcontainer.json`'s `features` by **exact id string**, so `…/project-hook:0`
   and `…/project-hook:0.1.0` both install rather than one overriding the other.
4. **What happens to lifecycle ordering**, because a Feature-declared
   `postCreateCommand` runs _before_ the one the config declares — which is not
   where devc runs the hook today.

## Existing touchpoints

- `devc-core/container.ts:674-740` (`startContainer`) — the single call site of
  `loadMergedOverlay`, `isEmptyOverlay` and `buildUpArgs`. The whole injection
  lands here.
- `devc-core/overlay.ts` — `DevcOverlay`, `OVERLAY_KEYS`, `emptyOverlay`,
  `mergeOverlays`, `isEmptyOverlay`, `overlayArgs`. Gains the baseline layer and
  a fourth overlay key.
- `devc-core/default_config.ts:524` (`declaresBridgeFeature`) — already matches a
  Feature by its id's last path segment with the tag stripped, precisely so
  `…/devc-bridge`, `:0`, `:0.1.0` and a local `./features/devc-bridge` all count.
  That is the matching this plan needs; generalize it rather than writing a
  second one.
- `devc-core/default_config.ts:710` (`loadResolvedRemoteEnv`) — the shape to
  copy for reading the in-play config: forgiving JSONC parse, degrade to "nothing
  declared" with a `logWarning` rather than throwing.
- `devc-core/default/devcontainer.json` — gains the Feature in `features`, and
  its `postCreateCommand` becomes `onCreateCommand` (see Ordering).
- `devc-core/default/post-create.sh` — the `project-hook.sh` line is removed.
- `devc-core/default/scripts/project-hook.sh` — **deleted**.
- `devc-core/default_config.ts:302-310` — the two `replaceAll` rewrites. Both
  match on the _value_, not the key, so renaming `postCreateCommand` to
  `onCreateCommand` needs no change here. Assert that rather than assuming it.
- `tests/workflow_guards_test.sh:117` (`pins_agree`) — the precedent for a
  pin-consistency guard, and the shape the new one copies.
- `devc/README.md:641-648` — the fence-harness list; devc's copy disappears from
  it and the Feature's stays.

## Contracts

### The pin

```ts
/** The `project-hook` Feature devc contributes to every container it starts. */
export const PROJECT_HOOK_FEATURE = 'ghcr.io/devc-tools/project-hook:0.1.0';
```

**Exact version, not the floating `:0`** — and this is a departure from the
bundled `devcontainer.json`, which uses `:0` for every Feature it lists. The
reason is the inversion above: those are opt-in and this one is forced on every
container devc starts, so a bad Feature publish would reach every user's next
build with no devc release and no opt-in anywhere. It is the same argument
`devc/deno.json` already makes for the devcontainer CLI itself — _"Pinned, not
ranged: this is the devcontainer CLI devc is, so an upgrade changes what a
released binary does."_ Bumping the Feature is then a devc release, deliberately.

Guarded, because a comment saying "keep these in step" is how pins drift: extend
`tests/workflow_guards_test.sh` with a check that the version in
`PROJECT_HOOK_FEATURE` equals `version` in
`features/project-hook/devcontainer-feature.json`.

### `devc-core/default_config.ts` — matching and reading declarations

```ts
/** True when `features` declares a Feature whose id names `name`, by any spelling. */
export function declaresFeatureNamed(
  features: Record<string, unknown>,
  name: string,
): boolean;

/** Ids in the `features` object of the devcontainer config at `configPath`. */
export function loadDeclaredFeatureIds(configPath: string): Promise<string[]>;
```

- `declaresFeatureNamed` is `declaresBridgeFeature`'s body with the literal
  `'devc-bridge'` lifted to a parameter. Keep `declaresBridgeFeature` exported as
  a one-line wrapper — it has its own call site and its own doc comment about why
  a Feature _named_ devc-bridge needs the token mount whoever published it.
- `loadDeclaredFeatureIds` mirrors `loadResolvedRemoteEnv` exactly: same JSONC
  parse with `allowTrailingComma`, same `logWarning`-and-continue on a config it
  cannot read. **A config that cannot be parsed returns `[]`** — "nothing
  declared", so devc injects. The alternative (skip injection when unsure) would
  silently withhold the baseline from anyone with an exotic config, which is the
  worse failure: the cost of being wrong here is a double-run for someone who
  both has an unparseable-to-devc config _and_ declares the Feature themselves.

### `devc-core/overlay.ts` — the fourth key and the baseline layer

`DevcOverlay` gains one field and `OVERLAY_KEYS` gains one entry:

```ts
export interface DevcOverlay {
  mounts: string[];
  additionalFeatures: Record<string, unknown>;
  remoteEnv: Record<string, string>;
  /** False disables every Feature devc contributes on its own. Default true. */
  baselineFeatures: boolean;
}
```

- `emptyOverlay()` returns `baselineFeatures: true`.
- **`mergeOverlays` is `user.baselineFeatures && project.baselineFeatures`** —
  opting out is a **veto**, and a project cannot re-enable what the user
  disabled. This is deliberately _not_ the "project wins" rule the other three
  keys follow, and the asymmetry has to be stated in the doc comment and in
  `devc/README.md`: the user-level file belongs to the machine's owner, and a
  repo talking a machine back into running devc's baseline is not a thing anyone
  asked for. Two-valued rather than tri-state on purpose — nothing needs to tell
  "unset" from "true", and a tri-state would put a `boolean | undefined` through
  a struct whose stated invariant is that every field is always present.
- A non-boolean value warns and is ignored, like every other malformed overlay
  field.
- **`isEmptyOverlay` does not consider it.** That predicate answers "would this
  overlay emit any `devcontainer up` args", and `baselineFeatures: false` emits
  none. Say so in its doc comment, or the next reader will "fix" it.

```ts
/**
 * `overlay` plus the Features devc contributes itself, added *under* whatever the
 * overlay already declares.
 */
export function withBaselineFeatures(
  overlay: DevcOverlay,
  declaredInConfig: readonly string[],
): DevcOverlay;
```

For each baseline Feature, it is skipped when **any** of these holds:

1. `overlay.baselineFeatures` is false;
2. `overlay.additionalFeatures` already declares a Feature of that name
   (`declaresFeatureNamed`);
3. `declaredInConfig` contains a Feature of that name.

Skipping on 2 and 3 — rather than letting the CLI's own merge sort it out — is
the whole point of matching by name instead of by exact id. The CLI dedupes
`--additional-features` against the config's `features` by **exact string**, so a
consumer who pins `…/project-hook:0.2.0` while devc injects `:0.1.0` would get
**both installed and the hook run twice**, not an override. Measured against the
pinned `@devcontainers/cli` 0.88.0.

Returns a new object; never mutates its argument.

### `devc-core/container.ts` — sequencing in `startContainer`

The order is a correctness requirement:

```ts
const overlay = await loadMergedOverlay(localFolder);
const ownConfig = await findOwnDevcontainerConfig(localFolder);
const configPath = ownConfig ?? await ensureDefaultConfig(/* … */);

// After the config exists — in the zero-config path it is materialized above.
const declared = await loadDeclaredFeatureIds(configPath);
const effective = withBaselineFeatures(overlay, declared);

// NOT `effective`. See below.
const containerWorkspaceFolder = isEmptyOverlay(overlay)
  ? ''
  : await computeContainerWorkspaceFolder(localFolder);

const args = buildUpArgs({
  /* … */ overlay: effective,
  containerWorkspaceFolder,
});
```

**The named trap: `isEmptyOverlay` is called on `overlay`, never on
`effective`.** After injection the overlay is never empty, so testing `effective`
makes that branch dead and every `up` — and every `devc exec`, which goes through
`startContainer` — pays for `computeContainerWorkspaceFolder`'s git subprocesses
forever. It is invisible when it regresses: nothing breaks, things just get
slower. The predicate must keep answering a question about **the user's**
overlay.

Nothing needs substituting for the injected entry: `overlayArgs` deliberately
does not substitute `additionalFeatures` (and, measured, the CLI does not either
— `additionalFeatures` reaches feature processing raw from argv while a config's
own `features` block rides the config's substitution pass). That is why the
injected value is `{}` and why this Feature has no options.

### `devc-core/default/` — the swap

- `devcontainer.json` `features` gains `"ghcr.io/devc-tools/project-hook:0.1.0": {}`.
  **Not redundant with the injection**, and this is the reason: the bundled
  config is also what `devc init` copies into a project, and
  `overlay.ts`'s governing invariant is that _whatever lands in `.devcontainer/`
  must run without `devc` installed at all_. Listing it there is what keeps a
  scaffolded project standalone; the injection is what covers configs devc did
  not write. The two never collide because `withBaselineFeatures` skips on
  rule 3.
- `post-create.sh` — the `project-hook.sh` line is removed. The remaining steps
  keep their order and their comments.
- `scripts/project-hook.sh` — deleted. `installBundledAssets` derives its chmod
  list from `readdir`, so nothing there names the file.
- The `Dockerfile` still `COPY`s `scripts/` for the remaining steps — unchanged.

### Ordering

A Feature-declared `postCreateCommand` runs **before** the config's own
(measured: the CLI collects lifecycle commands in metadata order, Features first,
config last). Today devc's baseline runs, in one `postCreateCommand`:

```
agents-setup → git-setup → project-hook → bashrc-additions
```

Naive injection would reorder that to `project-hook → agents-setup → git-setup →
bashrc-additions`, putting a project's hook **before** its git identity and
`~/.claude` are configured. A hook that runs `git` would misbehave, and the split
doc's own rule is that the swap should be _"a no-op in observable terms"_.

**The fix is one token:** the bundled `devcontainer.json`'s `postCreateCommand`
becomes `onCreateCommand`. `onCreate` runs before _every_ `postCreate`, Features
included, so devc's whole baseline precedes the hook again:

```
agents-setup → git-setup → bashrc-additions   (onCreate, devc's config)
project-hook                                   (postCreate, the Feature)
```

Both hooks run once per create, so nothing runs more or less often than before.
Two consequences to state rather than discover:

- **`bashrc-additions` now precedes the project hook** instead of following it —
  the one residual difference from today's interleaving. It only appends a
  marker-guarded block to `~/.bashrc`; a project hook that also writes there now
  lands after devc's block rather than before. If that turns out to matter, the
  fallback is splitting the orchestrator into `on-create.sh` (agents, git) and
  `post-create.sh` (bashrc), which restores the exact order at the cost of a
  second entry script and a second path rewrite. Do not do that pre-emptively.
- **`default_config.ts`'s rewrite is unaffected** — it `replaceAll`s the
  _value_ `${containerWorkspaceFolder}/.devcontainer/post-create.sh`, not the key.
  This is cheap to get wrong silently, so it gets its own test rather than a
  comment.

In project mode the hook now runs before the project's own
`postCreateCommand`. That is new behavior, not a regression — today the hook does
not run there at all.

## Concept boundaries

- **`baselineFeatures` (devc's own injected Features) vs `additionalFeatures`
  (the ones you ask for).** Adjacent keys in one file with opposite senses: one
  is a boolean that turns devc's contributions off, the other is a map that adds
  yours. Both doc comments must name the other.
- **The veto rule vs the project-wins rule.** `baselineFeatures` is the only
  overlay key where the user-level file can override the project. Anyone reading
  `mergeOverlays` will see three keys doing one thing and a fourth doing another;
  the comment must say why rather than looking like an oversight.
- **`declaresFeatureNamed` (name match, tag-insensitive) vs the CLI's own dedupe
  (exact id string).** They disagree on purpose, and devc's is deliberately the
  looser one — that gap _is_ the double-install this plan closes. Do not
  "simplify" it to an exact match.
- **Injection (`--additional-features`, for configs devc does not own) vs the
  bundled config's `features` entry (for the config devc writes).** Two delivery
  routes for one Feature, and both are needed: drop the first and project mode
  gets nothing, drop the second and `devc init` output stops working without devc
  installed.
- **This plan's deletion of `scripts/project-hook.sh` vs "copy, don't move".**
  That rule holds until a Feature is published; this plan is the point at which
  it is spent, for this Feature only. The other Features' copies stay.

## Checklist

- [x] `devc-core/default_config.ts` — `declaresFeatureNamed`,
      `declaresBridgeFeature` reduced to a wrapper, `loadDeclaredFeatureIds`
- [x] `devc-core/overlay.ts` — `baselineFeatures` in `DevcOverlay`,
      `OVERLAY_KEYS`, `emptyOverlay`, the veto in `mergeOverlays`, validation and
      warning for a non-boolean; `PROJECT_HOOK_FEATURE`; `withBaselineFeatures`;
      the `isEmptyOverlay` doc note
- [x] `devc-core/container.ts` — the sequencing above, with the `isEmptyOverlay`
      trap commented at the call site
- [x] `devc-core/default/devcontainer.json` — the Feature in `features`;
      `postCreateCommand` → `onCreateCommand`
- [x] `devc-core/default/post-create.sh` — drop the `project-hook.sh` line
- [x] `devc-core/default/scripts/project-hook.sh` — delete
- [x] `devc-core/tests/overlay_test.ts` — the new key and `withBaselineFeatures`
- [x] `devc-core/tests/up_args_test.ts` — the emitted `--additional-features`
- [x] `devc-core/tests/default_config_test.ts` — the bundled config's new
      `features` entry, the `onCreateCommand` rename, the rewrite still matching
- [x] `tests/workflow_guards_test.sh` — the pin guard
- [x] `devc/README.md` — how the hook now arrives, the `baselineFeatures` key and
      its veto rule, the ordering note; drop devc's copy from the harness list
- [x] `features/project-hook/README.md` — replace the "do not enable this in a
      devc container" warning with "devc includes this automatically; declaring
      it yourself replaces devc's entry"
- [x] `features/README.md` — note that devc contributes this one by default
- [x] `docs/manual-verification.md` — a project-mode scenario
- [x] `.plans/PLAN.md` — register, and move
      [feature-project-hook](feature-project-hook.md) to Completed if it is not
      already

## Validation

- [x] `cd devc-core && deno task check && deno task test` — green, with new cases
      covering: the baseline is added under a user's `additionalFeatures`; a user
      entry named `project-hook` at **any** tag suppresses devc's, and only one
      entry survives; a `features` entry in the in-play config suppresses it too;
      `baselineFeatures: false` at user level suppresses it even when the project
      says true; a non-boolean warns and is ignored; `withBaselineFeatures` does
      not mutate its argument. (242 passed, 0 new failures — 3 pre-existing
      `node-setup.sh` failures unrelated to this plan, confirmed via `git stash`
      against `main`.)
- [x] `cd devc && deno task check && deno task test` — green (91 passed).
- [x] **The `isEmptyOverlay` trap has its own test**, the way `finalDir` does in
      `ensureDefaultConfig`: with no `devc.json` anywhere, `startContainer` must
      not call `computeContainerWorkspaceFolder`. Reverting the call site to
      `isEmptyOverlay(effective)` must make exactly that test fail — a test that
      does not fail when the trap is reintroduced has not earned its place.
      `devc-core/tests/start_container_trap_test.ts`, added — a fake
      `DevcontainerRunner` plus a fake `git` on PATH that logs its args, in
      **project mode** (zero-config can't distinguish the two call sites, since
      the bundled config already declares project-hook itself, so injection is a
      no-op there — see the test's own comment). Confirmed both ways: passes
      against the fix, fails naming the unwanted `--show-cdup` invocation when
      the call site is reverted to `isEmptyOverlay(effectiveOverlay)`.
- [x] `bash devc/tests/project_hook_test.sh features/project-hook/post-create.sh`
      — still green, now the only copy of the block. (8 cases, all ok.)
- [x] `bash tests/workflow_guards_test.sh` — the new pin guard fails when the
      Feature's `version` and `PROJECT_HOOK_FEATURE` disagree. Confirmed with a
      deliberate break (bumped the overlay.ts pin to 0.2.0 while the manifest
      stayed 0.1.0) — the guard named both values and failed; restored, ALL PASS.
- [x] `bash tests/features_test.sh` — green.
- [ ] (needs Docker) **Project mode, the case this whole plan exists for**: a
      repo with its own `.devcontainer/devcontainer.json` that has never heard of
      devc, plus an executable `.devc/devc-post-create.sh`. `devc up` runs it.
      The project's `.devcontainer/` is byte-identical afterwards.
- [ ] (needs Docker) **Zero-config**: the hook still runs, exactly once. Verify by
      having it append rather than touch, so a double-run is visible.
- [ ] (needs Docker) **Ordering**: a hook that records `git config --get
      user.email` and whether `~/.claude` exists sees both already set up —
      proving `onCreate` really precedes the Feature's `postCreate`.
- [ ] (needs Docker) **The double-install case**: a project declaring
      `…/project-hook:0.2.0` in its own `features` while devc pins `:0.1.0`. The
      hook runs **once**, and `devcontainer up`'s output installs one
      project-hook. Removing rule 3 from `withBaselineFeatures` must make this
      fail — it is the only test that proves the exact-string dedupe finding was
      real.
- [ ] (needs Docker) `baselineFeatures: false` — the hook does not run, and no
      `--additional-features` arg is emitted for it.
- [ ] (needs Docker) **`devc init` output runs without devc**: scaffold a
      project, then bring it up with a plain `devcontainer up` and confirm the
      hook still runs. This is the invariant the bundled `features` entry exists
      to protect.
- [x] `deno fmt --check` clean (167 files).

## Open questions to measure, not assume

1. **Does an existing container pick this up?** `devcontainer up` finds a
   running container by label and reuses it; whether a merged config that gained
   a Feature forces a recreate is unverified. If it does not, the first `up`
   after upgrading devc leaves existing containers without the baseline until a
   `devc up --rebuild`, and that is a README line, not a bug. Measure before
   writing that line either way.
2. **Rebuild churn on first upgrade.** Every project's image gains a Feature
   layer, so the first build after this lands is longer. Confirm it is a one-time
   cost and that the content-addressed zero-config cache
   (`ensureDefaultConfig`) settles on a new key rather than thrashing.
3. **Offline builds.** A project-mode repo whose `devcontainer.json` declares no
   Features today gains a ghcr.io pull at **build** time. Confirm a cached image
   does not re-pull, and note in the README that `baselineFeatures: false` is the
   escape hatch for an air-gapped build.

## Not in this plan

- **Any other Feature.** `bash-config`, `shell-dirs`, `node-nvmrc`,
  `git-container-config` and `agents` are swapped by hand, separately.
  `withBaselineFeatures` takes a list so a later plan can add to it, but it has
  exactly one entry here.
- **Per-Feature opt-out.** `baselineFeatures` is a boolean covering everything
  devc injects. If the list ever grows past one and someone needs to disable just
  one of them, that is a shape change (`false | string[]`) made then, with a real
  case in hand.
- **A `projectDir` option** on the Feature — see
  [feature-project-hook](feature-project-hook.md)'s reasoning; devc could not set
  it through `--additional-features` anyway.
- **Splitting `post-create.sh` into two orchestrators.** Named above as the
  fallback if `bashrc-additions` preceding the project hook turns out to matter.
  It is not speculative work to do now.
- **Retiring `devc-core/default/scripts/` entirely.** The other three steps stay
  exactly where they are.

## Superseded — two decisions reversed on user review, before landing on `main`

Read the Contracts section above and the `devc-core/default/` — the swap
subsection as history on two points.

**"The bundled `devcontainer.json` also declares the Feature directly" is
reversed.** The plan's own contract said listing it there too was "not
redundant with the injection" — the reasoning being that the bundled config is
also what `devc init` copies into a project, and `overlay.ts`'s governing
invariant is that whatever lands in `.devcontainer/` must run without `devc`
installed at all. That argument treated this Feature the same as every other
one this repo bundles — Node, Python, git-lfs, `bash-config` — each of which
does something useful for _any_ devcontainer project, standalone. This
Feature does not: what it runs is a `devc-post-create.sh` a project committed
specifically for _devc's own_ convention, so it is fine — deliberately — for
that one case to be devc-specific too. The bundled config now declares
**nothing** for this Feature; `--additional-features` injection at `devc up`
time is the only delivery route, and a `devc init`-scaffolded project run
later with `devc` uninstalled no longer runs the hook. `withBaselineFeatures`
and its "declared in config" skip rule are unaffected — that rule still
matters for a project's _own_ hand-written `devcontainer.json`, which is a
different config from the one this reversal is about.

**The Feature is renamed `project-hook` → `devc-config`.** Same treatment
this collection already gave `agents` twice (see
[feature-claude-config](feature-claude-config.md)): directory, manifest
`id`/`name`, the `SHARE_DIR` namespace
(`/usr/local/share/devc-features/devc-config/`), the fence marker
(`devc:project-hook` → `devc:devc-config`), the pin constant in `overlay.ts`
(`PROJECT_HOOK_FEATURE` → `DEVC_CONFIG_FEATURE`), the shared test harness
(`devc/tests/project_hook_test.sh` → `devc_config_test.sh`), and every doc
reference moved together in the same commit. Unlike `agents`' renames, this
one happened _after_ the old id had already been published to ghcr.io — those
tags are orphaned rather than un-published, since nothing can retract an OCI
tag, but nothing in this repo references them any more.

Both corrections are folded into the same completed entry in `.plans/PLAN.md`
rather than treated as a separate plan — nothing had shipped to a user under
either the old design or the old name.
