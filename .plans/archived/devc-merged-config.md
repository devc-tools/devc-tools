# Merged effective config: one `devcontainer.json` instead of `devcontainer up` flags

Status: **✅ implemented.** Every decision below is settled; the checklist and
validation sections record what was actually done.

**No backward compatibility is required.** Existing containers, the whole of
`~/.cache/devc/`, and hand-written `devc.json` files may all be discarded or
hand-edited by their owner. Wherever compatibility would have been the only
reason for a migration path, an alias, or a fallback, take the simpler
implementation and delete the old one.

## What this changes

`devc.json` is translated into `devcontainer up` flags today — `--mount`,
`--remote-env`, `--additional-features`. That is what caps the overlay at four
keys, forbids `readonly`, forbids removing or replacing anything the base config
says, and forces devc to reimplement the CLI's own variable substitution and
worktree path algorithm.

Instead: **merge the layers into one effective `devcontainer.json`, write it to
a per-project file under `~/.cache/devc/`, and hand that to the CLI.** Nothing is
written into the project, and nothing is deleted afterwards.

## Decisions

Settled. Do not re-litigate these while implementing; if one turns out to be
wrong, say so and stop rather than quietly picking the other branch.

| # | Decision                                                                                                                                                              | Why                                                                                                                                                                                                                                                              |
| - | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | Merged config lives at `~/.cache/devc/projects/<basename>-<hash8>/devcontainer.json`, one stable path per project                                                     | Never inside the project: a generated file in a git worktree is also a file in a Docker build context, and a delete step races concurrent devc processes. The path must be stable or containers get stranded (finding 4)                                         |
| 2 | Project mode delivers it with `--override-config`; zero-config with `--config`                                                                                        | `--override-config` keeps `configFilePath` — and with it relative paths and both identity labels — anchored to the project's own config (finding 3). Zero-config has no project config to anchor to, so `--config` is used and the two path keys are absolutized |
| 3 | Merge is: objects recurse per key, arrays append, `mounts` dedupe by target (highest wins), `null` deletes, top-level `"$replace": ["key"]` opts a key out of merging | Append is what the overlay is for; target-dedupe is what turns append into override                                                                                                                                                                              |
| 4 | An overlay may set any `devcontainer.json` key, including `image`/`build`/`dockerComposeFile` and lifecycle commands — with a warning naming the key                  | The overlay is the machine owner's file; withholding power from it just sends people to fork the whole config through `templates/`                                                                                                                               |
| 5 | A base config that does not parse is a **hard error**. The flag-translation path is deleted, not kept as a fallback                                                   | Merging into a config we failed to read would build the wrong container, and two behaviors is the complexity this change exists to remove                                                                                                                        |
| 6 | No migration, no detection, no alias. `additionalFeatures` is **gone** — the key is `features`                                                                        | Owner discards stale containers and `~/.cache/devc/` by hand and edits their own overlays. Anything else is code that exists once and is wrong forever                                                                                                           |
| 7 | No config-drift detection in this change                                                                                                                              | Follow-up if it is missed. `devc build` is how a config change takes effect, in both modes, as project mode already works today                                                                                                                                  |
| 8 | Read-only `devc config` mounts are a follow-up plan                                                                                                                   | This change is mount-vocabulary-neutral: the wizard writes exactly what it writes today, just through the merge                                                                                                                                                  |

## Research findings

Read out of the pinned bundle (`@devcontainers/cli@0.88.0`,
`dist/spec-node/devContainersSpecCLI.js`). These are static reads of minified
source, not Docker runs — every one is on the Validation list below.

1. **`--config` must be named `devcontainer.json` or `.devcontainer.json`.**
   `Hv` rejects anything else outright:
   `if (e && !/\/\.?devcontainer\.json$/.test(e.path)) throw …`. The check is
   applied to `--config` only, **not** to `--override-config`. Decision 1's
   filename satisfies it either way.

2. **Relative paths resolve against `dirname(configFilePath)`.** `nV` is
   `path.posix.resolve(dirname(configFilePath), value)`, backing
   `build.dockerfile` / `dockerFile` (`xo`/`oV`), `dockerComposeFile` (`dg`) and
   local Feature paths. Absolute values pass through `resolve` unchanged, which
   is the escape hatch zero-config mode uses.

3. **`--override-config` decouples content from identity — this is the whole
   design.** In `M9` the config _path_ is
   `configFile || <discovered in workspace> || <workspace>/.devcontainer/devcontainer.json`,
   and that path is what `vi` records as `configFilePath` and what the CLI labels
   the container with. The override file supplies bytes only:
   `vi(…, t /* config path */, …, s /* overrideConfigFile */)` does
   `readDocument(s ?? t)` and then `B.configFilePath = t`. So under
   `--override-config`, relative `build.dockerfile`/`context`/`dockerComposeFile`
   and local Features resolve against the project's real `.devcontainer/`,
   `.devcontainer-lock.json` is still found beside the project's config (`SQ`),
   and the `devcontainer.config_file` label is still the project's own path.

4. **Container identity is `devcontainer.local_folder` + `devcontainer.config_file`,
   and a mismatch is expensive.** `bg` looks up by both labels, then by
   `local_folder` alone; a container found by `local_folder` that carries _any_
   `config_file` label is discarded rather than reused, and is **not removed even
   under `--remove-existing-container`** (the removal arm is the `else` of that
   test). This is the mechanism behind the existing `renameConflictWarning`
   "same workspace" branch, and the reason the merged config's path must not
   move.

5. **`--id-label` overrides identity wholesale.** When id-labels are passed, `bg`
   returns them directly and never consults the config path. Noted as an escape
   hatch; not used.

6. **The image tag does not depend on the config path.** `Yo` is
   `vsc-${basename(cwd)}-${sha256(cwd)}` over the _workspace_ folder. Relocating
   the config costs nothing in image cache or naming.

7. **Lifecycle commands accept an object form, whose entries run in parallel**
   (`typeof e === "string" || Array.isArray(e) ? … : Object.keys(e).map(…)`). So
   a merge _could_ combine two `initializeCommand`s — but concurrently, which is
   not what "and also run mine" means. Hence decision 4's warn-and-replace.

8. **`devcontainer build` has no `--override-config`** (only `up`, `exec`,
   `run-user-commands`, `read-configuration`). Harmless: `devc build` is
   `up --remove-existing-container`, not `devcontainer build`.

9. **Compose is still the exception.** On a `dockerComposeFile` config the CLI
   rewrites `mounts` into a generated compose file and drops `readonly` on the
   way (already documented in `devc/README.md`). Read-only overlay mounts are a
   non-compose win.

## Design

### Layers

Lowest to highest:

```text
devc layer  →  base config  →  user devc.json  →  project devc.json
```

- **devc layer** — devc's own contributions: the baseline Features and, when
  anything above opts into the bridge Feature, the bridge token mount. Lowest so
  that everything else can override it, which is what "added under whatever the
  overlay already declares" has always meant.
- **base config** — the project's own `devcontainer.json` /
  `.devcontainer.json`, or (zero-config) the materialized bundled default ⊕
  `~/.config/devc/templates/`.
- **user, then project `devc.json`** — discovery order is unchanged
  (`findUserOverlayPath`, `findProjectOverlayPath`, first hit wins per level).

The devc layer's _content_ depends on the layers above it (it must not add a
Feature something else already declares), so it is computed in two passes:

```ts
const provisional = mergeConfigs([base, user, project]);
const devcLayer = devcContributions(provisional, baselineFeatures);
const merged = mergeConfigs([devcLayer, provisional]);
```

One consequence worth knowing: `null` deletions are resolved in the first pass,
so `"features": null` in an overlay clears the _base's_ Features while devc's
baseline still applies. `baselineFeatures: false` is how you turn devc's own
contributions off — that is what it is for.

### Where the merged config lives, and how it is delivered

```text
~/.cache/devc/
  default-<key>/                              # shared, content-addressed: Dockerfile,
                                              # initialize-command.sh, devcontainer.json
  projects/<basename>-<hash8>/devcontainer.json   # the merged effective config
```

`<basename>-<hash8>` is `containerNameForLocalFolder`'s existing scheme, minus
the `devc-` prefix, over the normalized `localFolder` — so the container name and
the cache directory are visibly about the same thing. Written on every start
(write-to-temp + `rename`, mode `0600`), never deleted by devc.

| Mode        | Base config                       | Flag                         | `configFilePath` the CLI records                |
| ----------- | --------------------------------- | ---------------------------- | ----------------------------------------------- |
| Project     | the project's own                 | `--override-config <merged>` | the project's own config — unchanged from today |
| Zero-config | `default-<key>/devcontainer.json` | `--config <merged>`          | the merged file itself                          |

Project mode is a no-op for identity: same labels, same lock file, same
`.devcontainer/`-relative `Dockerfile`, and VS Code still matches the same
container.

Zero-config records the merged file's own path, so **`build.dockerfile` and
`build.context` are rewritten to absolute paths into `default-<key>/`** when the
merged file is written for `--config` delivery. Only those two keys, and only in
this mode — the base there is devc's own bundled config, whose shape is known.
`initializeCommand` is already absolutized by `materializeDefaultConfig`.

> Zero-config deliberately does **not** use `--override-config`. It would record
> `<project>/.devcontainer/devcontainer.json` as the config path (finding 3),
> which is the same identity a later `devc init` would produce — so devc would
> silently reuse the zero-config container for a project that now has its own
> config.

### Merge rules

`mergeConfigs(layers)` folds left with a two-layer merge. For each key `k` in the
higher layer:

1. `higher[k] === null` → delete `k` from the result.
2. `k` is listed in the higher layer's top-level `$replace` array → set, no
   merging. (`$replace` itself never reaches the output.)
3. both values are plain objects → recurse — **except** directly under
   `features`, where a Feature's options object is replaced whole. (Half a
   project's options blended with half the user's is far harder to reason about
   than "the project's entry replaces the user's"; this rule is inherited
   unchanged from `mergeOverlays`.)
4. both values are arrays → `[...lower, ...higher]`.
5. otherwise → higher wins.

Then, once over the fully merged object:

- **`mounts` dedupe by target.** Iterate in order; a later entry whose target
  equals an earlier entry's **replaces the earlier entry in place** (base
  ordering preserved, highest layer's value kept). Target is parsed from
  `target=`/`dst=` in a string spec, or `.target` on an object spec; an entry
  whose target cannot be parsed is never deduped against.
- **`customizations.vscode.extensions` dedupe** by exact string, first
  occurrence kept.
- **Shape exclusivity.** `image`, `build` and `dockerComposeFile` are mutually
  exclusive in the spec. If a layer above the base sets one, the other two are
  dropped from the result and a `logWarning` names what was replaced.
- **Lifecycle collisions.** When more than one layer sets `initializeCommand`,
  `onCreateCommand`, `updateContentCommand`, `postCreateCommand`,
  `postStartCommand` or `postAttachCommand`, the highest wins (rule 5) and a
  `logWarning` names the key and points at `devc-post-create.sh`, which composes
  correctly. Never auto-combine into the object form — its entries run in
  parallel (finding 7).

**No variable substitution anywhere in the merge.** `${…}` tokens are written
through verbatim and resolved by the CLI, which is what makes `${devcontainerId}`
and `${containerEnv:…}` start working in overlay values.

### Overlay schema

`devc.json` becomes "**any `devcontainer.json` key**, plus `baselineFeatures`".

- `baselineFeatures` is the only devc-only key. Unchanged, including its veto
  semantics (`user && project`) and its warn-and-default-true handling of a
  non-boolean. It never reaches the merged file.
- `$replace` is a merge directive, not a config key. Also stripped.
- `features` replaces `additionalFeatures`. **The old name is not accepted** —
  it falls into the unknown-key warning below, which names it, and the owner
  edits their file.
- Unknown-key warning is retained, with a new list: warn on any key that is
  neither a known `devcontainer.json` key nor `baselineFeatures`/`$replace`. The
  list is a `const` array next to the loader; it is a typo guard, not a schema.
- Mount validation shrinks to a shape check whose only job is a better error
  than Docker's: a string entry must be non-empty and contain a target
  (`target=` or `dst=`); an object entry must have `type` and `target`. The
  full spec vocabulary — `readonly`, `consistency`, any field order — is legal.
  `MOUNT_SPEC_RE` and its retired-field complaint are deleted.
- Parse failures stay loud and unchanged: an overlay that does not parse fails
  the command naming the file; a token-free file is no overlay.

### devc's own layer

Two contributions, both currently implemented as special cases that the merge
absorbs:

- **Baseline Features** — `DEVC_CONFIG_FEATURE` today. Skipped when
  `baselineFeatures` is false, or when anything above declares a Feature of the
  same _name_ (`declaresFeatureNamed`). The name check is still required: merging
  by feature id would install `…/devc-config:0` and `…/devc-config:0.1.0` twice.
- **The bridge token mount** — `type=bind,source=${localEnv:HOME}/.config/devc-bridge/run,target=/run/devc-bridge,readonly`,
  contributed when the merged Features declare a Feature named `devc-bridge`.
  This replaces `injectBridgeMount`'s JSONC fence-splicing into the materialized
  cache config entirely, and it now works in **project mode too** — today
  project-mode users have to write that line themselves, because devc will not
  write into their `.devcontainer/`. It still will not; the mount is contributed
  to the merge instead. Mount dedupe by target subsumes the old
  "does the config already declare this target" check.

With the bridge out of it, `materializeDefaultConfig` / `defaultConfigKey` /
`ensureDefaultConfig` lose their `bridge` option and the cache key becomes
bundled tree + templates.

### `remoteEnv` for `exec` / `attach`

`docker exec` never applies `remoteEnv`, so devc re-derives it after `up`. With a
merged config that is one call against one file:

```ts
const remoteEnv = await loadResolvedRemoteEnv(
  mergedConfigPath,
  result.remoteWorkspaceFolder,
  localFolder,
);
```

The base/overlay two-layer combine in `startContainer` and
`resolveOverlayRemoteEnv` both go away. `substituteVars` stays — this is the one
place devc still resolves `${…}` itself, because the values are being handed to
`docker exec`, not to the CLI.

### Failure modes

- **Base config does not parse** → hard error naming the file. `jsonc-parser`
  takes comments and trailing commas, so a failure here is malformed JSON that
  `devcontainer up` would reject seconds later anyway. `loadResolvedRemoteEnv`'s
  forgiving degrade-to-`{}` is right for its own job and stays; the _merge_ read
  is a separate, strict one.
- **Comments in the base config are not preserved** in the merged output. It is
  a generated artifact parsed by a machine, and the project's own
  `.devcontainer/` is never touched, so no user-authored comment is ever lost.
- **Concurrent starts** on one project write identical bytes and `rename` over
  each other atomically.

### What gets deleted

Not a side effect — this is a substantial part of the point. A cold agent should
end with all of these gone:

| Deleted                                                                                    | Because                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overlayArgs`                                                                              | no flags to build                                                                                                                                                                                                     |
| `MOUNT_SPEC_RE`, `RETIRED_MOUNT_FIELDS`, `mountSpecComplaint`                              | the flag's grammar was the only reason for them                                                                                                                                                                       |
| `isEmptyOverlay`                                                                           | existed to skip `computeContainerWorkspaceFolder`'s git subprocesses                                                                                                                                                  |
| `computeContainerWorkspaceFolder` (+ its test)                                             | a hand-port of the CLI's worktree algorithm, needed only to substitute `${containerWorkspaceFolder}` into flags. The CLI does it now. Removing it is a breaking change to `@devc-tools/core`'s surface, which is fine |
| `resolveOverlayRemoteEnv`                                                                  | one `loadResolvedRemoteEnv` over the merged file replaces it                                                                                                                                                          |
| `loadDeclaredFeatureIds`                                                                   | the merge holds the parsed base config already                                                                                                                                                                        |
| `injectBridgeMount`, `BRIDGE_FENCE`, `BRIDGE_MOUNT_TARGET`                                 | the bridge mount is a merge layer now                                                                                                                                                                                 |
| the `bridge` option on `materializeDefaultConfig`/`defaultConfigKey`/`ensureDefaultConfig` | nothing varies per project in that tree any more                                                                                                                                                                      |
| `additionalFeatures` (the key, everywhere)                                                 | renamed to `features`                                                                                                                                                                                                 |
| `OVERLAY_KEYS`                                                                             | replaced by the known-`devcontainer.json`-keys list                                                                                                                                                                   |

## Concerns that remain

- **devc now has to understand the config shape**, not just pass it through. The
  merge rules cover the keys that matter; every key not named above falls to
  "higher layer wins", which is always right for scalars and acceptable for the
  rest.
- **The overlay gains the power to break the container** — replacing `image`,
  dropping `features`, changing `remoteUser`. Inherent to the feature, mitigated
  only by the warnings in decision 4.
- **"No hidden abstraction" takes a real hit.** Today the config in
  `.devcontainer/` _is_ what runs, plus visible flags. Afterwards the effective
  config is generated into a cache. The standalone invariant is untouched —
  nothing is written into the project, a checkout without devc still builds — but
  "read the folder and you know what runs" is not. `devc up --print-config`
  is the mitigation and ships in the same change.
- **Divergence from VS Code widens.** devc and VS Code share a container in
  project mode (same identity labels) but VS Code applies no overlay, and the
  overlay can now change far more than mounts and env. Whichever tool created the
  container wins. README paragraph, not code.
- **Compose projects get less** — `readonly` is still dropped by the CLI's
  compose rewrite, and merged `mounts` go through that rewrite.
- **Feature install order.** Merging `features` ourselves rather than passing
  `--additional-features` changes key order. `installsAfter` governs real
  ordering, but the round-robin fallback is order-sensitive, so the
  `devc-config`-after-`agents` ordering needs a Docker check.

## Checklist

Ordered so the tree is checkable at each step. `deno fmt`, `deno task check` and
`deno task test` in both `devc/` and `devc-core/` after each.

- [x] **1. `devc-core/merge.ts`** — new, pure, no I/O.
      `mergeConfigs(layers: readonly Record<string, unknown>[]): Record<string, unknown>`
      implementing rules 1–5 plus the three post-passes and the two warning
      cases. Export the helpers a test wants to reach directly
      (`mountTarget(spec: string | Record<string, unknown>): string | null`).
- [x] **2. `devc-core/overlay.ts`** — the overlay becomes a raw
      `Record<string, unknown>` plus `baselineFeatures`:
      `interface DevcOverlay { config: Record<string, unknown>; baselineFeatures: boolean }`.
      `loadOverlayFile` validates the shape check on `mounts`, warns on unknown
      keys against the new list, strips `baselineFeatures`/`$replace` out of
      `config` (keep `$replace` reachable for the merge — simplest is to leave
      it in `config` and let `mergeConfigs` consume and strip it). `mergeOverlays`
      keeps only the `baselineFeatures` veto; layer merging is `mergeConfigs`'
      job. Delete everything in the table above that lives in this file.
- [x] **3. `devc-core/default_config.ts`** — drop the `bridge` option and
      `injectBridgeMount` and friends; drop `loadDeclaredFeatureIds`; add
      `loadConfigStrict(path): Promise<Record<string, unknown>>` (JSONC, throws
      naming the file) for the base-config read.
- [x] **4. `devc-core/merged_config.ts`** — new.
      `ensureMergedConfig(localFolder, configDir?): Promise<MergedConfig>` where
      `MergedConfig = { path: string; config: Record<string, unknown>; mode: 'project' | 'zero-config' }`.
      Resolves the base (`findOwnDevcontainerConfig` → `loadConfigStrict`, else
      `ensureDefaultConfig` → `loadConfigStrict`), loads both overlays, runs the
      two-pass merge with `devcContributions`, absolutizes `build.dockerfile`
      and `build.context` in zero-config mode, and writes to
      `~/.cache/devc/projects/<basename>-<hash8>/devcontainer.json` via
      temp+`rename` at `0600`.
- [x] **5. `devc-core/container.ts`** — `buildUpArgs` takes
      `{ mergedConfigPath, mode }` instead of `configArg`/`overlay`/
      `containerWorkspaceFolder`, and emits `--override-config` or `--config`
      per mode with no `--mount`/`--remote-env`/`--additional-features`.
      `startContainer` calls `ensureMergedConfig`, drops the `isEmptyOverlay`
      branch, and derives `remoteEnv` from the merged file alone. Delete
      `computeContainerWorkspaceFolder` and its re-export in
      `devc/container.ts`.
- [x] **6. `devc up --print-config`** — resolve and merge, print the merged JSON
      to stdout, start nothing. Add to `devc/help.ts` and `devc/args.ts`.
- [x] **7. Tests** — new `devc-core/tests/merge_test.ts` and
      `merged_config_test.ts`; rewrite `overlay_test.ts` and `up_args_test.ts`;
      delete `container_workspace_folder_test.ts`; update
      `default_config_test.ts` / `default_config_cache_test.ts` for the dropped
      `bridge` option; update the `additionalFeatures` fixture
      (`tests/fixtures/devc_overlay.jsonc`) to `features`.
- [x] **8. Docs** — `devc/README.md`'s "Optional overlay" and "Mount specs"
      sections (both are rewritten: four keys → any key, and read-only is now
      possible), its devc-bridge section (project mode no longer needs the
      hand-written mount), `.plans/design/devc-design.md` (Configuration
      precedence, No hidden abstraction, the read-only claim, the bundled-default
      section's `--additional-features` paragraph), `devc-core/README.md` (the
      zero-config cache section), and `.plans/PLAN.md`.

## Implementation notes

Written after the fact. Four things worth knowing that the plan did not
anticipate:

- **`start_container_trap_test.ts` was deleted too**, beyond the file the plan
  named. It existed solely to guard the `isEmptyOverlay` gate on
  `computeContainerWorkspaceFolder` (it put a fake `git` on `PATH` to prove the
  git subprocesses did not run for an empty overlay). Both the gate and the
  function are gone, so the test had nothing left to assert.

- **`loadResolvedRemoteEnv` became `resolveRemoteEnv`, pure.** The plan said to
  keep deriving `remoteEnv` after `up`; with the merged config already parsed and
  in hand, the file-reading and forgiving-parse half of that function had no
  caller left. It now takes the merged object. `substituteVars` stays — that is
  still the one place devc resolves `${…}` itself, because those values go to
  `docker exec` rather than to the CLI.

- **A `null` deletion must not fire the lifecycle warning.** The first run of the
  new tests surfaced it: `"initializeCommand": null` warned that an overlay
  "replaces the one below it", which is exactly wrong — a deletion discards
  nothing in favour of anything. Both the lifecycle and shape-key checks now skip
  `null`. Regression tests cover both.

- **The unknown-key warning changed meaning, not just wording.** It used to say
  "ignoring unknown key"; unknown keys are now _passed through_ to the merged
  config (where the CLI ignores them), so it says so instead. `log_test.ts`
  asserted the old string.

### On the validation that could not run here

This sandbox cannot reach `jsr.io` (403 from the egress policy), so
`deno test`/`deno check` were run against local stand-ins for `@std/assert` and
`@std/path` mapped in through a throwaway `deno.local.json`, with a
GitHub-sourced Deno 2.9.6 (the repo's lockfile is v5, which the npm-distributed
2.2.7 cannot read). Everything under Offline below is genuinely green that way:
**275 core tests, 114 devc tests, both `check` tasks, `deno fmt --check` across
the repo, `workflow_guards_test.sh`, and the portability check.**

Three pre-existing `devc` tests still fail here and failed identically on the
branch point: `devcontainer_selfexec_test.ts`'s two cases and the herdr sidecar
EOF case. All three spawn a _child_ `deno run main.ts`, which resolves its own
imports and hits the same blocked `jsr.io`. Nothing this change touches.

`devc up --print-config` was exercised end to end in both modes against real
temp projects — project mode showed the bridge mount contributed, the overlay
mount replacing a base mount on the same target, a `readonly` mount surviving,
and `${…}` tokens left unsubstituted; zero-config showed `build.dockerfile` and
`build.context` absolutized into `default-<key>/`. The merged file was `0600`,
in the cache, with the project directory untouched.

## Validation

Offline, no Docker:

- [x] Merge: every rule, including `null` through two layers, `$replace`, the
      per-Feature whole-value replace, and each of the two warning cases.
- [x] `mounts` dedupe by target: string vs object form, `target=` vs `dst=`,
      an unparseable entry left alone, and position preserved on replace.
- [x] Layer order: devc's baseline Feature is skipped when any layer declares
      one of the same name by a different tag; the bridge mount appears exactly
      once when opted in, and a user-declared `/run/devc-bridge` mount wins.
- [x] `buildUpArgs` emits `--override-config` in project mode, `--config` in
      zero-config, and never `--mount`/`--remote-env`/`--additional-features`.
- [x] Zero-config merged output carries absolute `build.dockerfile` and
      `build.context` into `default-<key>/`; project mode leaves both untouched.
- [x] An unparseable base config fails, naming the file.
- [x] The merged file is `0600` and two concurrent `ensureMergedConfig` calls
      leave a complete file.
- [x] `deno fmt --check`, both `deno task check`/`test` suites, and
      `devc-core`'s `portability-check` (no `Deno.`/`jsr:` in core).

Needs Docker — add to `docs/manual-verification.md`:

- [ ] **Finding 3 end to end**: `--override-config` in project mode reuses the
      existing container with no rebuild, and `docker inspect` shows
      `devcontainer.config_file` still pointing at the project's own config.
- [ ] A project whose `build.context` is `".."` still builds under
      `--override-config`.
- [ ] A `readonly` overlay mount is genuinely read-only —
      `docker exec -u 0` cannot write to it.
- [ ] `devc-config` still installs after `agents` and `git-container-config`
      with `features` merged directly rather than passed as
      `--additional-features`.
- [ ] The bridge token mount reaches a **project-mode** container from a
      `devc.json` opt-in alone.
- [ ] A compose-based project still comes up; record what happens to `readonly`.
- [ ] VS Code "Reopen in Container" on a devc-started project-mode container
      attaches to the same container.

## Non-goals and follow-ups

Non-goals:

- Writing anything into a project's `.devcontainer/`. The standalone invariant
  is unchanged and unconditional.
- Preserving comments or formatting in the merged output.
- Replacing `~/.config/devc/templates/` — it stays the way to change the
  _bundled default_; the overlay is the way to change _this project_.
- Any migration, alias or fallback for existing containers, caches or overlays
  (decision 6).
- Read-only mounts on compose projects (a CLI limitation, not devc's).

Follow-ups, each its own plan:

- Read-only `devc config` skills mounts, now that the vocabulary allows it.
- Config-drift detection ("this container predates the current config — run
  `devc build`"), if its absence is missed.

## Relevant files

| Path                                                                | Role                                                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `devc-core/overlay.ts`                                              | Overlay load/merge/validate; everything the flag translation left behind                                                        |
| `devc-core/default_config.ts`                                       | Bundled default materialization, the content-addressed cache, `substituteVars`, `loadResolvedRemoteEnv`, bridge-mount injection |
| `devc-core/container.ts`                                            | `buildUpArgs`, `startContainer`, `computeContainerWorkspaceFolder`, `renameConflictWarning`                                     |
| `devc-core/default/devcontainer.json`                               | The bundled base config being merged into                                                                                       |
| `devc-core/mod.ts`                                                  | Public surface of `@devc-tools/core` (star exports; new modules need a line)                                                    |
| `devc/container.ts`, `devc/main.ts`, `devc/args.ts`, `devc/help.ts` | CLI binding and the new `--print-config`                                                                                        |
| `devc/README.md`                                                    | Overlay documentation, "Mount specs", devc-bridge                                                                               |
| `.plans/design/devc-design.md`                                      | Configuration precedence, "No hidden abstraction"                                                                               |
| `.plans/archived/devc-mounts-to-overlay.md`                         | The read-only research this partly supersedes                                                                                   |
