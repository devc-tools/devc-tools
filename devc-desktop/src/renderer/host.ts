// The host terminal page: devc web's tiles (`layout.js`, drawn by its `style.css`), each a pane of
// the app's Herdr session (`host_terminal.ts`, through `window.hostTerm`, the host preload), and
// the Actions column beside them. Loaded from the app bundle in its own view; devc web cannot
// reach it. It takes only code from devc web's checkout at build time, as the Containers pane does.
// Closing a tile lets go of its pane, which keeps running; Close terminal… ends it. See
// `.plans/archived/host-terminal-herdr.md`.

import { createTiling, type Tile, type Tiling } from 'devc-web/layout.js';
import { parseSavedLayout } from 'devc-web/lib/layout_state.js';
import {
  badgeText,
  type HostCommand,
  hostShortcut,
  MAX_SHELLS,
} from '../main/policy.ts';
import { actionColumn } from './actions.ts';
import {
  type HostTerminal,
  mountHostTerminal,
  type PaneApi,
  writeNote,
} from './host_terminal.ts';
import { type TermColors, termColors } from './term_colors.ts';

interface HostTerm extends PaneApi {
  /** A new pane: its id. */
  create(): Promise<string>;
  /** The session's panes no drawer tile and no host tile shows. */
  unshown(): Promise<string[]>;
  /** Ends a pane, after the app asks. */
  end(paneId: string, label: string): void;
  /** The last tile closed: the drawer closes too. */
  hide(): void;
  /** A pick from the app's right-click menu. */
  onCommand(cb: (name: string, id: string) => void): void;
  info(): Promise<
    {
      user: string;
      host: string;
      /** Why the host terminal is off, as a sentence, or null. */
      refused: string | null;
      toggle: string;
      open: boolean;
      /** The user opened it (not a request). */
      byUser: boolean;
      /** The terminals' colors: see `term_colors.ts`. */
      color: unknown;
      /** Panes moved here before this page could hear of them. */
      adopt: string[];
    }
  >;
  dragDrawer(dy: number): void;
  /** The drawer opened (`true`) or closed to its strip; `byUser`: not a request. */
  onShown(cb: (open: boolean, byUser: boolean) => void): void;
  /** The terminals' colors changed: see `term_colors.ts`. */
  onColor(cb: (colors: unknown) => void): void;
  /** The app moved a pane to `/main`'s layout: its tile goes (the pane keeps running). */
  onRemove(cb: (id: string) => void): void;
  /** A pane moved here from `/main`'s layout, or restored: a tile for it. */
  onAdopt(cb: (id: string) => void): void;
  /** The Actions column's cards, whenever one changes. */
  onActions(cb: (cards: unknown) => void): void;
  /** A line of a confirmed action's output. */
  onActionProgress(cb: (id: string, line: string) => void): void;
  confirmAction(id: string): void;
  dismissAction(id: string): void;
}

declare global {
  interface Window {
    hostTerm: HostTerm;
  }
}

const host = window.hostTerm;
const $ = (id: string) => document.getElementById(id)!;
const IS_MAC = navigator.platform.startsWith('Mac');

/** A tile's pane reference names its pane; `layout.js` wants a folder too, and there is one host. */
const HOST_FOLDER = 'host';
const LAYOUT_KEY = 'devc-desktop-host-layout-v2';

/** A tile's terminal. */
interface DrawerTerminal {
  tile: Tile;
  term: HostTerminal;
  el: HTMLElement;
  /** Taken away by the app (moved to `/main`): its pane is not released by this page. */
  removed: boolean;
  /** The pane is gone (ended, or it exited): a key makes a new one in its place. */
  gone: boolean;
  /** The shell's title, as its tab shows it after the label. */
  title: string;
}

/** By pane id. */
const terminals = new Map<string, DrawerTerminal>();
/** The tiling area, made when the drawer first opens: closed, it has no room. */
let tiling: Tiling | null = null;
/** Each tile's pane id, most recently focused last. */
let recent: string[] = [];
let refused: string | null = null;
/** Whether the drawer is open; closed, at most its strip shows (requests waiting). */
let open = false;
let toggle = '';
/** `user@host`, every tile's label. */
let label = 'host';
let colors: TermColors | null = null;

function applyColor(v: unknown): void {
  const next = termColors(v);
  if (next === null) return;
  colors = next;
  for (const t of terminals.values()) t.term.setColors(next);
}
host.onColor(applyColor);

/** Builds a tile's terminal: `layout.js` calls this for every new or restored tile. */
function mountTerminal(tile: Tile): void {
  const id = tile.ref?.pane_id;
  if (!id || terminals.has(id)) {
    // A tile with no pane, or a second tile on one pane: it goes.
    queueMicrotask(() => tiling?.close(tile.id));
    return;
  }
  const el = document.createElement('div');
  el.className = 'host-term';
  tile.element.append(el);
  const t: DrawerTerminal = {
    tile,
    el,
    removed: false,
    gone: false,
    title: '',
    term: null as unknown as HostTerminal,
  };
  terminals.set(id, t);
  t.term = mountHostTerminal(host, el, id, {
    colors,
    onTitle: (title) => {
      if (title === t.title) return;
      t.title = title;
      tile.setTitle(label, title);
    },
    onGone: (reason, wasAttached) => {
      t.gone = true;
      // A pane from a saved layout that Herdr no longer has: the tile goes.
      if (!wasAttached) {
        queueMicrotask(() => tiling?.close(tile.id));
        return;
      }
      writeNote(
        t.term,
        `[${reason}] Press any key for a new terminal here, or close this tab.`,
      );
    },
    onKey: () => {
      if (!t.gone) return;
      t.gone = false;
      void newTile(t, 'stack').then(() => tiling?.close(tile.id));
    },
    confirmPaste,
  });
  tile.setTitle(label);
  tile.setActions(trashButton(() => closeTerminal(t)));
  tile.element.addEventListener('mousedown', () => tile.focus(), true);
  if (tiling?.focusedTile() === tile) t.term.focus();
}

function unmountTerminal(tile: Tile): void {
  const t = terminalOf(tile);
  if (!t) return;
  const id = t.term.paneId;
  terminals.delete(id);
  recent = recent.filter((r) => r !== id);
  // Closing a tile lets go of its pane: it keeps running in Herdr.
  t.term.dispose(!t.removed);
  // After the layout has finished closing it.
  queueMicrotask(afterClose);
}

function afterClose(): void {
  if (tiling === null) return;
  if (tiling.isEmpty()) {
    host.hide();
    return;
  }
  if (tiling.focusedTile() === null) {
    const last = terminals.get(recent.at(-1) ?? '') ??
      terminalOf(tiling.tiles()[0]);
    if (last) tiling.reveal(last.tile.id);
  }
}

function terminalOf(tile: Tile | null | undefined): DrawerTerminal | undefined {
  return [...terminals.values()].find((t) => t.tile === tile);
}

/** The terminal keys go to: the focused tile's, else the one focused last. */
function current(): DrawerTerminal | undefined {
  return terminalOf(tiling?.focusedTile()) ??
    terminals.get(recent.at(-1) ?? '') ?? terminals.values().next().value;
}

/** A tile for pane `id`, placed relative to terminal `at`. */
function addTile(
  id: string,
  at: DrawerTerminal | undefined,
  where: 'right' | 'below' | 'stack',
): void {
  if (terminals.has(id)) {
    tiling?.reveal(terminals.get(id)!.tile.id);
    return;
  }
  ensureTiling().addBeside(
    at?.tile.id ?? null,
    { localFolder: HOST_FOLDER, pane_id: id },
    where,
  );
  showEmpty();
}

/** A new pane in a new tile, placed relative to terminal `at`. */
async function newTile(
  at: DrawerTerminal | undefined,
  where: 'right' | 'below' | 'stack',
): Promise<void> {
  if (refused !== null || terminals.size >= MAX_SHELLS) return;
  try {
    addTile(await host.create(), at, where);
  } catch { /* refused by the app: nothing */ }
}

function runCommand(name: HostCommand | string, at = current()): void {
  if (name === 'split-right') void newTile(at, 'right');
  else if (name === 'split-below') void newTile(at, 'below');
  else if (name === 'new-tab') void newTile(at, 'stack');
  else if (name === 'close' && at) tiling?.close(at.tile.id);
  else if (name === 'close-terminal' && at) closeTerminal(at);
}

/** **Close terminal…**: the app asks, then ends the pane; its tile goes when it is gone. */
function closeTerminal(t: DrawerTerminal): void {
  host.end(t.term.paneId, t.title ? `${label} ${t.title}` : label);
}

/** The tab's trash button, as devc web's terminal tabs have (`icon-btn`, its `trash` icon). */
function trashButton(action: () => void): HTMLElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  // devc web's `ICON_PATHS.trash` (ui.js).
  path.setAttribute(
    'd',
    'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4',
  );
  svg.append(path);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-btn';
  b.dataset.icon = 'trash';
  b.title = 'Close terminal…';
  b.setAttribute('aria-label', 'Close terminal…');
  const stop = (e: Event) => e.stopPropagation();
  b.addEventListener('mousedown', stop);
  b.addEventListener('pointerdown', stop);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    action();
  });
  b.append(svg);
  return b;
}

host.onCommand((name, id) => runCommand(name, terminals.get(id)));

// The app ended a pane (Close terminal…) or moved it to `/main`: its tile goes.
host.onRemove((id) => {
  const t = terminals.get(id);
  if (!t) return;
  t.removed = true;
  tiling?.close(t.tile.id);
});
host.onAdopt((id) => addTile(id, current(), 'stack'));

// In the capture phase, so xterm.js never types them into the shell.
document.addEventListener('keydown', (e) => {
  const name = hostShortcut(e, IS_MAC);
  if (name === null) return;
  e.preventDefault();
  e.stopPropagation();
  if (!e.repeat) runCommand(name);
}, true);

function saveLayout(): void {
  if (tiling === null || tiling.isEmpty()) return;
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(tiling.save()));
  } catch { /* unavailable: the next start shows unshown panes */ }
}

/** Makes the tiling area, with the last run's tiles: their panes are reattached, if Herdr has them. */
function ensureTiling(): Tiling {
  if (tiling !== null) return tiling;
  const made = createTiling($('root'), {
    mount: mountTerminal,
    unmount: unmountTerminal,
    visibility: () => {},
    focused: (tile) => {
      const t = terminalOf(tile);
      if (!t) return;
      const id = t.term.paneId;
      recent = [...recent.filter((r) => r !== id), id];
      t.term.focus();
    },
    changed: () => {
      saveLayout();
      showEmpty();
    },
    tileMenu: (tile, e) => {
      e.preventDefault();
      const t = terminalOf(tile);
      if (t) host.contextMenu(t.term.paneId);
    },
    stackMenu: (_stack, e) => {
      e.preventDefault();
      const t = current();
      if (t) host.contextMenu(t.term.paneId);
    },
    tabDoubleClick: () => {},
  });
  // Set before loading: the tiles it restores look for it as they are made.
  tiling = made;
  let saved = null;
  try {
    saved = parseSavedLayout(localStorage.getItem(LAYOUT_KEY));
  } catch { /* unavailable: no tiles */ }
  if (saved) made.load(saved);
  return made;
}

/** The empty tile area's **New terminal** button: shown while the drawer is open with no tiles. */
function showEmpty(): void {
  $('empty').hidden = !(open && (tiling?.isEmpty() ?? true));
  // Off (a debugging switch, no Herdr): the reason instead of the button.
  $('empty-new').hidden = refused !== null;
}

/**
 * The drawer opened or closed. Opened with no tiles, it shows the session's unshown panes; with
 * none, a new pane when the user opened it, or just the New terminal button when a request did.
 * See `.plans/archived/host-terminal-herdr.md` (D6, D7a).
 */
async function showOpen(isOpen: boolean, byUser: boolean): Promise<void> {
  open = isOpen;
  document.body.toggleAttribute('data-closed', !open);
  $('hint').textContent = toggle === '' ? '' : `${toggle} to open`;
  if (!open) {
    showEmpty();
    return;
  }
  const made = ensureTiling();
  if (made.isEmpty() && refused === null) {
    const unshown = await host.unshown().catch(() => [] as string[]);
    for (const id of unshown) addTile(id, current(), 'stack');
    if (unshown.length === 0 && byUser && made.isEmpty()) {
      await newTile(undefined, 'stack');
    }
  }
  showEmpty();
  // Never takes focus by itself: the app focuses this view when the user opens the drawer.
  if (document.hasFocus()) current()?.term.focus();
}

$('empty-new').addEventListener(
  'click',
  () => void newTile(undefined, 'stack'),
);

// A paste with a line break in it would run commands at once: show it and ask first. A single
// line goes straight in, as in any terminal.
const pasteBar = $('paste');
let pending: { text: string; send: (text: string) => void } | null = null;
function confirmPaste(text: string, send: (text: string) => void): void {
  pending = { text, send };
  const lines = text.replace(/[\r\n]+$/, '').split(/\r\n|\r|\n/).length;
  $('paste-lines').textContent = `${lines} lines`;
  $('paste-text').textContent = text;
  pasteBar.hidden = false;
  ($('paste-ok') as HTMLButtonElement).focus();
}
const closePaste = (ok: boolean) => {
  if (ok && pending !== null) pending.send(pending.text);
  pending = null;
  pasteBar.hidden = true;
  current()?.term.focus();
};
$('paste-ok').addEventListener('click', () => closePaste(true));
$('paste-cancel').addEventListener('click', () => closePaste(false));
pasteBar.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePaste(false);
});

// Dragging the strip resizes the drawer: the main process owns the views' bounds.
const strip = $('strip');
strip.addEventListener('pointerdown', (e) => {
  strip.setPointerCapture(e.pointerId);
  strip.classList.add('dragging');
  let last = e.screenY;
  const move = (m: PointerEvent) => {
    const dy = m.screenY - last;
    last = m.screenY;
    if (dy !== 0) host.dragDrawer(dy);
  };
  const up = () => {
    strip.removeEventListener('pointermove', move);
    strip.removeEventListener('pointerup', up);
    strip.classList.remove('dragging');
    current()?.term.focus();
  };
  strip.addEventListener('pointermove', move);
  strip.addEventListener('pointerup', up);
});

window.addEventListener('focus', () => current()?.term.focus());

/**
 * One {@link showOpen} at a time: the page hears the drawer open both from `info` and from
 * `host-term:shown`, and two at once would each make a pane for an empty drawer.
 */
let opening: Promise<void> = Promise.resolve();
function queueShowOpen(isOpen: boolean, byUser: boolean): void {
  opening = opening.then(() => showOpen(isOpen, byUser)).catch(() => {});
}
host.onShown(queueShowOpen);

// The page is a classic script (a module would not load from file:), so no top-level await.
void host.info().then((info) => {
  label = `${info.user}@${info.host}`;
  applyColor(info.color);
  $('who').textContent = label;
  toggle = info.toggle;
  refused = info.refused;
  if (refused !== null) {
    $('refused').textContent = refused;
    $('refused').hidden = false;
  }
  for (const id of info.adopt) addTile(id, current(), 'stack');
  // Loaded only to show the strip's badge: tiles appear when the drawer opens.
  queueShowOpen(info.open, info.byUser);
});

// ---- the Actions column ------------------------------------------------------------------------
// Requests devc web's page made, as the app checked them (`actions.ts` draws them, armed).

const column = actionColumn($('actions'), {
  confirm: (id) => host.confirmAction(id),
  dismiss: (id) => host.dismissAction(id),
});
host.onActions((raw) => {
  const { shown, waiting } = column.show(raw);
  $('body').classList.toggle('with-actions', shown > 0);
  $('badge').textContent = badgeText(waiting);
  $('badge').hidden = waiting === 0;
});
host.onActionProgress(column.progress);
