// Pure helpers for rendered views of a file's text (Markdown first): which files have one in a
// diff tile, each rendered block's source lines, and a patch's changes per block. Shared with the
// Deno tests (`devc/tests/web_rendered_test.ts`); `viewer.js` renders, `tiles.js` draws.

import { mediaKind } from './media.js';

/**
 * A file kind with a rendered view in diff tiles (**Preview** on a diff), by extension: `null`
 * for none. Every check of whether a diff can be previewed goes through this; a further kind adds
 * itself here, as a media kind in `media.js`, and as a branch in the views.
 *
 * @param {string} path
 * @returns {'markdown' | null}
 */
export function renderedKind(path) {
  return mediaKind(path) === 'markdown' ? 'markdown' : null;
}

/**
 * The source lines (1-based, inclusive) of each of a text's top-level tokens, from their `raw`
 * texts in order (they add up to the text). A token of nothing but newlines and blanks (a gap
 * between blocks) has `null`. Leading newlines and trailing blank lines don't count.
 *
 * @param {string[]} raws
 * @returns {({from: number, to: number} | null)[]}
 */
export function blockLines(raws) {
  let line = 1;
  return raws.map((raw) => {
    const lead = /^(?:[ \t]*\n)*/.exec(raw)?.[0] ?? '';
    const body = raw.slice(lead.length).replace(/\s+$/, '');
    const at = line + newlines(lead);
    line += newlines(raw);
    return body === '' ? null : { from: at, to: at + newlines(body) };
  });
}

/** @param {string} s */
function newlines(s) {
  let n = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

/**
 * A patch's changes as new-side lines: the lines it adds, and where it deletes lines without
 * adding any in their place (the new-side line the deletion sits before, `lines + 1` at the
 * end, to how many lines go). Notes (`\ No newline`) are not lines.
 *
 * @param {import('./diff.js').ParsedPatch} parsed
 * @returns {{added: Set<number>, deleted: Map<number, number>}}
 */
export function changeMarks(parsed) {
  /** @type {Set<number>} */
  const added = new Set();
  /** @type {Map<number, number>} */
  const deleted = new Map();
  for (const hunk of parsed.hunks) {
    // A hunk with no new lines names the line before its place.
    let next = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
    let dels = 0;
    let adds = 0;
    const endRun = () => {
      if (dels > 0 && adds === 0) {
        deleted.set(next, (deleted.get(next) ?? 0) + dels);
      }
      dels = 0;
      adds = 0;
    };
    for (const row of hunk.rows) {
      if (row.kind === 'note') continue;
      if (row.kind === 'del') {
        dels++;
        continue;
      }
      if (row.kind === 'add') {
        adds++;
        if (row.new !== null) {
          added.add(row.new);
          next = row.new + 1;
        }
        continue;
      }
      endRun();
      if (row.new !== null) next = row.new + 1;
    }
    endRun();
  }
  return { added, deleted };
}

/**
 * Each rendered block's marks from {@link changeMarks}: `add` when one of its lines was added,
 * `deleted` the lines removed just before it (or in the gap before it). `end`: lines removed
 * after the last block.
 *
 * @param {({from: number, to: number} | null)[]} blocks
 * @param {{added: Set<number>, deleted: Map<number, number>}} marks
 * @returns {{blocks: {add: boolean, deleted: number}[], end: number}}
 */
export function blockMarks(blocks, marks) {
  const out = blocks.map(() => ({ add: false, deleted: 0 }));
  blocks.forEach((b, i) => {
    if (!b) return;
    for (let line = b.from; line <= b.to; line++) {
      if (marks.added.has(line)) {
        out[i].add = true;
        break;
      }
    }
  });
  let end = 0;
  for (const [line, n] of marks.deleted) {
    const i = blocks.findIndex((b) => b !== null && b.to >= line);
    if (i === -1) end += n;
    else out[i].deleted += n;
  }
  return { blocks: out, end };
}

/**
 * A heading's anchor as GitHub makes it: lower case, punctuation dropped, spaces as `-`; a
 * repeat gets `-1`, `-2`, … (`seen` counts them per document).
 *
 * @param {string} text
 * @param {Map<string, number>} seen
 */
export function slug(text, seen) {
  const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
  const n = seen.get(base);
  seen.set(base, (n ?? -1) + 1);
  return n === undefined ? base : `${base}-${n + 1}`;
}
