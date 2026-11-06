// One host terminal: a pane of the app's Herdr session, drawn by devc web's `renderer.js` and
// driven by its `term_mouse.js`, as a container terminal in devc web is (both bundled at build
// time; devc web cannot reach this page). The drawer (`host.ts`) and a host tile (`slot.ts`) only
// place it. Everything goes through the host preload (`window.hostTerm`), and the main process
// checks every pane id. See `.plans/archived/host-terminal-herdr.md` (D4, D5, D9, D11).

import { createRenderer, type Renderer } from 'devc-web/renderer.js';
import { attachTerminalMouse } from 'devc-web/term_mouse.js';
import {
  createWheelAccumulator,
  decodeBase64,
  encodeInput,
  wrapPaste,
} from 'devc-web/lib/input.js';
import { type Link, resolvePath } from 'devc-web/lib/links.js';
import type { TermColors } from './term_colors.ts';

/** A frame from the main process (`herdr.ts`'s `Frame`): `bytes` base64. */
export interface Frame {
  seq: unknown;
  full: boolean;
  cols: number;
  rows: number;
  bytes: string;
}

type Cell = { column: number; row: number };

/** What a host terminal needs of the host preload. */
export interface PaneApi {
  attach(
    paneId: string,
    cols: number,
    rows: number,
  ): Promise<{ paneId: string; cwd: string }>;
  paneCommand(paneId: string, cmd: unknown): void;
  readSelection(paneId: string, anchor: Cell, cursor: Cell): Promise<string>;
  release(paneId: string): void;
  contextMenu(paneId: string): void;
  openFile(file: { path: string; line?: number; column?: number }): void;
  onFrame(cb: (paneId: string, frame: Frame) => void): void;
  onClosed(cb: (paneId: string, reason: string) => void): void;
  onPanes(
    cb: (panes: { paneId: string; cwd: string; title: string }[]) => void,
  ): void;
}

const IS_MAC = navigator.platform.startsWith('Mac');

/** Whether the key that opens terminal links is down: Cmd on a Mac, Ctrl elsewhere. */
export function isLinkModifier(ev: MouseEvent | KeyboardEvent): boolean {
  return IS_MAC ? ev.metaKey : ev.ctrlKey;
}
const LINK_HINT = `${IS_MAC ? 'Cmd' : 'Ctrl'}+click to open`;

interface Listener {
  frame(f: Frame): void;
  closed(reason: string): void;
  panes(cwd: string, title: string): void;
}
const listeners = new Map<string, Listener>();
let listening = false;

/** Routes the main process's frames and pane news to each terminal, once per page. */
function listen(api: PaneApi): void {
  if (listening) return;
  listening = true;
  api.onFrame((id, f) => listeners.get(id)?.frame(f));
  api.onClosed((id, reason) => listeners.get(id)?.closed(reason));
  api.onPanes((panes) => {
    for (const p of panes) listeners.get(p.paneId)?.panes(p.cwd, p.title);
  });
}

export interface HostTerminal {
  readonly paneId: string;
  renderer: Renderer;
  focus(): void;
  setColors(colors: TermColors): void;
  /** Sends text as a paste (bracketed when it spans lines), as devc web does. */
  paste(text: string): void;
  /** Takes it down; `release` lets go of the pane (it keeps running in Herdr). */
  dispose(release: boolean): void;
}

/** Colors before the app has sent any: the renderer's own until `setColors`. */
const NO_COLORS: TermColors = { theme: {}, minimumContrastRatio: 1 };

/**
 * Mounts pane `paneId`'s terminal in `el` and attaches it once laid out. `onGone`: the pane went
 * away or could not be attached (`attached` false then). `onTitle`: the shell's title from Herdr.
 * `confirmPaste`: a paste with a line break in it, shown before it goes in.
 */
export function mountHostTerminal(
  api: PaneApi,
  el: HTMLElement,
  paneId: string,
  opts: {
    colors: TermColors | null;
    onGone(reason: string, attached: boolean): void;
    onTitle?(title: string): void;
    onKey?(): void;
    confirmPaste(text: string, send: (text: string) => void): void;
  },
): HostTerminal {
  listen(api);
  let attached = false;
  let gone = false;
  let cwd = '';
  let frames = 0;
  const renderer = createRenderer(el, {
    linkHint: LINK_HINT,
    linkModifier: isLinkModifier,
    colors: opts.colors ?? NO_COLORS,
    openUrl: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
  });
  const send = (cmd: unknown) => {
    if (attached && !gone) api.paneCommand(paneId, cmd);
  };

  listeners.set(paneId, {
    frame: (f) => {
      frames++;
      renderer.write(decodeBase64(f.bytes), f.cols, f.rows);
    },
    closed: (reason) => {
      if (gone) return;
      gone = true;
      attached = false;
      opts.onGone(reason, true);
    },
    panes: (c, title) => {
      cwd = c;
      if (title) opts.onTitle?.(title);
    },
  });

  renderer.onData((data) => {
    if (gone) {
      opts.onKey?.();
      return;
    }
    send({ type: 'terminal.input', bytes: encodeInput(data) });
  });
  const wheel = createWheelAccumulator();
  renderer.onWheel((ev) => {
    const m = renderer.metrics();
    if (!m) return;
    const scroll = wheel(ev.deltaY, m.cellHeight, ev.deltaMode);
    if (scroll) send({ type: 'terminal.scroll', ...scroll });
  });
  const disposeMouse = attachTerminalMouse(el, renderer, {
    mouse: (cmd) => send({ type: 'terminal.mouse', ...cmd }),
    copyRange: (anchor, cursor) => {
      if (!attached) return;
      // Started now, inside the gesture: the clipboard refuses a write after it.
      void api.readSelection(paneId, anchor, cursor).then((text) => {
        if (text) return navigator.clipboard?.writeText(text);
      }).catch(() => {});
    },
    openLink: (link: Link) => {
      if (link.kind === 'url') {
        window.open(link.url, '_blank', 'noopener,noreferrer');
        return;
      }
      const path = resolvePath(cwd, link.path);
      if (path === null) return;
      api.openFile({
        path,
        ...(link.line !== undefined ? { line: link.line } : {}),
        ...(link.column !== undefined ? { column: link.column } : {}),
      });
    },
    contextMenu: () => api.contextMenu(paneId),
    frames: () => frames,
    linkModifier: isLinkModifier,
    active: () => attached && !gone,
  });

  const paste = (text: string) =>
    send({ type: 'terminal.input', bytes: encodeInput(wrapPaste(text)) });
  // Every paste is sent here, not typed by xterm.js: its bracketed-paste state is not the app's.
  el.addEventListener('paste', (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text || gone) return;
    if (/[\r\n]/.test(text.replace(/[\r\n]+$/, ''))) {
      opts.confirmPaste(text, paste);
    } else paste(text);
  }, true);

  let size: { cols: number; rows: number } | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const fit = () => {
    if (el.clientHeight < 40 || el.clientWidth < 40) return;
    const next = renderer.resize();
    if (next === null) return;
    if (size && size.cols === next.cols && size.rows === next.rows) return;
    size = next;
    send({ type: 'terminal.resize', cols: next.cols, rows: next.rows });
  };
  const observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fit, 100);
  });
  observer.observe(el);

  // Once laid out: Herdr takes the size it is attached at.
  requestAnimationFrame(() => {
    if (gone) return;
    const dims = el.clientHeight >= 40 ? renderer.resize() : null;
    size = dims;
    api.attach(paneId, dims?.cols ?? 80, dims?.rows ?? 24).then((r) => {
      if (gone) {
        api.release(paneId);
        return;
      }
      attached = true;
      cwd = r.cwd;
    }).catch((e) => {
      gone = true;
      opts.onGone(String(e?.message ?? e), false);
    });
  });

  return {
    paneId,
    renderer,
    focus: () => renderer.focus(),
    setColors: (c) => renderer.setColors(c),
    paste,
    dispose: (release) => {
      const was = attached && !gone;
      gone = true;
      attached = false;
      listeners.delete(paneId);
      clearTimeout(resizeTimer);
      observer.disconnect();
      disposeMouse();
      renderer.dispose();
      if (release && was) api.release(paneId);
    },
  };
}

/** Writes a dim note into a terminal (a gone pane, a refusal). */
export function writeNote(t: { renderer: Renderer }, text: string): void {
  t.renderer.write(new TextEncoder().encode(`\r\n\x1b[2m${text}\x1b[0m\r\n`));
}
