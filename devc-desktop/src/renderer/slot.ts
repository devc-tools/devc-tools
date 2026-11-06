// A host tile's page: one host shell, in a view the app lays over a `host` tile of devc web's
// layout (`.plans/archived/devc-desktop-host-tiles.md`). Loaded from the app bundle; devc web cannot reach
// it, and only says where its tile is. The shell is the app's: its id comes from the app, and
// closing devc web's tab does not end it (the app's right-click menu does).

import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/xterm';
import { hostShortcut } from '../main/policy.ts';
import { copyOnSelect } from './copy_select.ts';

interface SlotInfo {
  user: string;
  host: string;
  refused: string | null;
  /** This view's shell. */
  shell: string;
  /** The host color's background. */
  color: string;
  /** What the shell's terminal showed where it was, when it moved here from the drawer. */
  replay: string | null;
}

/** The host preload's `window.hostTerm`, as far as this page uses it. */
interface SlotHostTerm {
  start(id: string, cols: number, rows: number): void;
  input(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  onOutput(cb: (id: string, data: string) => void): void;
  onExit(cb: (id: string, code: number) => void): void;
  onColor(cb: (background: string) => void): void;
  onGuard(cb: (on: boolean) => void): void;
  info(): Promise<SlotInfo>;
  contextMenu(id: string): void;
  /** A split or a new tab: a new host tile beside this one. */
  command(name: string): void;
  /** The app moves this shell to the drawer: hand over the terminal's contents. */
  onDetach(cb: (id: string) => void): void;
  detached(id: string, data: string): void;
}

// `host.ts` declares `window.hostTerm` globally with the drawer's view of it.
const host = (window as unknown as { hostTerm: SlotHostTerm }).hostTerm;
const $ = (id: string) => document.getElementById(id)!;

const el = $('term');
const term = new Terminal({
  cursorBlink: true,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  fontSize: 13,
  scrollback: 5000,
});
const fit = new FitAddon();
term.loadAddon(fit);
const serialize = new SerializeAddon();
term.loadAddon(serialize);
term.open(el);
copyOnSelect(term, el);

let shell: string | null = null;
let running = false;
let refused: string | null = null;

function applyColor(background: string): void {
  if (!/^#[0-9a-f]{6}$/.test(background)) return;
  document.documentElement.style.setProperty('--host-bg', background);
  term.options.theme = { background };
}

function refit(): void {
  if (el.clientHeight >= 40 && el.clientWidth >= 40) fit.fit();
}
new ResizeObserver(refit).observe(el);

function start(): void {
  if (shell === null) return;
  if (refused !== null) {
    term.write(`\x1b[33mThe host terminal is off: ${refused}.\x1b[0m\r\n`);
    return;
  }
  refit();
  running = true;
  host.start(shell, term.cols, term.rows);
}

host.onOutput((id, data) => {
  if (id === shell) term.write(data);
});
host.onExit((id, code) => {
  if (id !== shell) return;
  running = false;
  // Ended from the app's menu: no code of its own.
  const what = code < 0 ? '[exited]' : `[exited ${code}]`;
  term.write(`\r\n\x1b[2m${what} Close this tab in devc web.\x1b[0m\r\n`);
});
host.onColor(applyColor);
host.onDetach((id) => {
  if (id === shell) {
    host.detached(id, serialize.serialize({ scrollback: 5000 }));
  }
});
host.onGuard((on) => {
  $('guard').hidden = !on;
  if (!on && document.hasFocus()) term.focus();
});

term.onData((data) => {
  if (running && shell !== null) host.input(shell, data);
});
term.onResize(({ cols, rows }) => {
  if (running && shell !== null) host.resize(shell, cols, rows);
});
el.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (shell !== null) host.contextMenu(shell);
});
window.addEventListener('focus', () => term.focus());

// The drawer's split shortcuts, in the capture phase so xterm.js never types them. Each asks the
// app for a new host tile beside this one. (Its Close is End Shell, in the right-click menu.)
const IS_MAC = navigator.platform.startsWith('Mac');
document.addEventListener('keydown', (e) => {
  const name = hostShortcut(e, IS_MAC);
  if (name === null || name === 'close') return;
  e.preventDefault();
  e.stopPropagation();
  if (!e.repeat) host.command(name);
}, true);

// A paste with a line break in it would run commands at once: show it and ask first, as the
// drawer does. A single line goes straight in.
const pasteBar = $('paste');
let pending: string | null = null;
el.addEventListener('paste', (e) => {
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

// The page is a classic script (a module would not load from file:), so no top-level await.
void host.info().then((info) => {
  $('who').textContent = `${info.user}@${info.host}`;
  applyColor(info.color);
  refused = info.refused;
  shell = info.shell;
  if (info.replay !== null) term.write(info.replay);
  start();
  if (document.hasFocus()) term.focus();
});
