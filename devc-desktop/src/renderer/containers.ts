// The Containers pane: devc web's Containers section (`devc/web/static/containers.js`, the
// `/containers` page's code), bundled into the app at build time, so `devc web --live` never
// changes it. It sits below devc web's `/sidebar` view, under the divider the two zones have in
// devc web's own sidebar, so the column reads as one sidebar, and reaches
// devc web's `/ws` with the desktop token (`window.containersPane.token()`, the containers
// preload), which gives it the server's desktop role. What it can't leave to the server goes to
// the app: a push or a container start, stop or removal shows here as a card the user confirms
// (armed, as in the HOST drawer), and its right-click menus are the app's overlay menu, so they
// can spread past the pane. Container-supplied text is only ever inserted as text. Below the
// section, under a divider of its own, is devc web's Outline (`devc/web/static/outline.js`): the
// file tile focused last's tests and declarations, below Projects as in devc web's own sidebar
// (`/sidebar` draws none while the pane shows).

import { connect, useBundledEndpoint } from 'devc-web/client.js';
import { mountContainers } from 'devc-web/containers.js';
import { mountOutlineZone } from 'devc-web/outline.js';
import { useAppActions } from 'devc-web/menus.js';
import {
  remoteInUse,
  remoteTileArea,
  serveContainers,
} from 'devc-web/remote.js';
import { type MenuItem, useMenuHost } from 'devc-web/ui.js';
import { PROTOCOL } from 'devc-web/lib/protocol_version.js';
import { actionColumn } from './actions.ts';

interface ContainersPane {
  token(): Promise<{ origin: string; token: string } | null>;
  dragStrip(dy: number): void;
  resetStrip(): void;
  dialog(open: boolean): void;
  onExpanded(
    cb: (
      at: { x: number; y: number; width: number; height: number } | null,
    ) => void,
  ): void;
  fold(open: boolean, height: number): void;
  menu(
    seq: number,
    items: ({ label: string; danger: boolean } | null)[],
    x: number,
    y: number,
  ): void;
  onMenuPick(cb: (seq: number, index: number) => void): void;
  push(localFolder: string, folder: string): void;
  terminal(localFolder: string, folder: string): void;
  project(action: string, localFolder: string): void;
  onActions(cb: (cards: unknown) => void): void;
  onActionProgress(cb: (id: string, line: string) => void): void;
  confirmAction(id: string): void;
  dismissAction(id: string): void;
}

declare global {
  interface Window {
    containersPane: ContainersPane;
  }
}

const pane = window.containersPane;
const $ = (id: string) => document.getElementById(id)!;

// ---- the divider: dragging it resizes the pane, double-clicking resets it -------------------------

const strip = $('strip');
strip.addEventListener('pointerdown', (e) => {
  if (strip.dataset.inert === 'true') return;
  strip.classList.add('dragging');
  strip.setPointerCapture(e.pointerId);
  let last = e.screenY;
  const move = (m: PointerEvent) => {
    const dy = m.screenY - last;
    last = m.screenY;
    if (dy !== 0) pane.dragStrip(dy);
  };
  const up = () => {
    strip.classList.remove('dragging');
    strip.removeEventListener('pointermove', move);
    strip.removeEventListener('pointerup', up);
  };
  strip.addEventListener('pointermove', move);
  strip.addEventListener('pointerup', up);
});
strip.addEventListener('dblclick', () => {
  if (strip.dataset.inert !== 'true') pane.resetStrip();
});

// ---- folding: with both sections folded the pane shrinks to their headings ---------------------

let sectionOpen = true;
/** Whether the Outline below the section is open; set once it is mounted. */
let outlineOpen = (): boolean => false;
/** What the app was last told: `open`, and folded, the height. */
let lastFold = '';

/**
 * Tells the app whether the pane is open (the section or the Outline is), and folded, the height
 * down to the last heading; only when that changed.
 */
function reportFold(): void {
  const open = sectionOpen || outlineOpen();
  strip.dataset.inert = String(!open);
  requestAnimationFrame(() => {
    const headings = document.querySelectorAll('#tree .row.section');
    const heading = headings[headings.length - 1];
    const height = open || heading === undefined
      ? 0
      : Math.ceil(heading.getBoundingClientRect().bottom) + 4;
    const fold = `${open} ${height}`;
    if (fold === lastFold) return;
    lastFold = fold;
    pane.fold(open, height);
  });
}

// ---- dialogs: over the whole window, as devc web's page draws them -----------------------------
// The view is only as big as the pane, so while a dialog is open the app spreads it over the
// window, transparent, and says where the pane is in it: the pane's content stays there, and the
// dialog and its backdrop cover the window. Until then the dialog is hidden, so it never shows
// squeezed into the pane first.

let dialogOpen = false;
let waitTimer: ReturnType<typeof setTimeout> | undefined;

function dialogShowing(): boolean {
  return document.querySelector('dialog[open], .dialog-backdrop') !== null;
}

new MutationObserver(() => {
  const open = dialogShowing();
  if (open === dialogOpen) return;
  dialogOpen = open;
  if (open) {
    document.documentElement.classList.add('pane-dialog-wait');
    // Should the app not spread the pane (it is hidden), show the dialog where it is.
    clearTimeout(waitTimer);
    waitTimer = setTimeout(
      () => document.documentElement.classList.remove('pane-dialog-wait'),
      400,
    );
  }
  pane.dialog(open);
}).observe(document.body, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['open'],
});

pane.onExpanded((at) => {
  const root = document.documentElement;
  clearTimeout(waitTimer);
  root.classList.remove('pane-dialog-wait');
  root.classList.toggle('pane-spread', at !== null);
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    if (at === null) root.style.removeProperty(`--pane-${k}`);
    else root.style.setProperty(`--pane-${k}`, `${at[k]}px`);
  }
});

// ---- the Actions column ------------------------------------------------------------------------

const column = actionColumn($('actions'), {
  confirm: (id) => pane.confirmAction(id),
  dismiss: (id) => pane.dismissAction(id),
});
pane.onActions((raw) => {
  column.show(raw);
  // Folded, the pane's height follows its cards'.
  if (!sectionOpen) reportFold();
});
pane.onActionProgress(column.progress);

// ---- menus: the app's overlay, never this page's own -------------------------------------------

let menuSeq = 0;
let menuActions: (() => void)[] = [];
useMenuHost((x: number, y: number, items: MenuItem[]) => {
  menuSeq++;
  menuActions = [];
  const entries = items.map((item, i) => {
    if (item === null) return null;
    const opts = item[4];
    if (opts?.disabled !== true) menuActions[i] = item[1];
    return {
      label: String(item[0]),
      danger: item[2] === true,
      ...(opts?.disabled === true ? { disabled: true } : {}),
      ...(typeof opts?.title === 'string' && opts.title !== ''
        ? { title: opts.title }
        : {}),
    };
  });
  pane.menu(menuSeq, entries, Math.round(x), Math.round(y));
});
pane.onMenuPick((seq, index) => {
  if (seq !== menuSeq) return;
  const run = menuActions[index];
  menuActions = [];
  if (run) whenFocused(run);
});

/**
 * Runs `fn` once this page has the focus. A pick comes from the overlay menu's view, which held
 * it: the app hands it back, but the pick may arrive first, and the clipboard refuses a write
 * from an unfocused document (Copy path's "Document is not focused"). Should the focus never
 * come, `fn` runs anyway after a moment.
 */
function whenFocused(fn: () => void): void {
  if (document.hasFocus()) {
    fn();
    return;
  }
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    removeEventListener('focus', once);
    clearTimeout(timer);
    fn();
  };
  addEventListener('focus', once);
  const timer = setTimeout(once, 500);
}

// Pushes, container actions and host terminals go to the app, which shows them above as cards
// to confirm.
useAppActions({
  push: (localFolder, folder) => pane.push(localFolder, folder),
  project: (action, localFolder) => pane.project(action, localFolder),
  terminal: (localFolder, folder) => pane.terminal(localFolder, folder),
});

// ---- the section, once the app has handed over devc web's address and the desktop token --------

/** Shows only `text` (a protocol mismatch, or no devc web), or the section when `null`. */
function notice(text: string | null): void {
  $('notice').textContent = text ?? '';
  $('notice').hidden = text === null;
  $('section').hidden = text !== null;
}

void pane.token().then((conn) => {
  if (conn === null) {
    notice("devc web isn't running.");
    return;
  }
  useBundledEndpoint({
    origin: conn.origin,
    desktopToken: conn.token,
    protocol: PROTOCOL,
    onProtocol: (ok, server) =>
      notice(
        ok
          ? null
          : `This devc-desktop was built for protocol ${PROTOCOL}; devc web speaks ${
            typeof server === 'number' ? server : 'none'
          }. Rebuild devc-desktop.`,
      ),
  });
  const remote = remoteTileArea();
  const inUse = remoteInUse();
  const tree = $('tree');
  const outline = mountOutlineZone({
    tileArea: remote.tileArea,
    avail: () => tree.clientHeight - outline.divider.offsetHeight,
    changed: () => {
      outline.applySize();
      reportFold();
    },
  });
  outlineOpen = outline.isOpen;
  tree.append(outline.divider, outline.zone);
  outline.draw(null);
  addEventListener('resize', () => outline.applySize());
  const section = mountContainers($('containers'), {
    tileArea: remote.tileArea,
    inUse: inUse.link,
    standalone: true,
    onFold: (open) => {
      sectionOpen = open;
      // Folded, Projects is its heading and the Outline takes the rest.
      tree.classList.toggle('containers-closed', !open);
      outline.setFill(!open);
      reportFold();
    },
  }) as { onViewState(state: { outline?: unknown }): void };
  serveContainers(remote, inUse, {
    ...section,
    onViewState(state: { outline?: unknown }) {
      section.onViewState(state);
      outline.draw(state.outline);
    },
  });
  connect();
});
