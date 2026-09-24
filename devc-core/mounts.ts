// Pure helpers for the two managed mount fences (`devc:source`, `devc:skills`), and for the
// git-protection mounts derived from them.
//
// A "row" is the wizard's model of one bind mount: a host path and a container path. This
// module is the single place that knows how a row serializes to a devcontainer bind-mount
// spec string and back, what the container-path defaults are, and where `${localEnv:HOME}`
// folding happens. `jsonc_edit.ts` does the text surgery; this module produces the
// JSON-string element text that goes inside a fence.

import process from 'node:process';
import { relativeUnderPosix } from './posix.ts';

/** Container mount root for source-code folders. */
export const SOURCE_CONTAINER_ROOT = '/workspaces';
/** Container mount root for per-folder skills (where the in-container agent looks). */
export const SKILLS_CONTAINER_ROOT = '/home/vscode/.claude/skills';

/** Which managed fence a row belongs to. */
export type MountKind = 'source' | 'skills';

/** One editable bind-mount row in the wizard. */
export interface MountRow {
  /** Host path, stored as written (may contain `${localEnv:HOME}` or an absolute path). */
  source: string;
  /** Container path (the mount target). */
  target: string;
}

/** The last path segment of a `/`-separated path (trailing slashes ignored). */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * Fold an absolute host path under `$HOME` to `${localEnv:HOME}/<rest>` (matching the bundled
 * default's style); leave anything else as the absolute host path. A path that is already
 * written with `${localEnv:HOME}` or `~` is returned unchanged so re-folding is a no-op.
 */
export function foldHome(
  hostPath: string,
  home: string | undefined = process.env.HOME,
): string {
  if (
    hostPath.startsWith('${localEnv:HOME}') || hostPath === '~' ||
    hostPath.startsWith('~/')
  ) {
    return hostPath;
  }
  if (home !== undefined && home !== '') {
    if (hostPath === home) return '${localEnv:HOME}';
    if (hostPath.startsWith(home + '/')) {
      return '${localEnv:HOME}' + hostPath.slice(home.length);
    }
  }
  return hostPath;
}

/**
 * The inverse of {@link foldHome}: `${localEnv:HOME}/rest` and `~/rest` become `<home>/rest`, so
 * a row's `source` can be stat'd on the host. Anything else — an absolute path, or a path
 * carrying some other `${...}` variable — is returned unchanged, which for the latter means the
 * caller's `stat` misses and the row is skipped. That is the intended answer: devc substitutes
 * no variables (see `merge.ts`'s header), so a source it cannot resolve is one it must not
 * claim to have protected.
 */
export function unfoldHome(
  hostPath: string,
  home: string | undefined = process.env.HOME,
): string {
  if (home === undefined || home === '') return hostPath;
  for (const prefix of ['${localEnv:HOME}', '~']) {
    if (hostPath === prefix) return home;
    if (hostPath.startsWith(prefix + '/')) {
      return home + hostPath.slice(prefix.length);
    }
  }
  return hostPath;
}

/**
 * Default container path for a host folder in `kind`'s fence.
 *
 * For `source`, when `root` is a configured code root that `hostPath` sits under, the target
 * keeps the sub-path relative to that root (`~/code` + `~/code/a/b` → `/workspaces/a/b`) so
 * nested folders and worktree layouts are preserved. Otherwise (skills, or no matching root)
 * the target is `<container-root>/<basename>`. `hostPath`/`root` must be absolute for the
 * relative form — `$HOME` folding is applied to the `source=`, never to the target.
 */
export function defaultTarget(
  kind: MountKind,
  hostPath: string,
  root?: string,
): string {
  const containerRoot = kind === 'source'
    ? SOURCE_CONTAINER_ROOT
    : SKILLS_CONTAINER_ROOT;
  if (kind === 'source' && root !== undefined) {
    const rel = relativeUnderPosix(root, hostPath);
    if (rel !== null) return `${containerRoot}/${rel}`;
  }
  return `${containerRoot}/${basename(hostPath)}`;
}

/**
 * Build a row for a freshly-picked host folder: fold `$HOME`, default target for the step.
 * `hostPath` is the raw path the picker/user supplied (absolute or `${localEnv:HOME}`).
 * `root` is the configured code root `hostPath` falls under (source only), used to keep the
 * container target's sub-path — the target is computed from the unfolded `hostPath`/`root`.
 */
export function rowForHostPath(
  kind: MountKind,
  hostPath: string,
  root?: string,
): MountRow {
  return {
    source: foldHome(hostPath),
    target: defaultTarget(kind, hostPath, root),
  };
}

/**
 * The bind-mount spec string for a row (no surrounding quotes).
 *
 * These rows are emitted into the `devc.json` overlay, which reaches the container as
 * `devcontainer up --mount` args — and that flag accepts *only*
 * `type=<bind|volume>,source=…,target=…[,external=<true|false>]`, in that field order. So
 * this is the whole vocabulary available: `consistency=cached` and `readonly` are rejected
 * by the CLI's own arg validation, not silently dropped. See {@link
 * import("./overlay.ts").MOUNT_SPEC_RE}.
 */
export function serializeMount(row: MountRow): string {
  return `type=bind,source=${row.source},target=${row.target}`;
}

/** A row serialized as a fence entry: the JSON-quoted spec string, ready for `writeBlocks`. */
export function rowToEntry(row: MountRow): string {
  return JSON.stringify(serializeMount(row));
}

/**
 * Parse a fence entry (a JSON string element, e.g. `"type=bind,source=...,target=..."`, or the
 * bare spec string) back into a row. Returns null when it is not a `type=bind` spec.
 *
 * Deliberately more permissive than {@link serializeMount} is: fields devc no longer emits
 * (`consistency`, `readonly`, and anything else) are accepted and ignored rather than failing
 * the parse, so a spec written by an older devc — or by hand — still round-trips, normalized
 * to the current form on the next write.
 */
export function parseEntry(entry: string): MountRow | null {
  let spec = entry.trim();
  if (spec.startsWith('"')) {
    try {
      const v = JSON.parse(spec);
      if (typeof v !== 'string') return null;
      spec = v;
    } catch {
      return null;
    }
  }
  const fields = new Map<string, string>();
  for (const part of spec.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  if (fields.get('type') !== 'bind') return null;
  const source = fields.get('source');
  const target = fields.get('target');
  if (source === undefined || target === undefined) return null;
  return { source, target };
}

/** Parse many entries, skipping any that are not bind specs. */
export function parseEntries(entries: string[]): MountRow[] {
  const rows: MountRow[] = [];
  for (const e of entries) {
    const row = parseEntry(e);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/** Thrown when two rows in the same step share a container `target`. */
export class DuplicateTargetError extends Error {
  constructor(public readonly target: string) {
    super(`a mount with target ${target} already exists in this step`);
    this.name = 'DuplicateTargetError';
  }
}

/**
 * Reject adding `candidate` when its target collides with any existing row (design: duplicate
 * `target` within a step is refused). `existingIndex` lets an edit skip its own row.
 */
export function assertNoDuplicateTarget(
  rows: MountRow[],
  candidate: MountRow,
  existingIndex = -1,
): void {
  for (let i = 0; i < rows.length; i++) {
    if (i === existingIndex) continue;
    if (rows[i].target === candidate.target) {
      throw new DuplicateTargetError(candidate.target);
    }
  }
}

// ── git protection ──────────────────────────────────────────────────────────────────────────
//
// `.git/config` and `.git/hooks` are *code*: both name programs git runs. A bind-mounted repo
// hands the container write access to them, so whatever runs in the container can plant a
// `pre-push` hook or a `core.fsmonitor` that executes **on the host, as the host user**, the next
// time the host (or its editor) runs git in that repo. `gitProtectMounts` derives the mounts that
// close it. See `overlay.ts`'s `gitProtectLayer` for which rows they are derived from, and
// `devc/README.md`'s "Git protection" for the operating rule that follows.

/**
 * A fuller view of one `mounts` entry than {@link parseEntry} gives: the mount type and the
 * read-only bit, which git protection has to know about.
 *
 * Accepts both entry forms a `devcontainer.json` allows — the comma-separated string spec and the
 * object form — because the merged config may carry either, and an entry devc cannot read is one
 * it must not derive protection for.
 */
export interface MountSpec {
  /** `type=` / `.type`, defaulting to `bind` exactly as the devcontainer CLI does. */
  type: string;
  /** `source=` / `.source`, or null when the entry has none (an anonymous volume). */
  source: string | null;
  /** `target=`/`dst=`/`destination=` / `.target`. */
  target: string;
  /** True when the entry already mounts read-only, however it spells it. */
  readonly: boolean;
}

/**
 * Parse one `mounts` entry into a {@link MountSpec}, or null when it is not a mount this can
 * read (no target, or a non-string/non-object entry).
 *
 * The `readonly` field is the reason this exists rather than {@link parseEntry}: a row that is
 * *already* read-only must never have git-protection mounts derived for it, because the derived
 * `.git` mount is read-**write** and would punch a writable hole in a repo the user had
 * deliberately frozen whole.
 */
export function parseMountSpec(entry: unknown): MountSpec | null {
  if (typeof entry === 'string') {
    const fields = new Map<string, string>();
    for (const part of entry.split(',')) {
      const eq = part.indexOf('=');
      if (eq === -1) {
        // A bare flag: `readonly` and `ro` are the two the CLI accepts.
        const flag = part.trim();
        if (flag === 'readonly' || flag === 'ro') {
          fields.set('readonly', 'true');
        }
        continue;
      }
      fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    const target = fields.get('target') ?? fields.get('dst') ??
      fields.get('destination');
    if (target === undefined || target === '') return null;
    const ro = fields.get('readonly') ?? fields.get('ro');
    return {
      type: fields.get('type') ?? 'bind',
      source: fields.get('source') ?? null,
      target,
      readonly: ro !== undefined && ro !== 'false',
    };
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return null;
  }
  const obj = entry as Record<string, unknown>;
  if (typeof obj.target !== 'string' || obj.target === '') return null;
  return {
    type: typeof obj.type === 'string' ? obj.type : 'bind',
    source: typeof obj.source === 'string' ? obj.source : null,
    target: obj.target,
    readonly: obj.readonly === true || obj.readonly === 'true' ||
      obj.readOnly === true,
  };
}

/** The container path of the `.git` mount derived for a row with container path `target`. */
export function gitDirTarget(target: string): string {
  return `${target}/.git`;
}

/**
 * The three mounts that freeze one repo row's git configuration, in the order they must be
 * declared — parent first.
 *
 * ```
 * type=bind,source=<SOURCE>/.git,target=<TARGET>/.git
 * type=bind,source=<SOURCE>/.git/config,target=<TARGET>/.git/config,readonly
 * type=bind,source=<SOURCE>/.git/hooks,target=<TARGET>/.git/hooks,readonly
 * ```
 *
 * **The first is read-write on purpose.** `config` + `hooks` is the *maximum* that can be frozen:
 * git rewrites config by `config.lock` + rename and takes `*.lock` files all over `.git/`, so
 * `.git/` itself, `refs/`, `objects/` and `logs/` must stay writable or `commit`, `checkout -b`
 * and `pack-refs` all fail. The `.git` mount's only job is to make `.git` a **mountpoint**: a
 * mountpoint cannot be renamed or unlinked (`EBUSY`), and without it `mv .git .git-old` would
 * strand both read-only mounts on a path nothing reads and leave a fresh writable `.git` behind.
 *
 * `source` is folded through {@link foldHome} so the derived specs resolve identically to the row
 * they came from; `target` is used as written, as everywhere else here.
 *
 * One pair on the primary repo covers every **linked worktree** of it, including worktrees created
 * after the container starts: `git config` from inside a linked worktree writes the *common*
 * `.git/config`, and its hooks resolve from the common `.git/hooks`. (`git config --worktree`
 * would escape that, but it is refused without `extensions.worktreeConfig` — which lives in the
 * frozen config and so cannot be bootstrapped from inside.)
 */
export function gitProtectMounts(
  row: MountRow,
  home: string | undefined = process.env.HOME,
): string[] {
  const source = foldHome(row.source, home);
  const gitSource = `${source}/.git`;
  const gitTarget = gitDirTarget(row.target);
  return [
    `type=bind,source=${gitSource},target=${gitTarget}`,
    `type=bind,source=${gitSource}/config,target=${gitTarget}/config,readonly`,
    `type=bind,source=${gitSource}/hooks,target=${gitTarget}/hooks,readonly`,
  ];
}
