// Copy on select for a host terminal, as devc web's container terminals do: a mouse selection
// (drag, double- or triple-click, or Shift/Option+drag past a full-screen app's mouse mode) is
// copied when the button comes up, wherever the pointer is by then. The view is granted
// `clipboard-sanitized-write` for this alone (`hostPermission` in `main/policy.ts`); reading the
// clipboard stays refused.

import type { Terminal } from '@xterm/xterm';

export function copyOnSelect(term: Terminal, el: HTMLElement): void {
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const onUp = () => {
      window.removeEventListener('mouseup', onUp);
      // xterm.js settles the selection on its own mouseup, after this capture-less listener
      // may run: read it once that has happened.
      setTimeout(() => {
        const text = term.hasSelection() ? term.getSelection() : '';
        if (text) navigator.clipboard?.writeText(text).catch(() => {});
      });
    };
    window.addEventListener('mouseup', onUp);
  });
}
