// `@devc-tools/core`'s public entry point — the only module a consumer should import from.
// Everything below is also a standalone `.ts` module (so the CLI can import the pieces it needs
// directly, from source), but `mod.ts` is what an npm consumer gets from `import '@devc-tools/core'`.

// Container lifecycle: start/rebuild/stop/down, status, mounts, exec.
export * from './container.ts';

// Host ↔ container path translation over a container's live mount table (the
// `ContainerMount[]` `getContainerMounts` returns). Host-side only.
export * from './mount_paths.ts';

// The devcontainer CLI seam — swap in a different `DevcontainerRunner` (the CLI binds its own
// self-exec one; a consumer normally wants the default Node one and never touches this).
export * from './devcontainer.ts';

// The `child_process` adapter, exported in case a consumer wants the same run/status shapes
// `container.ts` is built on.
export * from './exec.ts';

// `node:fs` error predicates (`isNotFound` et al.).
export * from './errors.ts';

// Global user config (`~/.config/devc/config.json`): code/skills roots.
export * from './config.ts';

// The `devc.json` overlay: the devc-only layer merged on top of a project's devcontainer.json.
export * from './overlay.ts';

// The layer merge that produces the effective config, and the materialized result of running it.
export * from './merge.ts';
export * from './merged_config.ts';

// Worktree resolution for the mount picker (used by `devc config`, exposed for other UIs).
export * from './worktree.ts';

// Managed mount-fence row helpers (`devc:source` / `devc:skills`).
export * from './mounts.ts';

// `devc init`: scaffold the bundled default `.devcontainer/` into a project.
export * from './init.ts';

// The bundled default config, the global config dir, and devcontainer.json variable
// substitution/remoteEnv resolution.
export * from './default_config.ts';

// Where core's user-facing notices go. A consumer holding a terminal (a TUI) calls `setLogger`
// once at load; leaving it unset reproduces the console output the CLI has always had.
export * from './log.ts';

// Small path helpers shared across the lifecycle and worktree-resolution paths.
export * from './posix.ts';
export * from './paths.ts';

// JSONC text-surgery primitives, for a consumer that wants to edit a devcontainer.json or
// devc.json overlay directly rather than through `wizard_apply.ts`.
export * from './jsonc_edit.ts';

// Applying a wizard-style selection to a project's overlay. `findArraySpan` is omitted here —
// it is already available via the `jsonc_edit.ts` re-export above, and re-exporting the same
// binding twice is redundant rather than a second thing.
export {
  type ApplyDeps,
  applyFences,
  type ApplyResult,
  applySelection,
  type WizardSelection,
} from './wizard_apply.ts';
