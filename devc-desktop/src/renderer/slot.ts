// A host tile's page: one pane of the app's Herdr session (`host_terminal.ts`), in a view the app
// lays over a `host` tile of devc web's layout (`.plans/archived/devc-desktop-host-tiles.md`).
// Loaded from the app bundle; devc web cannot reach it, and only says where its tile is. The pane
// is the app's: its id comes from the app, and closing devc web's tab only lets go of it (Close
// terminal…, in the right-click menu, ends it). See `.plans/archived/host-terminal-herdr.md`.

import { hostShortcut } from '../main/policy.ts';
import {
  type HostTerminal,
  mountHostTerminal,
  type PaneApi,
  writeNote,
} from './host_terminal.ts';
import { termColors } from './term_colors.ts';

interface SlotInfo {
  user: string;
  host: string;
  /** Why the host terminal is off, as a sentence, or null. */
  refused: string | null;
  /** This view's pane, or null when none could be made. */
  pane: string | null;
  /** The terminal's colors: see `term_colors.ts`. */
  color: unknown;
}

/** The host preload's `window.hostTerm`, as far as this page uses it. */
interface SlotHostTerm extends PaneApi {
  onColor(cb: (colors: unknown) => void): void;
  onGuard(cb: (on: boolean) => void): void;
  info(): Promise<SlotInfo>;
  /** A split or a new tab: a new host tile beside this one. */
  command(name: string): void;
}

// `host.ts` declares `window.hostTerm` globally with the drawer's view of it.
const host = (window as unknown as { hostTerm: SlotHostTerm }).hostTerm;
const $ = (id: string) => document.getElementById(id)!;

let term: HostTerminal | null = null;

host.onColor((v) => {
  const c = termColors(v);
  if (c !== null) term?.setColors(c);
});
host.onGuard((on) => {
  $('guard').hidden = !on;
  if (!on && document.hasFocus()) term?.focus();
});
window.addEventListener('focus', () => term?.focus());

// The split shortcuts, in the capture phase so xterm.js never types them. Each asks the app for a
// new host tile beside this one. (Its Close is in the right-click menu.)
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
  term?.focus();
};
$('paste-ok').addEventListener('click', () => closePaste(true));
$('paste-cancel').addEventListener('click', () => closePaste(false));
pasteBar.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePaste(false);
});

// The page is a classic script (a module would not load from file:), so no top-level await.
void host.info().then((info) => {
  $('who').textContent = `${info.user}@${info.host}`;
  if (info.refused !== null || info.pane === null) {
    $('note').textContent = info.refused ?? 'No host shell could be started.';
    $('note').hidden = false;
    return;
  }
  const t = mountHostTerminal(host, $('term-screen'), info.pane, {
    colors: termColors(info.color),
    onGone: (reason) => writeNote(t, `[${reason}] Close this tab in devc web.`),
    confirmPaste,
  });
  term = t;
  if (document.hasFocus()) t.focus();
});
