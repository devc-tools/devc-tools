// Go back and go forward after a go to definition: the places jumped from, and the keys and
// mouse buttons that step through them. Pure, so it is tested; `tiles.js` records the places and
// shows them.

/** The most places kept to go back to. */
export const NAV_LIMIT = 50;

/**
 * Back and forward stacks of places (any JSON-able value; `tiles.js`'s are a file and line, or a
 * diff and its scroll). A jump pushes where it left and clears forward; going back or forward
 * takes the place to show, and keeps the one being left (when there is one) on the other stack.
 *
 * @template T
 * @param {number} [limit]
 */
export function createNavHistory(limit = NAV_LIMIT) {
  /** @type {T[]} */
  const back = [];
  /** @type {T[]} */
  const forward = [];
  /** @param {T[]} stack @param {T} place */
  const keep = (stack, place) => {
    const top = stack[stack.length - 1];
    if (top !== undefined && JSON.stringify(top) === JSON.stringify(place)) {
      return;
    }
    stack.push(place);
    if (stack.length > limit) stack.shift();
  };
  /** @param {T[]} from @param {T[]} to @param {T | null} current */
  const step = (from, to, current) => {
    const place = from.pop();
    if (place === undefined) return null;
    if (current !== null) keep(to, current);
    return place;
  };
  return {
    /** A jump left `place`. @param {T} place */
    push(place) {
      keep(back, place);
      forward.length = 0;
    },
    /** The place to go back to, or null; `current` (if any) becomes forward's. @param {T | null} current */
    back: (current) => step(back, forward, current),
    /** The place to go forward to, or null; `current` (if any) becomes back's. @param {T | null} current */
    forward: (current) => step(forward, back, current),
    get canBack() {
      return back.length > 0;
    },
    get canForward() {
      return forward.length > 0;
    },
  };
}

/**
 * Whether a key goes back or forward, as in VS Code: Ctrl+- and Ctrl+Shift+- on a Mac, Alt+← and
 * Alt+→ elsewhere. Null for any other key.
 *
 * @param {{code: string, key: string, ctrlKey: boolean, metaKey: boolean, altKey: boolean,
 *   shiftKey: boolean}} e
 * @param {boolean} isMac
 * @returns {'back' | 'forward' | null}
 */
export function navKey(e, isMac) {
  if (isMac) {
    if (e.code !== 'Minus' || !e.ctrlKey || e.metaKey || e.altKey) return null;
    return e.shiftKey ? 'forward' : 'back';
  }
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (e.key === 'ArrowLeft') return 'back';
  if (e.key === 'ArrowRight') return 'forward';
  return null;
}

/**
 * Whether a mouse button goes back (the side button a browser goes back with, 3) or forward (4).
 *
 * @param {{button: number}} e
 * @returns {'back' | 'forward' | null}
 */
export function navButton(e) {
  return e.button === 3 ? 'back' : e.button === 4 ? 'forward' : null;
}
