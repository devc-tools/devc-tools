// The rules that keep devc web (an agent can control its page) away from the host terminal, and
// the drawer's geometry: pure functions, so each is unit-tested. `main.ts` applies them to the
// views. Why these rules: `.plans/devc-desktop-electron.md` ("The devc view", "The host view")
// and the measurements in `.plans/archived/devc-desktop-host-terminal.md`.

/** devc web's origin (`http://127.0.0.1:<port>`) from its ready-line URL. */
export function devcOrigin(pageUrl: string): string {
  return new URL(pageUrl).origin;
}

/**
 * Whether the devc view may go to `target`: only devc web's own origin, which covers its reloads,
 * `/safe/` and hash changes. Anything else (another site, the host page, `file:`) is refused.
 */
export function devcMayNavigate(target: string, origin: string): boolean {
  try {
    return new URL(target).origin === origin;
  } catch {
    return false;
  }
}

/**
 * The URL a `window.open` from devc web is handed to the system browser as: `http:` and `https:`
 * only. Never a window of this app; any other scheme (`file:`, `javascript:`, a custom one) is
 * dropped.
 */
export function externalUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * The permissions devc web is granted: copying (Copy page URL, copy-on-select). Everything else
 * is refused: reading the clipboard (it would see what the host terminal copied), fullscreen
 * (it would cover the window), media, notifications, pointer lock and the rest.
 */
const DEVC_PERMISSIONS = new Set(['clipboard-sanitized-write']);

export function devcPermission(permission: string): boolean {
  return DEVC_PERMISSIONS.has(permission);
}

/**
 * Chromium and Electron switches that open a debugging door into every view (the host terminal's
 * included), whether on the command line or through Node's own flags.
 */
const DEBUG_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'inspect',
  'inspect-brk',
  'inspect-port',
  'inspect-publish-uid',
];

/**
 * Why the host terminal must not start, or `null`: the app was started with a debugging switch,
 * so anything that can reach that port could drive the host shell.
 */
export function debugReason(
  hasSwitch: (name: string) => boolean,
  execArgv: string[],
): string | null {
  const on = DEBUG_SWITCHES.filter((s) =>
    hasSwitch(s) ||
    execArgv.some((a) => a === `--${s}` || a.startsWith(`--${s}=`))
  );
  return on.length === 0
    ? null
    : `the app was started with --${
      on[0]
    }, which would let any local process drive this terminal`;
}

/**
 * The arguments a terminal launch passes on to `devc web`: everything after the executable (and,
 * running from source, after the app path), less the switches Chromium and Electron take for
 * themselves.
 */
export function appArgs(argv: string[], packaged: boolean): string[] {
  return argv.slice(packaged ? 1 : 2).filter((a) =>
    !CHROMIUM_SWITCH.test(a) && !a.startsWith('-psn_')
  );
}

const CHROMIUM_SWITCH =
  /^--(remote-debugging-[a-z-]+|inspect[a-z-]*|no-sandbox|disable-gpu[a-z-]*|enable-logging|v|vmodule|ozone-platform[a-z-]*|enable-features|disable-features|lang|user-data-dir|enable-crash-reporter|trace-[a-z-]+)(=.*)?$/;

/** A view's rectangle in the window's content area. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The drawer's smallest height, in pixels. */
export const DRAWER_MIN = 120;
/** The drawer's largest height, as a share of the content height. */
export const DRAWER_MAX_SHARE = 0.85;
/** The drawer's height before the user has dragged it, as a share of the content height. */
export const DRAWER_DEFAULT_SHARE = 0.4;

/** `height` kept between {@link DRAWER_MIN} and {@link DRAWER_MAX_SHARE} of `total`. */
export function clampDrawer(height: number, total: number): number {
  const max = Math.max(DRAWER_MIN, Math.floor(total * DRAWER_MAX_SHARE));
  return Math.round(Math.min(max, Math.max(DRAWER_MIN, height)));
}

/** The title bar's height, in pixels: the window's own bar is hidden, and this one is drawn. */
export const TITLEBAR_HEIGHT = 32;

/**
 * Where the views go in a `width` × `height` content area: the title bar across the top, devc web
 * (or the status view) below it, and the host drawer at the bottom when open. A closed drawer has
 * no rectangle. None overlap, so devc web never draws over the host terminal. `drawer` is clamped
 * against the height below the title bar.
 */
export function layout(
  width: number,
  height: number,
  drawer: number | null,
): { bar: Rect; main: Rect; host: Rect | null } {
  const bar = { x: 0, y: 0, width, height: TITLEBAR_HEIGHT };
  const top = TITLEBAR_HEIGHT;
  const area = Math.max(0, height - top);
  if (drawer === null) {
    return { bar, main: { x: 0, y: top, width, height: area }, host: null };
  }
  const h = clampDrawer(drawer, area);
  return {
    bar,
    main: { x: 0, y: top, width, height: area - h },
    host: { x: 0, y: top + area - h, width, height: h },
  };
}

/** What an IPC handler knows about its caller (Electron's `IpcMainEvent`, narrowed). */
export interface IpcCaller {
  sender: unknown;
  senderFrame: { url: string } | null;
}

/**
 * Whether an IPC message comes from `view`'s own page: sent by its `webContents`, from its main
 * frame, at the bundled `url` it was given. Any other sender (the devc view, a subframe, the view
 * after navigating elsewhere) is refused.
 */
export function fromView(
  e: IpcCaller,
  view: { webContents: unknown; mainFrame: unknown },
  url: string,
): boolean {
  return e.sender === view.webContents && e.senderFrame !== null &&
    e.senderFrame === view.mainFrame && stripHash(e.senderFrame.url) === url;
}

function stripHash(u: string): string {
  const i = u.indexOf('#');
  return i < 0 ? u : u.slice(0, i);
}

// ---- the host terminal's `cd` item -----------------------------------------------------------
// devc web's server names the host folder behind devc web's active terminal pane
// (`GET /desktop/active-folder`). The page, Herdr and the container all feed that answer, so
// it is checked here before anything is shown or typed. Why: `.plans/devc-desktop-host-cd.md`.

/** devc web's token, from its ready-line URL's `#token=`; `null` without one. */
export function devcToken(pageUrl: string): string | null {
  const m = /#token=([0-9a-f]{64})$/.exec(pageUrl);
  return m ? m[1] : null;
}

/** The longest folder the menu shows: a longer one could be cut off where the user can't see. */
const MAX_SHOWN = 256;

/** Controls, bidi overrides and zero-width characters: a name with one may not read as it is. */
const UNSHOWABLE = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/;

const NO_FOLDER = 'devc web gave no folder';

const REASON_LABELS: Record<string, string> = {
  no_active_pane: 'No active terminal in devc web',
  no_session: "Its container isn't running",
  no_cwd: "The terminal's folder isn't known",
  not_mounted: "The terminal's folder isn't mounted from this machine",
};

export interface CdFs {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
}

export type CdTarget =
  | { ok: true; path: string; mount: string }
  | { ok: false; label: string };

const pathLike = (v: unknown): v is string =>
  typeof v === 'string' && v.startsWith('/') && v.length <= 4096 &&
  !v.includes('\0');

/**
 * The folder the host terminal may `cd` to, from devc web's answer: its realpath, which must be
 * the mount's own realpath or inside it (a container can plant `x -> /etc` in a mount, which on
 * this machine is this machine's `/etc`), a directory, and showable. Otherwise the disabled
 * item's label.
 */
export async function cdTarget(answer: unknown, fs: CdFs): Promise<CdTarget> {
  const a = typeof answer === 'object' && answer !== null
    ? answer as Record<string, unknown>
    : {};
  if (a.ok !== true) {
    const label = typeof a.reason === 'string'
      ? REASON_LABELS[a.reason]
      : undefined;
    return { ok: false, label: label ?? NO_FOLDER };
  }
  if (!pathLike(a.folder) || !pathLike(a.mount)) {
    return { ok: false, label: NO_FOLDER };
  }
  let real: string, realMount: string;
  try {
    real = await fs.realpath(a.folder);
    realMount = await fs.realpath(a.mount);
  } catch {
    return { ok: false, label: "The folder doesn't exist on this machine" };
  }
  const inside = real === realMount ||
    real.startsWith(realMount.endsWith('/') ? realMount : `${realMount}/`);
  if (!inside) return { ok: false, label: 'The folder is outside its mount' };
  try {
    if (!(await fs.stat(real)).isDirectory()) {
      return { ok: false, label: 'Not a folder' };
    }
  } catch {
    return { ok: false, label: 'Not a folder' };
  }
  if (real.length > MAX_SHOWN || UNSHOWABLE.test(real)) {
    return { ok: false, label: "The folder's name can't be shown safely" };
  }
  return { ok: true, path: real, mount: realMount };
}

/** `p` in single quotes for bash, zsh and fish: each `'` becomes `'\''`. */
export function shellQuote(p: string): string {
  return `'${p.replaceAll("'", "'\\''")}'`;
}

/**
 * The longest label the menu shows in full: Chromium's menus on Linux cut a label off at about
 * 800 px, with no ellipsis.
 */
export const MAX_LABEL = 80;

/**
 * The menu item's label, `cd <folder>` and then `suffix`, at most {@link MAX_LABEL} characters;
 * `null` when it can't fit. The folder shows `~` for `home`. When that is too long, the mount's
 * part (the host's own, from its mount table) shortens to `…/<mount's name>`. The part below
 * the mount, which a container chose, always shows in full. Electron reads `&` as a mnemonic
 * marker on Windows and Linux, so there it is doubled to show as itself.
 */
export function menuLabel(
  target: { path: string; mount: string },
  home: string,
  platform: string,
  suffix = '',
): string | null {
  const tilde = (p: string) =>
    home !== '/' && (p === home || p.startsWith(`${home}/`))
      ? `~${p.slice(home.length)}`
      : p;
  const below = target.path.slice(target.mount.length).replace(/^\/*/, '');
  const short = `…/${baseName(target.mount)}${below ? `/${below}` : ''}`;
  const shown = [tilde(target.path), short]
    .map((f) => `cd ${f}${suffix}`)
    .find((l) => l.length <= MAX_LABEL);
  if (shown === undefined) return null;
  return platform === 'darwin' ? shown : shown.replaceAll('&', '&&');
}

/** The last segment of a path: node-pty names the foreground process by name or by path. */
export function baseName(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() ?? p;
}

/**
 * Whether the host shell is at its prompt: its foreground process (node-pty's `IPty.process`)
 * is the shell itself, compared by basename, a login shell's leading `-` dropped.
 */
export function shellIdle(foreground: string, shell: string): boolean {
  return baseName(foreground).replace(/^-/, '') === baseName(shell);
}
