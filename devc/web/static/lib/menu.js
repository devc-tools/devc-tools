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
