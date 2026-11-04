// Code-root mirroring for the workspace mount (`"mirrorCodeRoots": true` in the global config).
//
// The devcontainer CLI mounts a project at `/workspaces/<basename of its git root>`, while a
// `devc:source` row for the same folder lands at `/workspaces/<path under its code root>`
// (`mounts.ts`'s `defaultTarget`). So `~/code/tools/ggg` is `/workspaces/ggg` in its own container
// and `/workspaces/tools/ggg` in every other one. With the setting on, devc gives the primary
// workspace the row's path too, by contributing `workspaceMount` + `workspaceFolder` as a merge
// layer — devc-owned, under every user layer, written only into the merged config in
// `~/.cache/devc/`. Nothing lands in the project's `.devcontainer/`.
//
// Three CLI behaviors this leans on (verified in 0.88.0's `devContainersSpecCLI.js`, whose
// workspace defaulting runs only `if (!workspaceFolder || !("workspaceMount" in config))`):
//
// 1. With **both** keys set the CLI skips its defaulting entirely — including the
//    `--mount-git-worktree-common-dir` mount a linked worktree needs. So for a worktree devc adds
//    the primary's `.git` mount itself ({@link WorkspaceMirror.commonDir}).
// 2. With `workspaceMount` alone, `workspaceFolder` still defaults from the CLI's *own* target, not
//    the mount's — which is why both keys are always set together.
// 3. The CLI itself emits `type=bind,source=…,target=…` on Linux, so that form is the one used.

import {
  type FsProbe,
  longestRootAncestor,
  realFsProbe,
  resolveWorktree,
} from './worktree.ts';
import { type ConfigObject } from './merge.ts';
import { defaultTarget, parseMountSpec, unfoldHome } from './mounts.ts';
import { findRepoRoot } from './repo.ts';
import { relativeUnderPosix } from './posix.ts';
import process from 'node:process';
import type { ContainerMount } from './container.ts';
import { displayPath } from './config.ts';

/** The workspace mount devc contributes for a project under a code root. */
export interface WorkspaceMirror {
  /** Host path mounted: the git root ({@link findRepoRoot}), or localFolder when there is none. */
  source: string;
  /** Container target: `/workspaces/<source relative to codeRoot>`. */
  target: string;
  /** `target` plus localFolder's sub-path under `source` (`target` itself when they are equal). */
  workspaceFolder: string;
  /** The code root `target` mirrors from (absolute, expanded). */
  codeRoot: string;
  /**
   * The primary repo's `.git` mount devc adds itself, because setting both keys makes the CLI skip
   * its own common-dir mount. Only for a linked worktree with a relative `gitdir:`.
   */
  commonDir: { source: string; target: string } | null;
}

/**
 * {@link workspaceMirrorDecision}'s answer: the mirror, or why there is none. `reason` is null when
 * the setting is simply off — there is nothing to explain then.
 */
export type WorkspaceMirrorDecision =
  | { mirror: WorkspaceMirror; reason: null }
  | { mirror: null; reason: string | null };

/** Reasons {@link workspaceMirrorDecision} gives, as `devc status` prints them. */
export const MIRROR_REASON = {
  explicit: 'explicit workspaceMount/workspaceFolder',
  compose: 'Docker Compose project',
  notUnderRoot: 'not under a code root',
  absoluteGitdir: 'worktree uses absolute gitdir',
  primaryOutsideRoot: "worktree's primary repo is outside its code root",
  comma: 'path contains a comma',
} as const;

/** `mount target already used by <source>`. */
export function mirrorTargetTakenReason(source: string): string {
  return `mount target already used by ${source}`;
}

/** `p` without trailing slashes, the filesystem root kept. */
function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/(?!^)\/+$/, '') : p;
}

const skip = (reason: string | null): WorkspaceMirrorDecision => ({
  mirror: null,
  reason,
});

/**
 * Whether the mirror applies to `localFolder`, and what it is. `config` is the provisional merge
 * (base config + overlays) — never devc's own layers. `codeRoots` are absolute and expanded.
 *
 * It does not apply when:
 * - `enabled` is false (reason null);
 * - the config is a Docker Compose project;
 * - the config sets `workspaceMount` or `workspaceFolder` itself — an explicit config wins, which
 *   is also how one project opts out;
 * - the source is under no code root, or **is** one;
 * - the source is a linked worktree with an absolute `gitdir:`, or whose primary repo no code root
 *   holds together with it (the `.git` link only resolves when both mirror from one base);
 * - a path contains a comma (a mount spec would need quoting, which devc's parsers do not read);
 * - a `mounts` entry already targets the mirrored path from a **different** source, or read-only —
 *   the mirror never shadows a user mount. The same source, writable, is fine: {@link dropRedundantWorkspaceRows} removes
 *   that entry after the merge.
 */
export async function workspaceMirrorDecision(
  config: ConfigObject,
  localFolder: string,
  codeRoots: string[],
  enabled: boolean,
  fs: FsProbe = realFsProbe,
  home: string | undefined = process.env.HOME,
): Promise<WorkspaceMirrorDecision> {
  if (!enabled) return skip(null);
  if (config.dockerComposeFile !== undefined) {
    return skip(MIRROR_REASON.compose);
  }
  if (
    config.workspaceMount !== undefined || config.workspaceFolder !== undefined
  ) {
    return skip(MIRROR_REASON.explicit);
  }

  const folder = trimSlash(localFolder);
  const source = trimSlash(await findRepoRoot(folder) ?? folder);
  const roots = codeRoots.map(trimSlash);
  let codeRoot = longestRootAncestor(source, roots);
  if (codeRoot === null || codeRoot === source) {
    return skip(MIRROR_REASON.notUnderRoot);
  }

  let commonDir: WorkspaceMirror['commonDir'] = null;
  let wt = await resolveWorktree(source, codeRoot, fs);
  if (wt.isWorktree) {
    if (!wt.valid) return skip(MIRROR_REASON.absoluteGitdir);
    // The base must hold both checkouts, and must be a code root so the targets match the rows
    // the wizard writes: the longest root holding both.
    const primaryRoot = wt.primaryRoot!;
    const holdsBoth = roots.filter((r) =>
      relativeUnderPosix(r, source) !== null &&
      (primaryRoot === r || relativeUnderPosix(r, primaryRoot) !== null)
    );
    const base = longestRootAncestor(source, holdsBoth);
    if (base === null) return skip(MIRROR_REASON.primaryOutsideRoot);
    if (base !== codeRoot) {
      codeRoot = base;
      wt = await resolveWorktree(source, codeRoot, fs);
    }
    if (
      !wt.isWorktree || wt.primaryGitTarget === undefined ||
      wt.mountBase !== codeRoot
    ) {
      return skip(MIRROR_REASON.primaryOutsideRoot);
    }
    commonDir = { source: wt.primaryGitDir!, target: wt.primaryGitTarget };
  }

  const target = defaultTarget('source', source, codeRoot);
  const sub = relativeUnderPosix(source, folder);
  const workspaceFolder = sub === null ? target : `${target}/${sub}`;

  const paths = [source, target, workspaceFolder];
  if (commonDir !== null) paths.push(commonDir.source, commonDir.target);
  if (paths.some((p) => p.includes(','))) return skip(MIRROR_REASON.comma);

  if (Array.isArray(config.mounts)) {
    for (const entry of config.mounts) {
      const spec = parseMountSpec(entry);
      if (spec === null || trimSlash(spec.target) !== target) continue;
      const other = spec.source === null
        ? null
        : trimSlash(unfoldHome(spec.source, home));
      if (spec.type !== 'bind' || other !== source || spec.readonly) {
        return skip(mirrorTargetTakenReason(spec.source ?? spec.type));
      }
    }
  }

  return {
    mirror: { source, target, workspaceFolder, codeRoot, commonDir },
    reason: null,
  };
}

/** {@link workspaceMirrorDecision}'s mirror alone, or null. */
export async function workspaceMirror(
  config: ConfigObject,
  localFolder: string,
  codeRoots: string[],
  enabled: boolean,
  fs: FsProbe = realFsProbe,
  home: string | undefined = process.env.HOME,
): Promise<WorkspaceMirror | null> {
  return (await workspaceMirrorDecision(
    config,
    localFolder,
    codeRoots,
    enabled,
    fs,
    home,
  )).mirror;
}

/** The config layer: `workspaceMount`, `workspaceFolder`, and `mounts: [commonDir]` when set. */
export function workspaceMirrorLayer(mirror: WorkspaceMirror): ConfigObject {
  const layer: ConfigObject = {
    workspaceMount: `type=bind,source=${mirror.source},target=${mirror.target}`,
    workspaceFolder: mirror.workspaceFolder,
  };
  if (mirror.commonDir !== null) {
    layer.mounts = [
      `type=bind,source=${mirror.commonDir.source},target=${mirror.commonDir.target}`,
    ];
  }
  return layer;
}

/**
 * `config` without the `mounts` entries that repeat the workspace mount — same target, same
 * (`unfoldHome`d) source. Docker refuses two mounts on one target, and the merge's `mounts` dedupe
 * does not look at `workspaceMount`. Returns `config` itself when nothing matches.
 */
export function dropRedundantWorkspaceRows(
  config: ConfigObject,
  mirror: WorkspaceMirror,
  home: string | undefined = process.env.HOME,
): ConfigObject {
  if (!Array.isArray(config.mounts)) return config;
  const kept = config.mounts.filter((entry) => {
    const spec = parseMountSpec(entry);
    if (spec === null || spec.source === null || spec.readonly) return true;
    return !(
      trimSlash(spec.target) === mirror.target &&
      trimSlash(unfoldHome(spec.source, home)) === mirror.source
    );
  });
  return kept.length === config.mounts.length
    ? config
    : { ...config, mounts: kept };
}

/**
 * The `devc status` line for the workspace mirror, or null when `mirrorCodeRoots` is off (both
 * arguments null). `mounts` is the container's live mount table (`getContainerMounts`), null when
 * there is no container: with one, a container whose workspace source is bound somewhere other
 * than the mirrored target was created before the mirror applied — mounts are fixed at create
 * time, so only `devc build` moves it.
 */
export function workspaceMirrorStatusLine(
  mirror: WorkspaceMirror | null,
  skipped: string | null,
  mounts: ContainerMount[] | null,
): string | null {
  if (mirror === null) {
    return skipped === null ? null : `workspace: CLI default (${skipped})`;
  }
  const line = `workspace: ${mirror.target} (mirrored from code root ${
    displayPath(mirror.codeRoot)
  })`;
  if (mounts === null) return line;
  const binds = mounts.filter((m) =>
    m.type === 'bind' && trimSlash(m.source) === mirror.source
  );
  return binds.some((m) => trimSlash(m.destination) === mirror.target)
    ? line
    : `${line} — container predates this, run devc build to apply`;
}
