// The host terminal page: devc web's tiles (`layout.js`, drawn by its `style.css`), each an
// xterm.js on a host shell of its own through `window.hostTerm` (the host preload), and the Actions
// column beside them. Loaded from the app bundle in its own view; devc web cannot reach it. It takes
// only code from devc web's checkout at build time, as the Containers pane does.

import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/xterm';
import { createTiling, type Tile, type Tiling } from 'devc-web/layout.js';
import { parseSavedLayout } from 'devc-web/lib/layout_state.js';
import {
  badgeText,
  type HostCommand,
  hostShortcut,
  MAX_SHELLS,
} from '../main/policy.ts';
import { actionColumn } from './actions.ts';
import { copyOnSelect } from './copy_select.ts';
import { applyTermColors, type TermColors, termColors } from './term_colors.ts';

interface HostTerm {
  start(id: string, cols: number, rows: number): void;
  input(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  /** A tile closed: its shell stops. */
  close(id: string): void;
  /** The last tile closed: the drawer closes too. */
  hide(): void;
  onOutput(cb: (id: string, data: string) => void): void;
  onExit(cb: (id: string, code: number) => void): void;
  /** A pick from the app's right-click menu. */
  onCommand(cb: (name: string, id: string) => void): void;
  info(): Promise<
    {
      user: string;
      host: string;
      refused: string | null;
      toggle: string;
      open: boolean;
      /** The terminals' colors: see `term_colors.ts`. */
      color: unknown;
      /** Shells moved here before this page could hear of them. */
      adopt: { id: string; replay: string }[];
    }
  >;
  dragDrawer(dy: number): void;
  /** Asks the app for its right-click menu for a shell's tile. */
  contextMenu(id: string): void;
  /** The drawer opened (`true`) or closed to its strip, or out of sight. */
  onShown(cb: (open: boolean) => void): void;
  /** The terminals' colors changed: see `term_colors.ts`. */
  onColor(cb: (colors: unknown) => void): void;
  /** The app moves a shell to `/main`'s layout: hand over its terminal's contents. */
  onDetach(cb: (id: string) => void): void;
  detached(id: string, data: string): void;
  /** A shell moved here from `/main`'s layout, with its terminal's contents. */
  onAdopt(cb: (id: string, replay: string) => void): void;
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

/** A tile's pane reference names its shell; `layout.js` wants a folder too, and there is one host. */
const HOST_FOLDER = 'host';
const LAYOUT_KEY = 'devc-desktop-host-layout-v1';

/** A tile's terminal and shell. */
interface HostTerminal {
  id: string;
  tile: Tile;
  term: Terminal;
  fit: FitAddon;
  serialize: SerializeAddon;
  /** Moved to `/main`'s layout: closing its tile leaves the shell running. */
  detached: boolean;
  el: HTMLElement;
  observer: ResizeObserver;
  /** `term.open` has run: the tile is in the page. */
  opened: boolean;
  running: boolean;
  started: boolean;
}

const terminals = new Map<string, HostTerminal>();
/** The tiling area, made when the drawer first opens: closed, it has no room. */
let tiling: Tiling | null = null;
/** Each tile's shell id, most recently focused last. */
let recent: string[] = [];
let refused: string | null = null;
/** Whether the drawer is open; closed, at most its strip shows (requests waiting). */
let open = false;
let toggle = '';
/** `user@host`, every tile's label. */
let label = 'host';
/**
 * Every terminal's colors, in View → Host Terminal Color's theme and the current mode; the page
 * itself takes that theme's variables from the app (`--term-bg` behind each terminal).
 */
let colors: TermColors | null = null;

function applyColor(v: unknown): void {
  const next = termColors(v);
  if (next === null) return;
  colors = next;
  for (const t of terminals.values()) applyTermColors(t.term, next);
}
host.onColor(applyColor);

function start(t: HostTerminal): void {
  t.started = true;
  if (refused !== null) {
    t.term.write(`\x1b[33mThe host terminal is off: ${refused}.\x1b[0m\r\n`);
    return;
  }
  if (t.el.clientHeight >= 40) t.fit.fit();
  t.running = true;
  host.start(t.id, t.term.cols, t.term.rows);
}

/** Starts a tile's shell once the tile is in the page and the drawer is open. */
function startIfOpen(t: HostTerminal): void {
  if (open && t.opened && !t.started) start(t);
}

host.onOutput((id, data) => terminals.get(id)?.term.write(data));
host.onExit((id, code) => {
  const t = terminals.get(id);
  if (!t) return;
  t.running = false;
  t.term.write(
    `\r\n\x1b[2m[shell exited (${code}); press any key for a new one]\x1b[0m\r\n`,
  );
});

/** Builds a tile's terminal: `layout.js` calls this for every new or restored tile. */
function mountTerminal(tile: Tile): void {
  const id = tile.ref?.pane_id ?? crypto.randomUUID();
  const el = document.createElement('div');
  el.className = 'host-term';
  tile.element.append(el);
  const term = new Terminal({
    cursorBlink: true,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    ...(colors ?? {}),
    scrollback: 5000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const serialize = new SerializeAddon();
  term.loadAddon(serialize);
  // A shell moved here: what its terminal showed, scrollback and all.
  const replay = adopted.get(id);
  if (replay !== undefined) {
    adopted.delete(id);
    term.write(replay);
  }
  const t: HostTerminal = {
    id,
    tile,
    term,
    fit,
    serialize,
    detached: false,
    el,
    // Too small (a hidden tab, a closed drawer): keep the shell's size until it has room again.
    observer: new ResizeObserver(() => {
      if (t.opened && el.clientHeight >= 40 && el.clientWidth >= 40) fit.fit();
    }),
    opened: false,
    running: false,
    started: false,
  };
  terminals.set(id, t);
  term.onData((data) => {
    if (t.running) host.input(id, data);
    else if (refused === null) start(t);
  });
  term.onResize(({ cols, rows }) => {
    if (t.running) host.resize(id, cols, rows);
  });
  // The shell's own title, after the label. Only ever text: `setTitle` writes no markup.
  term.onTitleChange((title) => tile.setTitle(label, title));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    host.contextMenu(id);
  });
  tile.element.addEventListener('mousedown', () => tile.focus(), true);
  copyOnSelect(term, el);
  t.observer.observe(el);
  // After the factory returns: the tile is in the page only then, and a title change mid-build
  // would save a half-built layout.
  queueMicrotask(() => {
    if (terminals.get(id) !== t) return;
    term.open(el);
    t.opened = true;
    tile.setTitle(label);
    if (tiling?.focusedTile() === tile) term.focus();
    startIfOpen(t);
  });
}

function unmountTerminal(tile: Tile): void {
  const t = terminalOf(tile);
  if (!t) return;
  terminals.delete(t.id);
  recent = recent.filter((id) => id !== t.id);
  t.observer.disconnect();
  t.term.dispose();
  if (!t.detached) host.close(t.id);
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

function terminalOf(tile: Tile | null | undefined): HostTerminal | undefined {
  return [...terminals.values()].find((t) => t.tile === tile);
}

/** The terminal keys go to: the focused tile's, else the one focused last. */
function current(): HostTerminal | undefined {
  return terminalOf(tiling?.focusedTile()) ??
    terminals.get(recent.at(-1) ?? '') ?? terminals.values().next().value;
}

/** A new tile with a new shell, placed relative to terminal `at`. */
function addTerminal(
  at: HostTerminal | undefined,
  where: 'right' | 'below' | 'stack',
): void {
  if (tiling === null) return;
  if (terminals.size >= MAX_SHELLS) return;
  tiling.addBeside(
    at?.tile.id ?? null,
    { localFolder: HOST_FOLDER, pane_id: crypto.randomUUID() },
    where,
  );
}

function runCommand(name: HostCommand | string, at = current()): void {
  if (name === 'split-right') addTerminal(at, 'right');
  else if (name === 'split-below') addTerminal(at, 'below');
  else if (name === 'new-tab') addTerminal(at, 'stack');
  else if (name === 'close' && at) tiling?.close(at.tile.id);
}

host.onCommand((name, id) => runCommand(name, terminals.get(id)));

// ---- moving a shell between the drawer and `/main`'s layout --------------------------------------

/** Contents for shells being moved here, until their tile is made. */
const adopted = new Map<string, string>();

host.onDetach((id) => {
  const t = terminals.get(id);
  if (!t) {
    host.detached(id, '');
    return;
  }
  const data = t.serialize.serialize({ scrollback: 5000 });
  t.detached = true;
  host.detached(id, data);
  tiling?.close(t.tile.id);
});

/** A tile for a shell that already runs, showing what it showed where it was. */
function adopt(id: string, replay: string): void {
  if (terminals.has(id)) return;
  adopted.set(id, replay);
  const made = ensureTiling();
  made.addBeside(
    current()?.tile.id ?? null,
    { localFolder: HOST_FOLDER, pane_id: id },
    'stack',
  );
}
host.onAdopt(adopt);

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
  } catch { /* unavailable: the next start has one tile */ }
}

/** Makes the tiling area, with the last run's tiles (new shells: the old ones went with it). */
function ensureTiling(): Tiling {
  if (tiling !== null) return tiling;
  const made = createTiling($('root'), {
    mount: mountTerminal,
    unmount: unmountTerminal,
    visibility: (tile, visible) => {
      const t = terminalOf(tile);
      if (visible && t?.opened && t.el.clientHeight >= 40) t.fit.fit();
    },
    focused: (tile) => {
      const t = terminalOf(tile);
      if (!t) return;
      recent = [...recent.filter((id) => id !== t.id), t.id];
      t.term.focus();
    },
    changed: saveLayout,
    tileMenu: (tile, e) => {
      e.preventDefault();
      const t = terminalOf(tile);
      if (t) host.contextMenu(t.id);
    },
    stackMenu: (_stack, e) => {
      e.preventDefault();
      const t = current();
      if (t) host.contextMenu(t.id);
    },
    tabDoubleClick: () => {},
  });
  // Set before loading: the tiles it restores look for it as they are made.
  tiling = made;
  let saved = null;
  try {
    saved = parseSavedLayout(localStorage.getItem(LAYOUT_KEY));
  } catch { /* unavailable: one new tile */ }
  if (saved) made.load(saved);
  return made;
}

/** The drawer opened or closed: tiles exist only once it has opened, and at least one then. */
function showOpen(isOpen: boolean): void {
  open = isOpen;
  document.body.toggleAttribute('data-closed', !open);
  $('hint').textContent = toggle === '' ? '' : `${toggle} to open`;
  if (!open) return;
  const made = ensureTiling();
  if (made.isEmpty()) addTerminal(undefined, 'stack');
  for (const t of terminals.values()) startIfOpen(t);
  // Never takes focus by itself: the app focuses this view when the user opens the drawer.
  if (document.hasFocus()) current()?.term.focus();
}

$('tiles').addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (!/[\r\n]/.test(text.replace(/[\r\n]+$/, ''))) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  pending = text;
  pasteInto = current() ?? null;
  const lines = text.replace(/[\r\n]+$/, '').split(/\r\n|\r|\n/).length;
  $('paste-lines').textContent = `${lines} lines`;
  $('paste-text').textContent = text;
  pasteBar.hidden = false;
  ($('paste-ok') as HTMLButtonElement).focus();
}, true);
// A paste with a line break in it would run commands at once: show it and ask first. A
// single line goes straight in, as in any terminal.
const pasteBar = $('paste');
let pending: string | null = null;
let pasteInto: HostTerminal | null = null;
const closePaste = (ok: boolean) => {
  const t = pasteInto;
  if (ok && pending !== null && t && terminals.get(t.id) === t) {
    t.term.paste(pending);
  }
  pending = null;
  pasteInto = null;
  pasteBar.hidden = true;
  (t && terminals.get(t.id) === t ? t : current())?.term.focus();
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

host.onShown(showOpen);

// The page is a classic script (a module would not load from file:), so no top-level await.
void host.info().then((info) => {
  label = `${info.user}@${info.host}`;
  applyColor(info.color);
  $('who').textContent = label;
  toggle = info.toggle;
  refused = info.refused;
  for (const a of info.adopt) adopt(a.id, a.replay);
  // Loaded only to show the strip's badge: the shell starts when the drawer opens.
  showOpen(info.open);
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
