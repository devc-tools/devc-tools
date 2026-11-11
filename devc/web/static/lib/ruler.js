// An overview ruler's marks, as VS Code draws along its scrollbar: where in a scrolling view
// each match is, scaled to the ruler's height. The file viewer and diff tiles draw them for the
// selection's other occurrences. Pure: callers measure and draw.

/** A mark's least height, in pixels. */
export const MARK_HEIGHT = 2;

/** The most matches a ruler looks at: past it, the rest go unmarked. */
export const MAX_RULER_MATCHES = 10000;

/**
 * The marks for matches at `fractions` (0 at the top of the content, 1 at its bottom) on a
 * ruler `track` pixels high: each `{top, height}`, in order, touching or overlapping marks
 * merged into one. A fraction outside 0–1 is clamped; one that isn't a number is skipped.
 *
 * @param {readonly number[]} fractions @param {number} track
 * @returns {{top: number, height: number}[]}
 */
export function rulerMarks(fractions, track) {
  if (!(track > 0)) return [];
  const room = Math.max(0, track - MARK_HEIGHT);
  const tops = fractions
    .filter((f) => Number.isFinite(f))
    .map((f) => Math.round(Math.min(1, Math.max(0, f)) * room))
    .sort((a, b) => a - b);
  /** @type {{top: number, height: number}[]} */
  const out = [];
  for (const top of tops) {
    const last = out[out.length - 1];
    if (last && top <= last.top + last.height) {
      last.height = Math.max(last.height, top + MARK_HEIGHT - last.top);
    } else out.push({ top, height: MARK_HEIGHT });
  }
  return out;
}
