// `devc web`'s pinned files: repo files kept in the page's Pinned section (a note is just a pinned
// file), in `~/.config/devc/pinned-files.json`. Server-side, not the page's `localStorage`, so a
// browser tab and the devc-desktop window (different origins) show the same pins.
//
// Not pinned projects (`projects.json`'s `pinned`, a project kept in the Containers list) and not
// a preview tile's "Keep open". Code says `file pin`, `pinned_files` or `pinnedFiles`, never a bare
// `pin`, to keep the three apart.

import { dirname } from 'jsr:@std/path';
import { CONFIG_DIR } from '@devc-tools/core/default_config.ts';

export const PINNED_FILES_PATH = `${CONFIG_DIR}/pinned-files.json`;

export interface FilePin {
  /** Stable id, generated at pin time (crypto.randomUUID()). */
  id: string;
  /** The project (its host `localFolder`) the file belongs to. */
  localFolder: string;
  /** The repo folder `path` is relative to (as in `open_file`'s `root`). */
  root: string;
  path: string;
  /** Shown instead of the basename when set. */
  label?: string;
  /** The editor pane last opened for it: a hint, checked before use. */
  last?: { containerId: string; paneId: string };
}

export interface PinnedFilesFile {
  version: 1;
  pins: FilePin[];
}

function isLast(v: unknown): v is FilePin['last'] {
  if (typeof v !== 'object' || v === null) return false;
  const l = v as Record<string, unknown>;
  return typeof l.containerId === 'string' && l.containerId !== '' &&
    typeof l.paneId === 'string' && l.paneId !== '';
}

function isFilePin(v: unknown): v is FilePin {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.id === 'string' && p.id !== '' &&
    typeof p.localFolder === 'string' && p.localFolder.startsWith('/') &&
    typeof p.root === 'string' && p.root.startsWith('/') &&
    typeof p.path === 'string' && p.path !== '' &&
    (p.label === undefined || typeof p.label === 'string') &&
    (p.last === undefined || isLast(p.last));
}

/** Missing or unreadable file → []. Drops malformed and repeated entries; never throws. */
export async function readPinnedFiles(
  path = PINNED_FILES_PATH,
): Promise<FilePin[]> {
  let data: unknown;
  try {
    data = JSON.parse(await Deno.readTextFile(path));
  } catch {
    return [];
  }
  const pins = (data as { pins?: unknown } | null)?.pins;
  if (!Array.isArray(pins)) return [];
  const ids = new Set<string>();
  const files = new Set<string>();
  return pins.filter((p): p is FilePin => {
    if (!isFilePin(p)) return false;
    const file = `${p.root}\n${p.path}`;
    if (ids.has(p.id) || files.has(file)) return false;
    ids.add(p.id);
    files.add(file);
    return true;
  }).map(({ id, localFolder, root, path, label, last }) => ({
    id,
    localFolder,
    root,
    path,
    ...(label ? { label } : {}),
    ...(last
      ? { last: { containerId: last.containerId, paneId: last.paneId } }
      : {}),
  }));
}

/**
 * Writes the pins atomically (a temp file renamed over the old one in the same directory), so a
 * reader never sees half a file.
 */
export async function writePinnedFiles(
  pins: FilePin[],
  path = PINNED_FILES_PATH,
): Promise<void> {
  const dir = dirname(path);
  await Deno.mkdir(dir, { recursive: true });
  const tmp = await Deno.makeTempFile({ dir, prefix: '.pinned-files-' });
  try {
    const file: PinnedFilesFile = { version: 1, pins };
    await Deno.writeTextFile(tmp, JSON.stringify(file, null, 2) + '\n');
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}

/**
 * Pins a file, appended last. Pinning the same `(root, path)` again changes nothing and gives the
 * existing pin's id. Pure.
 */
export function addFilePin(
  pins: FilePin[],
  file: { localFolder: string; root: string; path: string; label?: string },
  newId: () => string = () => crypto.randomUUID(),
): { pins: FilePin[]; id: string } {
  const found = pins.find((p) => p.root === file.root && p.path === file.path);
  if (found) return { pins, id: found.id };
  const id = newId();
  return {
    pins: [...pins, {
      id,
      localFolder: file.localFolder,
      root: file.root,
      path: file.path,
      ...(file.label ? { label: file.label } : {}),
    }],
    id,
  };
}

/** Changes the pin `id` with `change`; null when there is no such pin. Pure. */
export function updateFilePin(
  pins: FilePin[],
  id: string,
  change: (pin: FilePin) => FilePin,
): FilePin[] | null {
  if (!pins.some((p) => p.id === id)) return null;
  return pins.map((p) => p.id === id ? change(p) : p);
}

/** Sets a pin's label, or clears it with `''`. */
export function withLabel(pin: FilePin, label: string): FilePin {
  const { label: _, ...rest } = pin;
  return label === '' ? rest : { ...rest, label };
}

/** What the page is sent: everything but `last`, which only the server checks. */
export function pinnedFilesMessage(pins: FilePin[]) {
  return {
    type: 'pinned_files',
    pins: pins.map(({ last: _, ...pin }) => pin),
  };
}

/**
 * The pane `open_pinned` may reuse: the pin's `last`, when it names this container and the pane is
 * in its session's current pane list (`panes`, the snapshot's). Null means create a new one.
 */
export function reusablePinnedPane(
  last: FilePin['last'],
  containerId: string,
  panes: readonly { pane_id?: unknown; tab_id?: unknown }[],
): { pane_id: string; tab_id: string } | null {
  if (!last || last.containerId !== containerId) return null;
  const pane = panes.find((p) => p.pane_id === last.paneId);
  if (!pane) return null;
  return {
    pane_id: last.paneId,
    tab_id: typeof pane.tab_id === 'string' ? pane.tab_id : '',
  };
}
