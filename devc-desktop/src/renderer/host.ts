// The host terminal page: xterm.js on the host shell, through `window.hostTerm` (the host
// preload), and the Actions column beside it. Loaded from the app bundle in its own view; devc
// web cannot reach it.

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { badgeText } from '../main/policy.ts';
import { actionColumn } from './actions.ts';

interface HostTerm {
  start(cols: number, rows: number): void;
  input(data: string): void;
  resize(cols: number, rows: number): void;
  onOutput(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
  info(): Promise<
    {
      user: string;
      host: string;
      refused: string | null;
      toggle: string;
      open: boolean;
    }
  >;
  dragDrawer(dy: number): void;
  /** Asks the app for its right-click menu: `cd` to devc web's active terminal folder. */
  contextMenu(): void;
  /** The drawer opened (`true`) or closed to its strip, or out of sight. */
  onShown(cb: (open: boolean) => void): void;
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

const term = new Terminal({
  cursorBlink: true,
  fontFamily: 'ui-monospace, Menlo, "DejaVu Sans Mono", monospace',
  fontSize: 13,
  theme: { background: '#0d0f14', foreground: '#d7dae0' },
  scrollback: 5000,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open($('term'));

let running = false;
let started = false;
let refused: string | null = null;
/** Whether the drawer is open; closed, at most its strip shows (requests waiting). */
let open = false;
let toggle = '';

function start(): void {
  started = true;
  if (refused !== null) {
    term.write(`\x1b[33mThe host terminal is off: ${refused}.\x1b[0m\r\n`);
    return;
  }
  fit.fit();
  running = true;
  host.start(term.cols, term.rows);
}

host.onOutput((data) => term.write(data));
host.onExit((code) => {
  running = false;
  term.write(
    `\r\n\x1b[2m[shell exited (${code}); press any key for a new one]\x1b[0m\r\n`,
  );
});

term.onData((data) => {
  if (running) host.input(data);
  else if (refused === null) start();
});
term.onResize(({ cols, rows }) => {
  if (running) host.resize(cols, rows);
});
// Closed to its strip, the terminal has no room: keep the shell's size until it opens again.
new ResizeObserver(() => {
  if ($('term').clientHeight >= 40) fit.fit();
}).observe($('term'));

// The right-click menu is the app's own (a native menu), built by the main process.
$('term').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  host.contextMenu();
});

// A paste with a line break in it would run commands at once: show it and ask first. A
// single line goes straight in, as in any terminal.
const pasteBar = $('paste');
let pending: string | null = null;
$('term').addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (!/[\r\n]/.test(text.replace(/[\r\n]+$/, ''))) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  pending = text;
  const lines = text.replace(/[\r\n]+$/, '').split(/\r\n|\r|\n/).length;
  $('paste-lines').textContent = `${lines} lines`;
  $('paste-text').textContent = text;
  pasteBar.hidden = false;
  ($('paste-ok') as HTMLButtonElement).focus();
}, true);
const closePaste = (ok: boolean) => {
  if (ok && pending !== null) term.paste(pending);
  pending = null;
  pasteBar.hidden = true;
  term.focus();
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
  let last = e.screenY;
  const move = (m: PointerEvent) => {
    const dy = m.screenY - last;
    last = m.screenY;
    if (dy !== 0) host.dragDrawer(dy);
  };
  const up = () => {
    strip.removeEventListener('pointermove', move);
    strip.removeEventListener('pointerup', up);
    term.focus();
  };
  strip.addEventListener('pointermove', move);
  strip.addEventListener('pointerup', up);
});

window.addEventListener('focus', () => term.focus());

function showHint(): void {
  $('hint').textContent = toggle === ''
    ? ''
    : `${toggle} to ${open ? 'hide' : 'open'}`;
}

host.onShown((isOpen) => {
  open = isOpen;
  showHint();
  if (open && !started) start();
});

// The page is a classic script (a module would not load from file:), so no top-level await.
void host.info().then((info) => {
  $('who').textContent = `HOST — ${info.user}@${info.host}`;
  toggle = info.toggle;
  refused = info.refused;
  open = info.open;
  showHint();
  // Loaded only to show the strip's badge: the shell starts when the drawer opens.
  if (open && !started) start();
  // Never takes focus by itself: the app focuses this view when the user opens the drawer.
  if (document.hasFocus()) term.focus();
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
