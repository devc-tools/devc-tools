# devc-mirror-code-roots — mount the project at its code-root path

With `"mirrorCodeRoots": true` in the global config, a project under a configured code root is
mounted at the same container path whether it is the primary workspace or an extra `devc:source`
row. `~/code/tools/ggg` lands at `/workspaces/tools/ggg`, not the devcontainer CLI's default
`/workspaces/ggg`. Its worktree `~/code/tools/ggg.worktrees/feat` lands at
`/workspaces/tools/ggg.worktrees/feat`, with the primary's `.git` at `/workspaces/tools/ggg/.git`.

devc adds this as a **runtime layer** in the merged config under `~/.cache/devc/`. Nothing is
written into the project's `.devcontainer/`, and `devc init` is unchanged (see "Why not `devc
init`"). It is off by default.

## Checklist

- [x] Step 0 — confirm three CLI behaviors against the embedded `@devcontainers/cli` (0.88.0) and
      record the results in this plan under "Step 0 results". If any one differs, stop and report:
      1. With both `workspaceMount` and `workspaceFolder` set, the CLI adds **no**
         `--mount-git-worktree-common-dir` mount for a linked-worktree project (as
         `worktreeCommonDirRow`'s doc comment in `devc-core/overlay.ts` claims).
      2. With `workspaceMount` set and `workspaceFolder` unset, `workspaceFolder` does **not**
         follow the mount's target. This is why the layer always sets both.
      3. A `workspaceMount` string of the form `type=bind,source=<abs>,target=<abs>` is accepted
         (no `consistency=`).
- [x] `devc-core/config.ts`: `mirrorCodeRootsFromConfig` (see Contracts)
- [x] `devc-core/workspace_mirror.ts` (new): `WorkspaceMirror`, `workspaceMirror`,
      `workspaceMirrorLayer`, `dropRedundantWorkspaceRows` (see Contracts)
- [x] `devc-core/merged_config.ts`: `MergedConfigOptions` gains `codeRoots` and `mirrorCodeRoots`;
      `ensureMergedConfig` applies the layer; `MergedConfig` gains `workspaceMirror`
- [x] `devc-core/mod.ts`: export the new module's public names
- [x] `devc/git_root_guard.ts`: the guard still runs when the workspace mount is devc's own
- [x] `devc/main.ts`: `devc status` prints a workspace-mirror line, including the "container
      predates it" case
- [x] Docs: `.plans/design/devc-design.md` (global config section and the merged-config layer
      list), `devc/README.md` (global config keys)
- [x] Tests listed under Relevant Files
- [x] `deno task test` (or the repo's usual check/test commands) pass for `devc-core` and `devc`
      — `devc` 980/980; `devc-core` all but two that already fail on the unchanged tree
      (`default_config_test.ts` "materialized (zero-config) devcontainer.json…" and
      `git_dirs_test.ts` "cliWorktreeMounts matches what the pinned devcontainer CLI computes").
      devc-desktop's `tsc` could not run in this container (`@typescript/typescript-linux-x64`
      missing); desktop does not reference `MergedConfig`, and the new fields are additive.

## Contracts

### Global config key

In `~/.config/devc/config.jsonc` (or `config.json`), next to `codeRoots`:

```jsonc
"mirrorCodeRoots": true   // default false; anything other than literal true reads as false
```

It stays in `GlobalConfig.extra`, the same way as `webSource` and `bridgeDefaultAllow`, so every
save, including the wizard's, preserves it verbatim. There is no wizard UI for it.

```ts
// devc-core/config.ts
/** `mirrorCodeRoots === true`; any other value (absent, "true", 1) is false. */
export function mirrorCodeRootsFromConfig(cfg: GlobalConfig): boolean;
```

A non-boolean value prints one `noticeOnce` warning:
`devc: <displayPath(cfg.path)>: mirrorCodeRoots must be true or false, ignored`.

### `devc-core/workspace_mirror.ts`

```ts
export interface WorkspaceMirror {
  /** Host path the CLI would mount: the git root (findRepoRoot) or localFolder when there is none. */
  source: string;
  /** Container target: `/workspaces/<source relative to its longest code root>`. */
  target: string;
  /** `target` plus localFolder's sub-path under `source` ('' sub-path ⇒ `target` itself). */
  workspaceFolder: string;
  /**
   * The primary repo's `.git` mount devc must add itself, because setting both keys makes the CLI
   * skip its own common-dir mount. Only for a linked worktree with a relative `gitdir:`.
   */
  commonDir: { source: string; target: string } | null;
}

/**
 * The mirror for localFolder, or null when it does not apply. `config` is the provisional merge
 * (base + overlays). Null when any of these holds:
 *   - `enabled` is false;
 *   - `config.dockerComposeFile` is set;
 *   - `config.workspaceMount` or `config.workspaceFolder` is set (an explicit config wins: this
 *     is also the per-project opt-out);
 *   - the source sits under no code root, or **is** a code root (relative path '');
 *   - the source is a linked worktree with an absolute `gitdir:` (cannot be mounted at a mirrored
 *     path, so the CLI default is left alone).
 * `codeRoots` are absolute, already expanded. Nested roots: the longest wins (`longestRootAncestor`).
 */
export async function workspaceMirror(
  config: ConfigObject,
  localFolder: string,
  codeRoots: string[],
  enabled: boolean,
  fs?: FsProbe,
): Promise<WorkspaceMirror | null>;

/** The config layer: `workspaceMount`, `workspaceFolder`, and `mounts: [commonDir]` when set. */
export function workspaceMirrorLayer(mirror: WorkspaceMirror): ConfigObject;
```

The layer's values:

```jsonc
"workspaceMount": "type=bind,source=<mirror.source>,target=<mirror.target>",
"workspaceFolder": "<mirror.workspaceFolder>",
"mounts": ["type=bind,source=<commonDir.source>,target=<commonDir.target>"]  // worktree only
```

`source` is the absolute host path, not folded to `${localEnv:HOME}`. The cache file is
machine-local, and `checkableBindMounts` / `classifyGitRows` resolve absolute paths directly.

The worktree `commonDir` target must equal `resolveWorktree(source, root, …).primaryGitTarget`
for the same root. That keeps it consistent with the wizard's extra rows. When the primary sits
outside the code root, `resolveWorktree` falls back to the common ancestor as its base. In that
case the mirror falls back too: compute `target` from that same base so the relative `gitdir:`
still resolves. If that base is not under a code root either, return null.

### Duplicate targets

Docker rejects two mounts with the same target, and the merge's `mounts` dedupe does not look at
`workspaceMount`. After the final merge:

```ts
/**
 * Removes `mounts` entries whose target equals `mirror.target` and whose source (unfoldHome'd)
 * equals `mirror.source`: the same mount listed twice. Returns the config unchanged when none match.
 */
export function dropRedundantWorkspaceRows(
  config: ConfigObject,
  mirror: WorkspaceMirror,
): ConfigObject;
```

A `mounts` entry in the provisional merge that targets `mirror.target` with a **different**
source makes `workspaceMirror` return null, so the mirror never shadows a user mount. That check
lives in `workspaceMirror`, before any layer is built.

### `ensureMergedConfig` (`devc-core/merged_config.ts`)

```ts
export interface MergedConfigOptions {
  // ...existing...
  /** Expanded code roots. Default: loadGlobalConfig().codeRootsExpanded() (an expansion error ⇒ []). */
  codeRoots?: string[];
  /** Default: mirrorCodeRootsFromConfig(loadGlobalConfig()). */
  mirrorCodeRoots?: boolean;
}

export interface MergedConfig {
  // ...existing...
  /** The mirror applied to this workspace, or null when it did not apply. */
  workspaceMirror: WorkspaceMirror | null;
}
```

Every caller goes through `ensureMergedConfig`: CLI, `container.ts`'s `startContainer` /
`connectionFor`, devc web and devc-desktop. So it loads the global config itself when the options
are absent, and no caller needs changing.

Order inside `ensureMergedConfig`:

1. `provisional = mergeConfigs([base, ...overlays.layers])`, as today.
2. `mirror = workspaceMirror(provisional, …)`.
3. `withMirror = mirror ? mergeConfigs([workspaceMirrorLayer(mirror), provisional]) : provisional`.
   Use `withMirror` for `classifyGitRows`, `bridgeClientDecision`, `declaresBridge` and
   `devcContributions`, so git protection derives rows for the mirrored workspace target and the
   common-dir `gitdir` row. Without this, `.git/config` and `.git/hooks` in a mirrored worktree
   would be writable. `assertGitProtectSupported` stays on `provisional`.
4. Final merge: `[devcContributions(...), gitProtectLayer(...), workspaceMirrorLayer(mirror)?, provisional]`,
   then `stripDevcOnlyKeys`, then `dropRedundantWorkspaceRows` when `mirror` is set.

The mirror layer sits above devc's other layers and below every user layer.
`worktreeCommonDirRow` already returns null once both keys are set, so the common-dir row is
counted exactly once, through `mounts`.

### Ancestor-repo guard (`devc/git_root_guard.ts`)

`ancestorRepoRoot` returns null whenever `config.workspaceMount` is set. With the mirror on, that
would silence the "not a git repo root — the CLI will mount `<root>`" prompt. Change the rule: a
`workspaceMount` counts as explicit only when `merged.workspaceMirror === null`. When the mirror
applied, the guard compares `merged.workspaceMirror.source` with `localFolder`, as it compares the
git root today. `ancestorRepoRoot`'s signature may take the `MergedConfig` (or the mirror) to do
this; update its tests to match.

### `devc status` line

Printed after the repo-overlay line:

- `workspace: /workspaces/tools/ggg (mirrored from code root ~/code)` when `workspaceMirror` is set.
- Nothing when `mirrorCodeRoots` is off.
- `workspace: CLI default (<reason>)` when it is on but did not apply. `<reason>` is one of:
  `explicit workspaceMount/workspaceFolder`, `Docker Compose project`, `not under a code root`,
  `worktree uses absolute gitdir`, `mount target already used by <source>`. For this,
  `workspaceMirror` needs a reason-returning variant, or a sibling
  `workspaceMirrorDecision(...)`: `{ mirror } | { reason }`. Either is fine; `status` must not
  re-derive the rules.
- When a container exists, its live mounts (`getContainerMounts`) show the workspace source at a
  destination other than `mirror.target`. Append:
  `— container predates this, run devc build to apply`.

## Why not `devc init`

A committed `devcontainer.json` is shared by every worktree of the repo. A literal
`target=/workspaces/tools/ggg` would mount `ggg.worktrees/feat` there and drop the CLI's
common-dir mount, which breaks git in every worktree. Devcontainer variables expose only
`${localWorkspaceFolderBasename}`, not the parent path, so the mapping cannot be written
statically. It would also put one machine's folder layout into a shared file. That breaks the
overlay invariant: `.devcontainer/` must work, un-augmented, without devc. The runtime layer
already applies in project mode, so an init'd project gets the mirrored path under devc, and
plain VS Code or the plain CLI fall back to `/workspaces/ggg`. `devc init` is not changed.

## Concept boundaries

- **`workspaceMirror` vs `workspaceMountRow`** (`overlay.ts`). `workspaceMountRow` stays the one
  reader of "what is the workspace mount", and it already returns a config-declared
  `workspaceMount` as written. Because of that, bridge pins (`devc/bridge.ts`) and git protection
  pick up the mirror with no change. Do not teach `workspaceMountRow` about code roots.
- **`WorkspaceMirror.commonDir` vs `CliWorktreeMounts`** (`worktree.ts`). `cliWorktreeMounts`
  transcribes what the **CLI** does and must stay literal. The mirror's common-dir mount is devc's
  own, built from `resolveWorktree`. Do not change `cliWorktreeMounts` to match.
- **`mirrorCodeRoots` is a global config key, not an overlay key.** It is not in `DEVC_ONLY_KEYS`
  and never appears in a `devc.json`. The per-project opt-out is setting `workspaceMount` or
  `workspaceFolder` in the project's config or overlay.
- **`defaultTarget(kind, hostPath, root)`** (`mounts.ts`) already computes the same
  `/workspaces/<rel>` for wizard rows. Reuse it, or share its rule, for `mirror.target`. The point
  of the feature is that the two always agree.
- **Container identity is unchanged.** `projectKey` / `mergedConfigPath` / container name stay
  keyed on `localFolder`. A container created before the switch keeps its old mount until
  `devc build`; nothing migrates automatically.

## Relevant Files

- `devc-core/config.ts` — `mirrorCodeRootsFromConfig`
- `devc-core/workspace_mirror.ts` — new
- `devc-core/merged_config.ts` — layer wiring, options, `MergedConfig.workspaceMirror`
- `devc-core/worktree.ts` — `resolveWorktree`, `longestRootAncestor` (reused, not changed)
- `devc-core/mounts.ts` — `defaultTarget`, `parseMountSpec`, `unfoldHome` (reused)
- `devc-core/repo.ts` — `findRepoRoot` (reused)
- `devc-core/mod.ts` — exports
- `devc/git_root_guard.ts` — guard rule
- `devc/main.ts` — `devc status` line
- `.plans/design/devc-design.md`, `devc/README.md` — docs

Tests:

- `devc-core/tests/workspace_mirror_test.ts` (new), using temp-dir fixtures as in
  `worktree_test.ts` / `git_protect_test.ts`:
  - plain repo under a root → `/workspaces/tools/ggg`, folder = target, no `commonDir`;
  - project in a repo subfolder → mount the git root, folder = target + sub-path;
  - non-repo folder under a root → mount the folder itself;
  - linked worktree with relative `gitdir:` → worktree target plus `commonDir`
    `/workspaces/tools/ggg/.git`;
  - worktree whose primary is outside the root → common-ancestor base, or null;
  - absolute `gitdir:` → null;
  - outside every root, or the root itself → null;
  - nested roots → the longest wins;
  - explicit `workspaceMount` or `workspaceFolder` → null;
  - `dockerComposeFile` → null;
  - a `mounts` entry on the target with a different source → null;
  - with the same source → `dropRedundantWorkspaceRows` removes it;
  - disabled → null.
- `devc-core/tests/merged_config_test.ts`:
  - with `mirrorCodeRoots: true` the written config has both keys;
  - for a worktree, `protectedRows` include the mirrored workspace and the common dir as `gitdir`;
  - a project-level `workspaceFolder` wins (no mirror);
  - `mirrorCodeRoots: false` output is byte-identical to today's.
- `devc-core/tests/global_config_test.ts` — `mirrorCodeRootsFromConfig`: true / false / absent /
  non-boolean (notice), and preserved on save.
- `devc/tests/git_root_guard_test.ts` — the ancestor prompt still fires when the mirror applies and its
  source is an ancestor of `localFolder`.

## Step 0 results

Read from the embedded CLI's `dist/spec-node/devContainersSpecCLI.js` (0.88.0), function `Uv`
(workspace defaulting). All three confirmed:

1. The defaulting block — including the common-dir `additionalMountString` — runs only
   `if (mountWorkspaceGitRoot && (!workspaceFolder || !("workspaceMount" in config)))`. With both
   keys set it is skipped entirely: no common-dir mount.
2. With `workspaceMount` set and `workspaceFolder` unset, the block still runs and sets
   `workspaceFolder = posix.join(E, relative(gitRoot, folder))`, where `E` is the CLI's own
   `/workspaces/…` target — it does not follow the mount.
3. On Linux the CLI itself emits `type=bind,source=<abs>,target=<abs>` (the `consistency=` suffix
   is added only off Linux), so that form is accepted.

## As built — differences from the contracts above

- `WorkspaceMirror` also carries `codeRoot` (for the status line).
- `workspaceMirrorDecision(...)` returns `{ mirror, reason }`; `workspaceMirror(...)` is its mirror
  alone. Both take optional `fs` and `home` for tests. Reasons are `MIRROR_REASON.*` and
  `mirrorTargetTakenReason(source)`; one more than planned, `MIRROR_REASON.primaryOutsideRoot`.
- `MergedConfig` gains `workspaceMirrorSkipped: string | null` beside `workspaceMirror`.
- Worktree base: rather than `resolveWorktree`'s common-ancestor fallback, the mirror uses the
  **longest code root holding both** the worktree and its primary, and skips with
  `primaryOutsideRoot` when there is none. Targets therefore always match the wizard's rows.
- A same-target row that is `readonly` counts as a conflict (never dropped), so a deliberately
  frozen mount is not silently replaced by a writable one.
- `ancestorRepoRoot` gains a fourth parameter `mirrored = false`; `guardAncestorRepoMount` passes
  `merged.workspaceMirror !== null`.
- The status line is a pure core helper, `workspaceMirrorStatusLine(mirror, skipped, mounts)`.
