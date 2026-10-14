// The `devc config` orchestrator: a thin imperative shell (like `main.ts`) that wires the
// folder picker + confirm prompt to the pure seed/apply logic. It replaces the old full-screen
// step wizard. All IO is injected via `FlowDeps` so the whole flow is scriptable headlessly
// (see `tests/config_flow_test.ts`); the real entry points build deps over the actual TTY.
//
// Two flows live here:
//   • project  — pick source folders, pick skills folders, review, apply to the `devc.json`
//                overlay (never to `.devcontainer/` — see `wizard_apply.ts`).
//   • global   — first-run: pick code roots then skills roots, stored folded to `~/…`.
// Both are fully picker-driven: you *select* folders, never type paths.

import { resolve } from 'jsr:@std/path@^1';
import {
  displayPath,
  expandPath,
  type GlobalConfig,
  globalConfigExists,
  loadGlobalConfig,
  makeGlobalConfig,
  saveGlobalConfig,
} from '@devc-tools/core/config.ts';
import {
  type OverlayTarget,
  resolveProjectOverlayTarget,
} from '@devc-tools/core/overlay.ts';
import {
  assertNoDuplicateTarget,
  basename,
  defaultTarget,
  DuplicateTargetError,
  foldHome,
  type MountKind,
  type MountRow,
  parseEntries,
  rowForHostPath,
  serializeMount,
} from '@devc-tools/core/mounts.ts';
import {
  type ApplyDeps,
  type ApplyResult,
  applySelection,
  repoOverlaySeedText,
  type WizardSelection,
} from '@devc-tools/core/wizard_apply.ts';
import {
  type ContainerStatus,
  getContainerStatus,
  rebuildContainer,
} from '../container.ts';
import {
  findArraySpan,
  findFence,
  parseFenceEntries,
} from '@devc-tools/core/jsonc_edit.ts';
import {
  type FsProbe,
  longestRootAncestor,
  realFsProbe,
  resolvePickedMounts,
  resolveWorktree,
} from '@devc-tools/core/worktree.ts';
import {
  type DerivedEntry,
  type EntryFlag,
  type PickerDeps,
  pickFolders,
} from './folder_picker.ts';
import { runConfirm } from './prompts.ts';
import type { Size } from './term.ts';

export interface WizardIo {
  err: (msg: string) => void;
}

/** Injected IO for the whole flow. Real runs fill these from the TTY; tests script them. */
export interface FlowDeps {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  size: () => Size;
  /** Enter raw mode + alternate screen for the pickers. Off in tests. */
  raw?: boolean;
  /** List subdirectory names of a path. Defaults to the picker's real-filesystem lister. */
  readDir?: (path: string) => Promise<string[]>;
  isTerminal?: () => boolean;
  err?: (msg: string) => void;
  /** Apply the selection. Defaults to `applySelection` (real writes). */
  apply?: (
    dir: string,
    sel: WizardSelection,
    opts?: ApplyDeps,
  ) => Promise<ApplyResult>;
  /** Filesystem probe for worktree resolution. Defaults to `realFsProbe`. */
  fsProbe?: FsProbe;
  /**
   * Look up the project's container status, to word the post-apply rebuild prompt. Omitted
   * (tests, no-Docker contexts) ⇒ the flow reports that a rebuild is needed but does not offer
   * to run one.
   */
  containerStatus?: (dir: string) => Promise<ContainerStatus>;
  /**
   * Recreate the container, resolving to a one-line summary for the flow to print. Throws on
   * failure. Omitted ⇒ no rebuild is offered (see `containerStatus`).
   */
  rebuild?: (dir: string) => Promise<string>;
}

function pickerDeps(deps: FlowDeps): PickerDeps {
  return {
    input: deps.input,
    output: deps.output,
    size: deps.size,
    raw: deps.raw,
    readDir: deps.readDir,
    isTerminal: deps.isTerminal,
    err: deps.err,
  };
}

async function writeLines(
  output: WritableStream<Uint8Array>,
  lines: string[],
): Promise<void> {
  const w = output.getWriter();
  try {
    await w.write(new TextEncoder().encode(lines.join('\n') + '\n'));
  } finally {
    w.releaseLock();
  }
}

const HOME = () => Deno.env.get('HOME') ?? Deno.cwd();

/**
 * Expand a stored mount `source` to an absolute path for pre-ticking in the picker. Handles the
 * devcontainer `${localEnv:HOME}` form as well as shell `~`/`$VAR`. Returns null when it cannot
 * be resolved (an unset variable), so that row is simply not pre-ticked.
 */
function expandToAbsolute(source: string): string | null {
  let s = source;
  if (s.includes('${localEnv:HOME}')) {
    const home = Deno.env.get('HOME');
    if (!home) return null;
    s = s.replaceAll('${localEnv:HOME}', home);
  }
  try {
    return resolve(expandPath(s));
  } catch {
    return null;
  }
}

/** Build rows for `kind` from picked absolute paths, skipping any duplicate target. */
function buildRows(
  kind: MountKind,
  paths: string[],
  warn: (msg: string) => void,
): MountRow[] {
  const rows: MountRow[] = [];
  for (const p of paths) {
    const row = rowForHostPath(kind, p);
    try {
      assertNoDuplicateTarget(rows, row);
      rows.push(row);
    } catch (e) {
      if (e instanceof DuplicateTargetError) {
        warn(`  skipped ${p} — target ${row.target} already in use`);
      } else {
        throw e;
      }
    }
  }
  return rows;
}

/**
 * Build source rows from picked absolute paths. Each folder's container target keeps its sub-path
 * under the base `resolvePickedMounts` gives it (so `~/code/a/b` under root `~/code` →
 * `/workspaces/a/b`). A picked git worktree additionally contributes a mount of its primary repo's
 * `.git`, mirrored from that same base — one helper decides both, so what gets written is exactly
 * what the picker showed under that pick.
 *
 * Rows are then grouped per repo — its `.git` mount, its own working tree if that was picked too,
 * then the worktrees behind it — so a repo reads as one block however the picks were interleaved. A
 * group sits where its first pick did, and picks belonging to no repo keep pick order.
 */
async function buildSourceRows(
  paths: string[],
  codeRoots: string[],
  warn: (msg: string) => void,
  fs: FsProbe,
): Promise<MountRow[]> {
  const rows: MountRow[] = [];
  const add = (row: MountRow, onDup: () => void): void => {
    try {
      assertNoDuplicateTarget(rows, row);
      rows.push(row);
    } catch (e) {
      if (e instanceof DuplicateTargetError) onDup();
      else throw e;
    }
  };

  // A pending row plus where it sits inside its group: `.git` mount, then the repo's own working
  // tree, then its worktrees. A pick belonging to no repo keys on its own path — a group of one.
  interface Entry {
    row: MountRow;
    rank: 0 | 1 | 2;
    onDup: () => void;
  }
  const groups = new Map<string, Entry[]>();
  const order: string[] = [];
  const push = (key: string, entry: Entry): void => {
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [entry]);
      order.push(key); // first pick of a repo fixes where its whole block goes
    } else {
      group.push(entry);
    }
  };

  for (const m of await resolvePickedMounts(paths, codeRoots, fs)) {
    const key = m.repo ?? m.path;
    if (m.primary !== undefined) {
      push(key, {
        row: { source: foldHome(m.primary.gitDir), target: m.primary.target },
        rank: 0,
        onDup: () => {}, // already covered by an earlier row → mount it once, silently
      });
    }
    push(key, {
      row: rowForHostPath('source', m.path, m.base),
      rank: m.path === key ? 1 : 2,
      onDup: () => warn(`  skipped ${m.path} — target already in use`),
    });
  }

  for (const key of order) {
    // Stable, so worktrees of one repo stay in the order they were picked.
    for (const e of groups.get(key)!.sort((a, b) => a.rank - b.rank)) {
      add(e.row, e.onDup);
    }
  }
  return rows;
}

function reviewLines(sel: WizardSelection, projectDir: string): string[] {
  const lines: string[] = ['', 'Review:'];
  // `note` is a mount the container makes on its own (the project folder) — it isn't written to
  // the fence, but listing it keeps an empty source fence from reading as "no source mounts".
  const block = (title: string, rows: MountRow[], note?: string) => {
    lines.push(`  ${title}`);
    if (note) lines.push(`    ${note}`);
    if (rows.length === 0 && note === undefined) lines.push('    (none)');
    for (const r of rows) lines.push(`    ${serializeMount(r)}`);
  };
  block(
    'devc:source',
    sel.source,
    `${foldHome(projectDir)} — this project (always mounted)`,
  );
  block('devc:skills', sel.skills);
  // Stated at the point of decision, not only in the README: overlay mounts become
  // `devcontainer up --mount` args, and that flag has no read-only form at all.
  lines.push(
    '  Note: overlay mounts are read-write — `devcontainer up --mount` cannot',
    '  express read-only. See devc’s README.',
  );
  return lines;
}

export interface ProjectFlowOptions {
  projectDir: string;
  /** Overlay file the apply will write (`resolveProjectOverlayTarget`). */
  overlayPath: string;
  /** True when that overlay does not exist yet and will be created. */
  creating: boolean;
  /**
   * Set for `devc config --repo`: the repo's common git dir. `overlayPath` is then the repo
   * overlay, shared by every checkout of that repo, rather than the project's own.
   */
  repoCommonDir?: string;
  sourceRows: MountRow[];
  skillsRows: MountRow[];
  /** Expanded (absolute) code roots — where the source picker opens. */
  codeRoots: string[];
  /** Expanded (absolute) skills roots — where the skills picker opens. */
  skillsRoots: string[];
  color: boolean;
}

/** Outcome of a flow run. */
export interface FlowResult {
  applied: boolean;
  /** Whether the apply actually altered the config on disk (see `ApplyResult.changed`). */
  changed: boolean;
  /** Whether a container rebuild was run as part of this flow. */
  rebuilt: boolean;
}

/** The testable project-config flow core. */
export async function runProjectFlow(
  opts: ProjectFlowOptions,
  deps: FlowDeps,
): Promise<FlowResult> {
  const apply = deps.apply ?? applySelection;
  const warn = deps.err ?? ((m: string) => console.error(m));
  const fs = deps.fsProbe ?? realFsProbe;

  const repoNote = opts.repoCommonDir === undefined
    ? ''
    : ` repo overlay, shared by every checkout of ${
      displayPath(opts.repoCommonDir)
    }`;
  await writeLines(deps.output, [
    `Configuring devc mounts at ${opts.overlayPath}`,
    `  (${
      opts.creating
        ? `creating a new${repoNote || ' overlay'}`
        : `updating the existing${repoNote || ' overlay'}`
    })`,
  ]);

  // Flag each browsed subfolder that is a git worktree whose primary repo can't be mounted.
  const annotateSource = async (
    dir: string,
    names: string[],
  ): Promise<Map<string, EntryFlag>> => {
    const flags = new Map<string, EntryFlag>();
    await Promise.all(names.map(async (name) => {
      const abs = resolve(dir, name);
      const wt = await resolveWorktree(
        abs,
        longestRootAncestor(abs, opts.codeRoots),
        fs,
      );
      if (wt.isWorktree) {
        flags.set(name, {
          worktree: true,
          valid: wt.valid,
          reason: wt.reason,
        });
      }
    }));
    return flags;
  };

  // The primary `.git` mounts the current picks drag in, shown in the picks list as they are
  // ticked. Same helper the mount builder uses, so the two can't disagree — and because the list
  // is rederived from the picks, the only way to drop one is to unpick its worktree.
  const deriveSource = async (selected: string[]): Promise<DerivedEntry[]> => {
    const mounts = await resolvePickedMounts(selected, opts.codeRoots, fs);
    return mounts.filter((m) => m.primary !== undefined).map((m) => ({
      path: m.primary!.gitDir,
      owner: m.path,
      note: `required by worktree ${basename(m.path)}`,
    }));
  };

  const sourcePicked = await pickFolders({
    labels: {
      screen: 'WORKSPACE CONFIG',
      picks: 'Source Folders',
      browse: 'Add Source Folders',
    },
    start: opts.codeRoots[0] ?? HOME(),
    roots: opts.codeRoots.length ? opts.codeRoots : undefined,
    preselected: opts.sourceRows.map((r) => expandToAbsolute(r.source)).filter(
      (p): p is string => p !== null,
    ),
    // The dev container binds the project folder itself, so picking nothing here still mounts
    // it. Show it as a fixed row rather than letting the picker read as zero source mounts.
    pinned: {
      path: resolve(opts.projectDir),
      note: 'this project (always mounted)',
    },
    annotate: annotateSource,
    derive: deriveSource,
    color: opts.color,
  }, pickerDeps(deps));
  if (sourcePicked === null) {
    await writeLines(deps.output, ['Cancelled.']);
    return { applied: false, changed: false, rebuilt: false };
  }

  const skillsPicked = await pickFolders({
    labels: {
      screen: 'WORKSPACE CONFIG',
      picks: 'Skills',
      browse: 'Add Skills',
    },
    start: opts.skillsRoots[0] ?? HOME(),
    roots: opts.skillsRoots.length ? opts.skillsRoots : undefined,
    preselected: opts.skillsRows.map((r) => expandToAbsolute(r.source)).filter(
      (p): p is string => p !== null,
    ),
    color: opts.color,
  }, pickerDeps(deps));
  if (skillsPicked === null) {
    await writeLines(deps.output, ['Cancelled.']);
    return { applied: false, changed: false, rebuilt: false };
  }

  const selection: WizardSelection = {
    source: await buildSourceRows(sourcePicked, opts.codeRoots, warn, fs),
    skills: buildRows('skills', skillsPicked, warn),
  };

  await writeLines(deps.output, reviewLines(selection, opts.projectDir));
  const ok = await runConfirm('Apply?', true, {
    input: deps.input,
    output: deps.output,
    raw: deps.raw,
  });
  if (!ok) {
    await writeLines(deps.output, ['Cancelled — nothing written.']);
    return { applied: false, changed: false, rebuilt: false };
  }

  // Project scope lets `applySelection` resolve the target itself, exactly as before; repo scope
  // must hand it over, or the apply would write the project's own overlay.
  const result = opts.repoCommonDir === undefined
    ? await apply(opts.projectDir, selection)
    : await apply(opts.projectDir, selection, {
      target: { path: opts.overlayPath, creating: opts.creating },
      seedText: repoOverlaySeedText(opts.repoCommonDir),
    });
  await writeLines(deps.output, [
    result.changed
      ? `${result.created ? 'Created' : 'Updated'} ${result.overlayPath}`
      : `Unchanged ${result.overlayPath}`,
  ]);

  const rebuilt = await maybeRebuild(opts.projectDir, result.changed, deps);
  // The rebuild above is this checkout's only; every other worktree's container still has the
  // old config, and devc does not enumerate them.
  if (opts.repoCommonDir !== undefined && result.changed) {
    await writeLines(deps.output, [
      'Other checkouts of this repo pick this up on their next `devc build`.',
    ]);
  }
  return { applied: true, changed: result.changed, rebuilt };
}

/**
 * Post-apply rebuild step. Mounts are bound when the container is *created*, so a changed
 * config only takes effect after a recreate — but a selection that round-tripped to identical
 * bytes needs nothing, and saying otherwise would train the user to ignore the prompt. So the
 * notice and the offer appear only when `changed`.
 */
async function maybeRebuild(
  projectDir: string,
  changed: boolean,
  deps: FlowDeps,
): Promise<boolean> {
  if (!changed) {
    await writeLines(deps.output, ['No config changes — no rebuild needed.']);
    return false;
  }

  // No status lookup / rebuild action (tests), or the lookup itself failed (no docker on
  // PATH, daemon down) ⇒ say what is needed and let the user run it, rather than offering a
  // build that cannot work.
  const status = deps.containerStatus;
  const rebuild = deps.rebuild;
  const state = status === undefined
    ? null
    : await status(projectDir).catch(() => null);
  if (state === null || rebuild === undefined) {
    await writeLines(deps.output, [
      'Config changed — run `devc build` to rebuild the dev container.',
    ]);
    return false;
  }

  const existing = state !== 'missing';
  await writeLines(deps.output, [
    '',
    existing
      ? 'Config changed — the dev container must be rebuilt for the new mounts to take effect.'
      : 'No dev container exists for this project yet.',
  ]);
  const go = await runConfirm(
    existing ? 'Rebuild now?' : 'Build it now?',
    true,
    {
      input: deps.input,
      output: deps.output,
      raw: deps.raw,
    },
  );
  if (!go) {
    await writeLines(deps.output, [
      "Skipped — run `devc build` when you're ready.",
    ]);
    return false;
  }

  // The config is already written, so a failed build is not a failed `devc config`: report it
  // and return normally rather than throwing out of the flow.
  try {
    const summary = await rebuild(projectDir);
    await writeLines(deps.output, [summary]);
    return true;
  } catch (e) {
    (deps.err ?? ((m: string) => console.error(m)))(
      `devc: ${e instanceof Error ? e.message : e}`,
    );
    return false;
  }
}

/** The testable global-roots flow core: pick code roots, then skills roots (stored `~/…`). */
export async function runGlobalFlow(
  cfg: GlobalConfig,
  deps: FlowDeps,
  color: boolean,
): Promise<{ codeRoots: string[]; skillsRoots: string[] } | null> {
  const expandedOrEmpty = (raw: string[]): string[] => {
    try {
      return raw.map(expandPath).map((p) => resolve(p));
    } catch {
      return [];
    }
  };
  await writeLines(deps.output, [
    'Configure roots — pick your code folder root(s), then your skills root(s).',
    'These scope where the project pickers can select from.',
  ]);

  const codePre = expandedOrEmpty(cfg.codeRoots);
  const codeAbs = await pickFolders({
    labels: {
      screen: 'GLOBAL CONFIG',
      picks: 'Source Folder Roots',
      browse: 'Add Roots',
    },
    start: codePre[0] ?? HOME(),
    preselected: codePre,
    color,
  }, pickerDeps(deps));
  if (codeAbs === null) return null;

  const skillsPre = expandedOrEmpty(cfg.skillsRoots);
  const skillsAbs = await pickFolders({
    labels: {
      screen: 'GLOBAL CONFIG',
      picks: 'Skills Folder Roots',
      browse: 'Add Roots',
    },
    start: skillsPre[0] ?? HOME(),
    preselected: skillsPre,
    color,
  }, pickerDeps(deps));
  if (skillsAbs === null) return null;

  return {
    codeRoots: codeAbs.map(displayPath),
    skillsRoots: skillsAbs.map(displayPath),
  };
}

// ── seeding (relocated from the old wizard.ts) ──────────────────────────────────

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Seed the source/skills rows from the overlay text's fences. If it has no fences, source
 * starts empty and skills is pre-seeded from `recentSkillsRaw` (filtered to host paths that
 * still exist; raw stored values are expanded for the check).
 *
 * `baseText` is the overlay's current contents, or the empty string when there is no overlay
 * yet — never a `devcontainer.json`. Fences left in a project's config by an older devc are
 * not read and not migrated; they are deleted by hand.
 */
export async function seedRows(
  baseText: string,
  recentSkillsRaw: string[],
): Promise<{ sourceRows: MountRow[]; skillsRows: MountRow[] }> {
  const span = findArraySpan(baseText, 'mounts');
  const hasFence = (id: string) =>
    span !== null && findFence(baseText, span, id) !== null;
  const hadFences = hasFence('source') || hasFence('skills');

  const sourceRows = span === null
    ? []
    : parseEntries(parseFenceEntries(baseText, span, 'source'));
  let skillsRows = span === null
    ? []
    : parseEntries(parseFenceEntries(baseText, span, 'skills'));

  if (!hadFences) {
    skillsRows = [];
    for (const raw of recentSkillsRaw) {
      let expanded: string;
      try {
        expanded = expandPath(raw);
      } catch {
        continue;
      }
      if (!(await pathExists(expanded))) continue;
      const folded = foldHome(raw);
      skillsRows.push({
        source: folded,
        target: defaultTarget('skills', folded),
      });
    }
  }
  return { sourceRows, skillsRows };
}

// ── real-IO entry points (called by main.ts) ────────────────────────────────────

function realDeps(): FlowDeps {
  return {
    input: Deno.stdin.readable,
    output: Deno.stdout.writable,
    size: () => {
      try {
        return Deno.consoleSize();
      } catch {
        return { columns: 80, rows: 24 };
      }
    },
    raw: true,
  };
}

const colorEnabled = (): boolean => {
  const f = Deno.env.get('NO_COLOR');
  return f === undefined || f === '';
};

/** The repo overlay `devc config --repo` writes, as `findRepoOverlay` resolved it. */
export interface RepoScope {
  commonDir: string;
  path: string;
  exists: boolean;
}

/**
 * Open the full project flow for `devc config [PATH]`. Resolves which overlay to write
 * (`resolveProjectOverlayTarget`, or `repo` for `--repo`), seeds the source/skills selections
 * from it, and — when `includeGlobalStep` — runs the global-roots step first.
 */
export async function runProjectConfigWizard(
  projectDir: string,
  io: WizardIo,
  includeGlobalStep: boolean,
  repo?: RepoScope,
): Promise<void> {
  const deps: FlowDeps = {
    ...realDeps(),
    err: io.err,
    containerStatus: getContainerStatus,
    rebuild: async (dir) => {
      console.log(`Rebuilding dev container for ${dir}...`);
      const info = await rebuildContainer(dir);
      return `${info.containerId} running — workspace ${info.remoteWorkspaceFolder}`;
    },
  };

  // Bounded pickers need roots as their top level, so ensure roots exist first: on an explicit
  // first run, or whenever either root list is empty/unresolvable.
  let cfg = await loadGlobalConfig();
  const rootsMissing =
    safeExpanded(() => cfg.codeRootsExpanded()).length === 0 ||
    safeExpanded(() => cfg.skillsRootsExpanded()).length === 0;
  if (includeGlobalStep || rootsMissing) {
    await runGlobalConfigWizard(io);
    cfg = await loadGlobalConfig();
  }

  const target: OverlayTarget = repo === undefined
    ? await resolveProjectOverlayTarget(projectDir)
    : { path: repo.path, creating: !repo.exists };
  const baseText = target.creating ? '' : await Deno.readTextFile(target.path);

  const { sourceRows, skillsRows } = await seedRows(baseText, cfg.recentSkills);

  await runProjectFlow({
    projectDir,
    overlayPath: target.path,
    creating: target.creating,
    repoCommonDir: repo?.commonDir,
    sourceRows,
    skillsRows,
    codeRoots: safeExpanded(() => cfg.codeRootsExpanded()),
    skillsRoots: safeExpanded(() => cfg.skillsRootsExpanded()),
    color: colorEnabled(),
  }, deps);
}

function safeExpanded(fn: () => string[]): string[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

/**
 * Run the first-run global-roots step, seeded from the current on-disk config, and save the
 * result (preserving `recentSkills` and any unknown keys). No-op save when cancelled.
 */
export async function runGlobalConfigWizard(io: WizardIo): Promise<void> {
  const deps = { ...realDeps(), err: io.err };
  const cfg = await loadGlobalConfig();
  const picked = await runGlobalFlow(cfg, deps, colorEnabled());
  if (picked === null) return;
  await saveGlobalConfig(
    makeGlobalConfig(
      picked.codeRoots,
      picked.skillsRoots,
      cfg.path,
      cfg.extra,
      cfg.recentSkills,
    ),
  );
}

/** Re-export so `main.ts` need not reach past this module to the config layer. */
export { globalConfigExists };
