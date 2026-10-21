// Text surgery on JSONC files we do not own (devcontainer.json, *.code-workspace).
//
// These files are hand-maintained: they carry comments, deliberate formatting, and keys
// devc knows nothing about. So we never parse-and-reserialize — every edit is a
// byte-level splice guided by a small scanner that understands string literals (with
// escapes), `//` and `/* */` comments, and bracket depth. Anything outside the fenced
// block devc owns comes out of a write byte-for-byte identical.
//
// The one thing we normalize globally (per array) is commas: a fence can land first,
// last, or between user elements, and JSONC tolerates a trailing comma while strict
// JSON.parse does not. `normalizeArrayCommas` recomputes element spans and inserts or
// removes only comma characters, right-to-left so earlier offsets stay valid.

/** Offsets of an array's `[` and its matching `]`. */
export interface ArraySpan {
  /** Offset of `[`. */
  open: number;
  /** Offset of the matching `]`. */
  close: number;
}

/** Half-open `[start, end)` offsets of one array element, trivia excluded. */
export interface ElementSpan {
  start: number;
  end: number;
}

/** Offsets of a fence pair: the `//` open line and the `//` close line. */
export interface FenceSpan {
  /** Offset of the first character of the open-fence line (its indentation). */
  openLineStart: number;
  /** Offset just past the open-fence line's newline (or its end at EOF). */
  openLineEnd: number;
  /** Offset of the first character of the close-fence line. */
  closeLineStart: number;
  /** Offset of the close-fence line's end (before its newline). */
  closeLineEnd: number;
}

/** An open fence with no close after it — the file is not safe to rewrite. */
export class UnterminatedFenceError extends Error {
  constructor(public readonly fenceId: string) {
    super(`unterminated devc:${fenceId} fence`);
    this.name = 'UnterminatedFenceError';
  }
}

/** Full fence id, e.g. `devc:projects`. */
export function fenceId(id: string): string {
  return `devc:${id}`;
}

function openFenceRe(id: string): RegExp {
  return new RegExp(`^[ \\t]*//[ \\t]*>>>[ \\t]*devc:${escapeRe(id)}\\b`, 'm');
}

function closeFenceRe(id: string): RegExp {
  return new RegExp(
    `^[ \\t]*//[ \\t]*<<<[ \\t]*devc:${escapeRe(id)}[ \\t]*$`,
    'm',
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- scanner -------------------------------------------------------------------

type Trivia = 'code' | 'space' | 'comment';

/**
 * Classify every character of `src` once: code, whitespace, or comment. Strings count as
 * code, so a `],` or `//` *inside* a string never confuses the callers. This is the single
 * place that has to get JSONC lexing right.
 */
function classify(src: string): Uint8Array {
  const KIND = { code: 0, space: 1, comment: 2 } as const;
  const out = new Uint8Array(src.length);
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      const start = i;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      out.fill(KIND.code, start, i);
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const start = i;
      while (i < src.length && src[i] !== '\n') i++;
      out.fill(KIND.comment, start, i);
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(i + 2, src.length);
      out.fill(KIND.comment, start, i);
      continue;
    }
    out[i] = /\s/.test(c) ? KIND.space : KIND.code;
    i++;
  }
  return out;
}

function kindAt(kinds: Uint8Array, i: number): Trivia {
  return kinds[i] === 0 ? 'code' : kinds[i] === 1 ? 'space' : 'comment';
}

/** First offset in `[from, to)` that is code, or `to`. */
function nextCode(kinds: Uint8Array, from: number, to: number): number {
  let i = from;
  while (i < to && kindAt(kinds, i) !== 'code') i++;
  return i;
}

/** Strip `//` and `/* *\/` comments, preserving every other byte (so offsets of the
 * remaining text line up line-for-line). Used to hand JSONC to `JSON.parse`. */
export function stripComments(src: string): string {
  const kinds = classify(src);
  let out = '';
  for (let i = 0; i < src.length; i++) {
    out += kindAt(kinds, i) === 'comment'
      ? (src[i] === '\n' ? '\n' : ' ')
      : src[i];
  }
  return out;
}

/**
 * Blank every comma that only trivia separates from a closing `]` or `}` (a trailing comma),
 * preserving every other byte. Strings are code to the scanner, so a `,]` inside one stays.
 */
export function stripTrailingCommas(src: string): string {
  const kinds = classify(src);
  let out = '';
  for (let i = 0; i < src.length; i++) {
    if (src[i] === ',' && kindAt(kinds, i) === 'code') {
      const next = nextCode(kinds, i + 1, src.length);
      if (src[next] === ']' || src[next] === '}') {
        out += ' ';
        continue;
      }
    }
    out += src[i];
    if (src[i] === '"' && kindAt(kinds, i) === 'code') {
      // Copy the whole string literal, so a comma inside it is never looked at.
      const end = stringEnd(src, i);
      out += src.slice(i + 1, end);
      i = end - 1;
    }
  }
  return out;
}

/**
 * Parse JSONC: `//` and `/* *\/` comments and trailing commas allowed (we never emit a trailing
 * comma, but a hand-edited file — `~/.config/devc/config.jsonc` — may have one). Throws
 * `JSON.parse`'s `SyntaxError` for anything else.
 */
export function parseJsonc(src: string): unknown {
  return JSON.parse(stripTrailingCommas(stripComments(src)));
}

// --- queries -------------------------------------------------------------------

/**
 * Offsets of the array value of a **top-level** `key` in the root object, or null when the
 * key is absent or is not an array.
 */
export function findArraySpan(src: string, key: string): ArraySpan | null {
  const kinds = classify(src);
  const needle = JSON.stringify(key);
  let depth = 0;
  let i = 0;
  while (i < src.length) {
    if (kindAt(kinds, i) !== 'code') {
      i++;
      continue;
    }
    const c = src[i];
    if (c === '{' || c === '[') {
      depth++;
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      depth--;
      i++;
      continue;
    }
    if (c === '"') {
      const end = stringEnd(src, i);
      // Only a key at depth 1 (directly in the root object) counts.
      if (depth === 1 && src.slice(i, end) === needle) {
        const colon = nextCode(kinds, end, src.length);
        if (src[colon] === ':') {
          const open = nextCode(kinds, colon + 1, src.length);
          if (src[open] === '[') {
            const close = matchBracket(src, kinds, open);
            if (close !== -1) return { open, close };
          }
          return null;
        }
      }
      i = end;
      continue;
    }
    i++;
  }
  return null;
}

function stringEnd(src: string, quote: number): number {
  let i = quote + 1;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === '"') return i + 1;
    i++;
  }
  return src.length;
}

function matchBracket(src: string, kinds: Uint8Array, open: number): number {
  const closer = src[open] === '[' ? ']' : '}';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (kindAt(kinds, i) !== 'code') continue;
    const c = src[i];
    // Brackets inside a string literal are not brackets.
    if (c === '"') {
      i = stringEnd(src, i) - 1;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return src[i] === closer ? i : -1;
    }
  }
  return -1;
}

/**
 * Spans of the array's own elements (depth 1 inside `[`), with separating commas and all
 * trivia — whitespace *and* comments — excluded. Fence comment lines are therefore not
 * elements; entries inside a fence are.
 *
 * A **newline at depth 0 also ends an element**, not just a comma. That is what lets us
 * emit a fence's entries with no commas at all and have {@link normalizeArrayCommas} put
 * them in afterwards: without it, `"a"\n"b"` would read as one element and the missing
 * comma between them would be undetectable. It is safe because a JSON value can only span
 * lines by being an object or array — and then its interior is at depth > 0.
 */
export function splitElements(src: string, span: ArraySpan): ElementSpan[] {
  const kinds = classify(src);
  const out: ElementSpan[] = [];
  let depth = 0;
  let start = -1;
  let lastCode = -1;
  const flush = () => {
    if (start >= 0) out.push({ start, end: lastCode + 1 });
    start = -1;
    lastCode = -1;
  };
  let i = span.open + 1;
  while (i < span.close) {
    if (kindAt(kinds, i) !== 'code') {
      if (src[i] === '\n' && depth === 0) flush();
      i++;
      continue;
    }
    const c = src[i];
    if (c === ',' && depth === 0) {
      flush();
      i++;
      continue;
    }
    if (start < 0) start = i;
    if (c === '"') {
      const end = stringEnd(src, i);
      lastCode = end - 1;
      i = end;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    lastCode = i;
    i++;
  }
  flush();
  return out;
}

/**
 * Locate the fence pair for `id` inside `span`. Returns null when the open fence is absent;
 * throws {@link UnterminatedFenceError} when it is present with no close after it.
 */
export function findFence(
  src: string,
  span: ArraySpan,
  id: string,
): FenceSpan | null {
  const region = src.slice(span.open, span.close);
  const om = openFenceRe(id).exec(region);
  if (om === null) return null;
  const openLineStart = span.open + om.index;
  let openLineEnd = src.indexOf('\n', openLineStart);
  if (openLineEnd === -1 || openLineEnd > span.close) openLineEnd = span.close;
  else openLineEnd += 1;

  const rest = src.slice(openLineEnd, span.close);
  const cm = closeFenceRe(id).exec(rest);
  if (cm === null) throw new UnterminatedFenceError(id);
  const closeLineStart = openLineEnd + cm.index;
  return {
    openLineStart,
    openLineEnd,
    closeLineStart,
    closeLineEnd: closeLineStart + cm[0].length,
  };
}

/** Raw text of each element inside the `id` fence, in order. */
export function parseFenceEntries(
  src: string,
  span: ArraySpan,
  id: string,
): string[] {
  const fence = findFence(src, span, id);
  if (fence === null) return [];
  return splitElements(src, span)
    .filter((e) =>
      e.start >= fence.openLineEnd && e.end <= fence.closeLineStart
    )
    .map((e) => src.slice(e.start, e.end));
}

// --- edits ---------------------------------------------------------------------

/** Offset of the first character of the line containing `i`. */
function lineStart(src: string, i: number): number {
  const nl = src.lastIndexOf('\n', i - 1);
  return nl === -1 ? 0 : nl + 1;
}

/** Leading whitespace of the line containing `i`. */
function lineIndent(src: string, i: number): string {
  const start = lineStart(src, i);
  const m = /^[ \t]*/.exec(src.slice(start, i));
  return m ? m[0] : '';
}

/**
 * The separator to emit before a block that will start at `at` (a line start): one blank line,
 * so a fence never sits flush against the element or fence above it. Empty when the blank line
 * is already there (keeping a rewrite idempotent) or when the block is the first thing inside
 * the array, where a leading blank line would just pad the `[`.
 */
function blankLineBefore(src: string, span: ArraySpan, at: number): string {
  if (/^\s*$/.test(src.slice(span.open + 1, at))) return '';
  const prevLine = src.slice(lineStart(src, at - 1), at - 1);
  return /^[ \t]*$/.test(prevLine) ? '' : '\n';
}

/**
 * Indentation to emit fenced entries with: copied from the first existing element in the
 * array, else the array key's own indentation + 2 spaces, else 4 spaces.
 */
export function elementIndent(src: string, span: ArraySpan): string {
  const els = splitElements(src, span);
  if (els.length > 0) return lineIndent(src, els[0].start);
  const keyIndent = lineIndent(src, span.open);
  return keyIndent.length > 0 ? keyIndent + '  ' : '    ';
}

function renderBlock(id: string, lines: string[], indent: string): string {
  const body = lines.map((l) => `${indent}${l}`);
  return [
    `${indent}// >>> ${fenceId(id)} (managed - do not edit)`,
    ...body,
    `${indent}// <<< ${fenceId(id)}`,
  ].join('\n');
}

/**
 * Replace the `id` fence's contents with `lines`, or insert the whole block just inside the
 * array's `]` when the fence is absent. The open fence is preceded by a blank line (see
 * {@link blankLineBefore}). Entries are emitted without commas — {@link normalizeArrayCommas}
 * puts those in afterwards.
 */
export function spliceBlock(
  src: string,
  span: ArraySpan,
  id: string,
  lines: string[],
  indent: string,
): string {
  const block = renderBlock(id, lines, indent);
  const fence = findFence(src, span, id);
  if (fence !== null) {
    // Rewrite in place — a fence the user moved stays where they put it.
    const gap = blankLineBefore(src, span, fence.openLineStart);
    return src.slice(0, fence.openLineStart) + gap + block +
      src.slice(fence.closeLineEnd);
  }
  const closeLine = lineStart(src, span.close);
  const beforeClose = src.slice(closeLine, span.close);
  if (/^[ \t]*$/.test(beforeClose)) {
    // `]` sits on its own line: drop the block in above it.
    const gap = blankLineBefore(src, span, closeLine);
    return src.slice(0, closeLine) + gap + block + '\n' + src.slice(closeLine);
  }
  // `]` shares a line with content (e.g. `"mounts": []`): open it up.
  const keyIndent = lineIndent(src, span.open);
  const gap = /^\s*$/.test(src.slice(span.open + 1, span.close)) ? '' : '\n';
  return src.slice(0, span.close) + '\n' + gap + block + '\n' + keyIndent +
    src.slice(span.close);
}

/**
 * Make the array's commas valid strict JSON: one after every element but the last, none
 * after the last. Only comma characters are inserted or deleted — comments and whitespace
 * never move. Edits are applied right-to-left so earlier offsets stay valid.
 */
export function normalizeArrayCommas(src: string, span: ArraySpan): string {
  const kinds = classify(src);
  const els = splitElements(src, span);
  const edits: Array<{ at: number; remove: number; insert: string }> = [];
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const next = nextCode(kinds, el.end, span.close);
    const hasComma = next < span.close && src[next] === ',';
    if (i === els.length - 1) {
      if (hasComma) edits.push({ at: next, remove: 1, insert: '' });
    } else if (!hasComma) {
      edits.push({ at: el.end, remove: 0, insert: ',' });
    }
  }
  let out = src;
  for (const e of edits.sort((a, b) => b.at - a.at)) {
    out = out.slice(0, e.at) + e.insert + out.slice(e.at + e.remove);
  }
  return out;
}

/**
 * Replace the elements of the array at `span` with `values`, JSON-encoded one per line at
 * `indent`, the `]` on its own line at the key's indentation; `[]` when `values` is empty. Only
 * the bytes between the brackets change — comments inside the array go with its old elements.
 */
export function replaceArrayElements(
  src: string,
  span: ArraySpan,
  values: readonly unknown[],
  indent: string,
): string {
  const inner = values.length === 0
    ? ''
    : '\n' + values.map((v) => indent + JSON.stringify(v)).join(',\n') +
      '\n' + lineIndent(src, span.open);
  return src.slice(0, span.open + 1) + inner + src.slice(span.close);
}

/**
 * Ensure a top-level array `key` exists, inserting `"<key>": []` right after the root
 * object's `{` when it does not (with a trailing comma if the object already had members).
 * `indent` is the indentation for the inserted key and its `]`.
 */
export function ensureArray(src: string, key: string, indent = '  '): string {
  if (findArraySpan(src, key) !== null) return src;
  const kinds = classify(src);
  const brace = nextCode(kinds, 0, src.length);
  if (src[brace] !== '{') {
    throw new Error(`devc: not a JSON object (cannot add "${key}")`);
  }
  const end = matchBracket(src, kinds, brace);
  const inner = end === -1 ? src.length : end;
  const hasMembers = nextCode(kinds, brace + 1, inner) < inner;
  const text = `\n${indent}${JSON.stringify(key)}: [\n${indent}]${
    hasMembers ? ',' : ''
  }`;
  return src.slice(0, brace + 1) + text + src.slice(brace + 1);
}

/**
 * The one supported write shape: splice each fence, then fix the commas. `blocks` is
 * applied in order, so absent fences end up in that order inside the array.
 */
export function writeBlocks(
  src: string,
  key: string,
  blocks: Array<{ id: string; lines: string[] }>,
): string {
  let out = ensureArray(src, key);
  const span0 = findArraySpan(out, key);
  if (span0 === null) {
    throw new Error(`devc: could not locate the "${key}" array`);
  }
  const indent = elementIndent(out, span0);
  for (const block of blocks) {
    const span = findArraySpan(out, key);
    if (span === null) {
      throw new Error(`devc: could not locate the "${key}" array`);
    }
    out = spliceBlock(out, span, block.id, block.lines, indent);
  }
  const span = findArraySpan(out, key);
  if (span === null) {
    throw new Error(`devc: could not locate the "${key}" array`);
  }
  return normalizeArrayCommas(out, span);
}
