// The overlay menu's page: a trusted pane's right-click menu (the Containers pane's), drawn in a
// view of its own that the app puts over every other one, so it can spread past the pane. Its
// items come in through `window.overlayMenu` (the menu preload) as text; it measures itself, and
// the app places it. A pick, Escape or a click anywhere else (this view's blur) closes it.

import type { MenuEntry } from '../main/policy.ts';

interface OverlayMenu {
  onShow(cb: (items: unknown) => void): void;
  size(width: number, height: number): void;
  pick(index: number): void;
  dismiss(): void;
}

declare global {
  interface Window {
    overlayMenu: OverlayMenu;
  }
}

const bridge = window.overlayMenu;
const box = document.getElementById('menu')!;
/** Each pickable row, with its index in the items the pane sent. */
let rows: { el: HTMLElement; index: number }[] = [];
let active = -1;

function setActive(i: number): void {
  rows.forEach((r, j) => r.el.classList.toggle('active', j === i));
  active = i;
  rows[i]?.el.scrollIntoView({ block: 'nearest' });
}

bridge.onShow((raw) => {
  const items = Array.isArray(raw) ? raw as MenuEntry[] : [];
  rows = [];
  box.replaceChildren(
    ...items.map((item, index) => {
      if (item === null) {
        const sep = document.createElement('div');
        sep.className = 'menu-sep';
        sep.setAttribute('role', 'separator');
        return sep;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.tabIndex = -1;
      if (item.danger) b.className = 'danger';
      b.textContent = String(item.label);
      const row = { el: b, index };
      b.addEventListener('pointerenter', () => setActive(rows.indexOf(row)));
      b.addEventListener('click', () => bridge.pick(index));
      rows.push(row);
      return b;
    }),
  );
  setActive(-1);
  box.hidden = false;
  box.scrollTop = 0;
  // Measured at its natural size: while hidden, the view may not have its size yet. Placed, the
  // stylesheet's caps cut a menu taller than the window to it, and it scrolls.
  box.style.maxWidth = box.style.maxHeight = 'none';
  const { width, height } = box.getBoundingClientRect();
  box.style.maxWidth = box.style.maxHeight = '';
  bridge.size(width, height);
});

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') bridge.dismiss();
  else if (e.key === 'ArrowDown' && rows.length > 0) {
    setActive((active + 1) % rows.length);
  } else if (e.key === 'ArrowUp' && rows.length > 0) {
    setActive((active - 1 + rows.length) % rows.length);
  } else if (e.key === 'Enter' && active >= 0) bridge.pick(rows[active].index);
  else return;
  e.preventDefault();
});
// A click anywhere else focuses another view: the menu closes, as an OS menu would.
addEventListener('blur', () => bridge.dismiss());
