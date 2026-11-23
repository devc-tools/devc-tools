// Pure helpers for the `devc web` context menu, shared with the Deno tests
// (`devc/tests/web_menu_test.ts`). No DOM access here.

/**
 * A menu's items with dividers (`null`) only between groups: a divider that is first, last, or
 * directly after another one is dropped, so a group that came out empty leaves no stray line.
 *
 * @template T
 * @param {(T | null)[]} items
 * @returns {(T | null)[]}
 */
export function trimDividers(items) {
  /** @type {(T | null)[]} */
  const out = [];
  for (const item of items) {
    if (item === null && (out.length === 0 || out[out.length - 1] === null)) {
      continue;
    }
    out.push(item);
  }
  if (out[out.length - 1] === null) out.pop();
  return out;
}

/**
 * A menu's groups, in the order every menu shows them: what a group holds is the same kind of
 * item wherever it appears, so the same action is found in the same place.
 *
 * - `preview`: a rendered view of a file (Preview, Open as text)
 * - `open`: every "Open …": in this page, then a terminal, then this machine, then the web
 * - `act`: what acts on the thing itself (Save, Reload, Stage, Push, Start, Ask agent…)
 * - `create`: something new in it or beside it (New file…, New worktree…, Split)
 * - `copy`: copying its paths, ids or text
 * - `organize`: this page's own state (Pin, Tag…, Keep open, Reveal in …, Refresh, Zen mode)
 * - `rename`: Rename…
 * - `close`: closing, unpinning, deleting and removing, always last
 */
export const MENU_GROUPS = /** @type {const} */ ([
  'preview',
  'open',
  'act',
  'create',
  'copy',
  'organize',
  'rename',
  'close',
]);

/**
 * @template T
 * @typedef {Partial<Record<typeof MENU_GROUPS[number], (T | null)[]>>} MenuGroups
 */

/**
 * One menu from any number of {@link MenuGroups}: each group's items from every part in turn
 * (a part's order kept), the groups in {@link MENU_GROUPS} order with a divider between them. A
 * `null` inside a group is a divider within it; empty groups leave none.
 *
 * @template T
 * @param {...(MenuGroups<T> | null | undefined)} parts
 * @returns {(T | null)[]}
 */
export function menuOf(...parts) {
  /** @type {(T | null)[]} */
  const out = [];
  for (const group of MENU_GROUPS) {
    out.push(null);
    for (const part of parts) {
      const items = part?.[group];
      if (items) out.push(...items);
    }
  }
  return trimDividers(out);
}
