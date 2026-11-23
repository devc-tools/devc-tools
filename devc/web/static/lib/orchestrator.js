// The orchestrator panel's pure parts (`.plans/devc-web-orchestrator.md`): which pane is a
// container's orchestrator (left out of every list of terminals and agents), what the panel keeps
// per browser, which container it shows, and devc-desktop's `#…&orchestrator=<nonce>`.

/** The orchestrator's folder under its container's `$HOME` (`orchestrator.ts`'s). */
export const ORCHESTRATOR_HOME_SUBDIR = '.local/share/devc-orchestrator';

/**
 * Whether a snapshot pane is a container's orchestrator: its `cwd` (the shell's, not
 * `foreground_cwd`) is the orchestrator's folder.
 *
 * @param {{cwd?: unknown} | null | undefined} pane
 */
export function isOrchestratorPane(pane) {
  const cwd = pane?.cwd;
  return typeof cwd === 'string' &&
    cwd.replace(/\/+$/, '').endsWith(`/${ORCHESTRATOR_HOME_SUBDIR}`);
}

/** `localStorage` keys: the panel's open state, width and last container (`localFolder`). */
export const ORCHESTRATOR_OPEN_KEY = 'orchestratorOpen';
export const ORCHESTRATOR_WIDTH_KEY = 'orchestratorWidth';
export const ORCHESTRATOR_CONTAINER_KEY = 'orchestratorContainer';

export const ORCHESTRATOR_MIN_WIDTH = 280;
export const ORCHESTRATOR_DEFAULT_WIDTH = 420;
/** Narrower than this left for the tiles, the panel lies over them instead. */
export const ORCHESTRATOR_MIN_TILES = 480;

/**
 * The panel's width for an area `room` px wide: at least the minimum, at most what leaves the
 * tiles their minimum (and never more than the area).
 *
 * @param {number} width
 * @param {number} room
 */
export function clampOrchestratorWidth(width, room) {
  const w = Number.isFinite(width) ? width : ORCHESTRATOR_DEFAULT_WIDTH;
  const max = Math.max(ORCHESTRATOR_MIN_WIDTH, room - ORCHESTRATOR_MIN_TILES);
  return Math.round(Math.min(Math.max(w, ORCHESTRATOR_MIN_WIDTH), max, room));
}

/**
 * Whether the panel lies over the tiles: the area can't hold both.
 *
 * @param {number} width  the panel's width
 * @param {number} room   the area's
 */
export function orchestratorOverlays(width, room) {
  return room - width < ORCHESTRATOR_MIN_TILES;
}

/**
 * The container the panel shows: the one saved (by `localFolder`), else the focused tile's, else
 * the first; null with none running. Host sessions have no orchestrator.
 *
 * @template {{id: string, kind?: string, localFolder: string}} C
 * @param {C[]} running
 * @param {string | null} saved
 * @param {string | null} focused  the focused tile's `localFolder`
 * @returns {C | null}
 */
export function pickOrchestratorContainer(running, saved, focused) {
  const list = running.filter((c) => c.kind !== 'host');
  return list.find((c) => c.localFolder === saved) ??
    list.find((c) => c.localFolder === focused) ?? list[0] ?? null;
}

/**
 * Whether an orchestrator pane waits on the person (the button's dot).
 *
 * @param {{agent_status?: unknown} | null | undefined} pane
 */
export function orchestratorWaiting(pane) {
  return pane?.agent_status === 'blocked' || pane?.agent_status === 'done';
}

/**
 * devc-desktop's **View → Orchestrator**: `#…&orchestrator=<nonce>`, a fresh nonce each time so
 * the hash changes. The nonce, or null without one.
 *
 * @param {string} hash
 */
export function orchestratorToggleFromHash(hash) {
  const v = new URLSearchParams(hash.replace(/^#/, '')).get('orchestrator');
  return v ? v : null;
}

/**
 * `hash` without its `orchestrator` parameter.
 *
 * @param {string} hash
 */
export function withoutOrchestratorToggle(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  params.delete('orchestrator');
  const rest = params.toString();
  return rest ? `#${rest}` : '';
}
