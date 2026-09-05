// Applying a project wizard selection to the project's `devc.json` overlay.
//
// The wizard owns exactly two regions of the overlay's `mounts` array: the `devc:source` and
// `devc:skills` fences. Everything else in that file — hand-written mounts, `features`,
// `remoteEnv`, comments — is preserved byte-for-byte by `writeBlocks`, so the file stays a
// perfectly good hand-edited overlay that devc happens to also write two blocks into.
//
// Nothing here touches `.devcontainer/`. Extra bind mounts are machine-specific — another
// checkout of the same repo will not have the same host paths — so they belong in the
// devc-only overlay, which is translated into `devcontainer up` flags and never written into a
// project's config. That makes the standalone invariant (`.devcontainer/` must run without devc
// installed) structural rather than conventional: `devc config` has no code path that writes
// there at all. Scaffolding `.devcontainer/` remains `devc init`'s job.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  loadGlobalConfig,
  makeGlobalConfig,
  saveGlobalConfig,
} from './config.ts';
import {
  findArraySpan,
  UnterminatedFenceError,
  writeBlocks,
} from './jsonc_edit.ts';
import { type MountRow, rowToEntry } from './mounts.ts';
import { resolveProjectOverlayTarget } from './overlay.ts';

/** The wizard's selected mounts for the two managed fences. */
export interface WizardSelection {
  source: MountRow[];
  skills: MountRow[];
}

/** Where the two managed fences live in the file (`findArraySpan(src, "mounts")`). */
const MOUNTS_KEY = 'mounts';

/**
 * Starting text for an overlay devc creates. It has to be a real JSON object with the array
 * already present: `ensureArray` needs a root `{` to splice into, and seeding `mounts` here
 * keeps the created file readable rather than having the key materialize above the comment
 * that explains it.
 */
const NEW_OVERLAY_TEXT = `{
  // Machine-specific devc overlay, managed by \`devc config\`.
  // Also supports "features" and "remoteEnv" — see devc's README.
  "mounts": []
}
`;

/** Rewrite (or insert) the two managed fences in `src`, preserving everything else. */
export function applyFences(src: string, selection: WizardSelection): string {
  return writeBlocks(src, MOUNTS_KEY, [
    { id: 'source', lines: selection.source.map(rowToEntry) },
    { id: 'skills', lines: selection.skills.map(rowToEntry) },
  ]);
}

/** Files written by an apply, for the success message. */
export interface ApplyResult {
  /** True when the project had no overlay at all (the file was created). */
  created: boolean;
  /**
   * True when the apply actually altered the overlay on disk — either it was created, or the
   * rewritten text differs from what was there. False means the selection round-tripped to
   * byte-identical text (e.g. a folder toggled off and back on), the file was left untouched,
   * and the container therefore needs no rebuild.
   */
  changed: boolean;
  /** Absolute path of the written overlay. */
  overlayPath: string;
}

/** Optional overrides for `applySelection` (tests inject scratch paths). */
export interface ApplyDeps {
  /** Global config file path for the `recentSkills` persistence. Defaults to the standard path. */
  globalConfigPath?: string;
}

/**
 * Apply `selection` to `projectDir`'s overlay, resolved by `resolveProjectOverlayTarget` —
 * an existing overlay in place, otherwise a new `.devcontainer/devc.jsonc` (or `.devc/devc.jsonc`
 * when the project has no `.devcontainer/`).
 *
 * Creation writes the seed text first, so the fence splice has an object to work on; the parent
 * directory is created with it. An update rewrites only the two fences on the existing text.
 * When the rewrite yields the exact bytes already on disk, the file is not written at all and
 * `changed` is false.
 *
 * Then the applied skills host paths are persisted to `recentSkills` in the global config.
 */
export async function applySelection(
  projectDir: string,
  selection: WizardSelection,
  deps: ApplyDeps = {},
): Promise<ApplyResult> {
  const target = await resolveProjectOverlayTarget(projectDir);

  const baseText = target.creating
    ? NEW_OVERLAY_TEXT
    : await readFile(target.path, 'utf8');

  let out: string;
  try {
    out = applyFences(baseText, selection);
  } catch (e) {
    if (e instanceof UnterminatedFenceError) {
      throw new Error(
        `${target.path}: ${e.message} (fix or remove the half-written fence)`,
      );
    }
    throw e;
  }

  // An apply that produces the same bytes leaves the file completely alone — not even its
  // mtime moves — so `devc config` can honestly report "no changes, no rebuild needed".
  const changed = target.creating || out !== baseText;
  if (changed) {
    if (target.creating) {
      await mkdir(dirnameOf(target.path), { recursive: true });
    }
    await writeFile(target.path, out);
  }

  await persistRecentSkills(selection.skills, deps.globalConfigPath);

  return { created: target.creating, changed, overlayPath: target.path };
}

/** Parent directory of an absolute `/`-separated path. */
function dirnameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

/** Store the applied skills host paths (raw) as the remembered list for the next project. */
async function persistRecentSkills(
  skills: MountRow[],
  globalConfigPath?: string,
): Promise<void> {
  const cfg = await loadGlobalConfig(globalConfigPath);
  const recent = skills.map((r) => r.source);
  await saveGlobalConfig(
    makeGlobalConfig(
      cfg.codeRoots,
      cfg.skillsRoots,
      cfg.path,
      cfg.extra,
      recent,
    ),
  );
}

/** Re-export so the wizard loop need not reach past this module. */
export { findArraySpan };
