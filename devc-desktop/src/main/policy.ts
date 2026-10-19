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

/**
 * Where the views go in a `width` × `height` content area: devc web (or the status view) on top,
 * the host drawer below it when open. A closed drawer has no rectangle. The two never overlap, so
 * devc web never draws over the host terminal.
 */
export function layout(
  width: number,
  height: number,
  drawer: number | null,
): { main: Rect; host: Rect | null } {
  if (drawer === null) {
    return { main: { x: 0, y: 0, width, height }, host: null };
  }
  const h = clampDrawer(drawer, height);
  return {
    main: { x: 0, y: 0, width, height: height - h },
    host: { x: 0, y: height - h, width, height: h },
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
