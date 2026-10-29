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
 * The permissions the Containers pane is granted: copying, as devc web's views, and reaching
 * devc web's server on this machine's loopback, which Chromium asks for as a local network
 * access from a `file:` page. Its page's CSP keeps it to `127.0.0.1`.
 */
const CONTAINERS_PERMISSIONS = new Set([
  ...DEVC_PERMISSIONS,
  'local-network-access',
  'loopback-network',
  'local-network',
]);

export function containersPermission(permission: string): boolean {
  return CONTAINERS_PERMISSIONS.has(permission);
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
 * The closed drawer's height while host actions wait (`peek`): just its HOST strip, with the
 * badge. It never opens the drawer or takes focus.
 */
export const HOST_PEEK = 24;

/**
 * devc web's host status strip (`/host-status`) across the foot of the window, in pixels: usage,
 * devc-bridge, live reload's pause and the connection dot.
 */
export const FOOTER_HEIGHT = 24;

/** The rail between the left column and `/main`, in pixels: an app-owned view, dragged sideways. */
export const RAIL = 6;
/** The left column's smallest width (devc web's `/sidebar` and the Containers pane). */
export const SIDEBAR_MIN = 220;
/** The left column's width before the user has dragged the rail. */
export const SIDEBAR_DEFAULT = 340;
/** `/main`'s smallest width: it keeps it before the column keeps its own. */
export const MAIN_MIN = 360;
/** The smallest height of each pane in the column: `/sidebar` above, Containers below. */
export const PANE_MIN = 120;
/** The Containers pane's height before the user has dragged its strip, as a share of the column. */
export const CONTAINERS_DEFAULT_SHARE = 0.45;

/** What {@link layout} lays out: the window's content size, and what the user chose. */
export interface LayoutInput {
  width: number;
  height: number;
  /** The left column's width as dragged, `null` before any drag. */
  sidebarWidth: number | null;
  /**
   * Whether the Containers pane shows, and its height as dragged (`null`: the default); with
   * `folded`, its section is folded and the pane is that high (down to its heading) instead.
   */
  containers: { height: number | null; folded?: number } | null;
  /** The drawer's height while open, else `null`. */
  drawer: number | null;
  /** A closed drawer's strip shows (host actions wait). */
  peek: boolean;
  /** devc web's host status strip shows across the foot of the window. */
  footer: boolean;
}

/** Where each view goes: see {@link layout}. */
export interface Layout {
  bar: Rect;
  /** devc web's `/sidebar`: the top of the left column. */
  sidebar: Rect;
  /** The app's Containers pane, below it; `null` while hidden. */
  containers: Rect | null;
  /** The app's rail between the column and `/main`. */
  rail: Rect;
  /** devc web's `/main` (or the status view's right-hand part). */
  main: Rect;
  /** The host drawer, under `/main` only; `null` while closed with nothing waiting. */
  host: Rect | null;
  /** devc web's `/host-status`, across the window under everything else; `null` while hidden. */
  footer: Rect | null;
}

/**
 * Where the views go in a `width` × `height` content area: the title bar across the top; below
 * it the left column (devc web's `/sidebar`, the Containers pane under it), the rail, and on the
 * right `/main` with the host drawer under it; with `footer`, devc web's host status strip across
 * the whole width at the bottom ({@link FOOTER_HEIGHT}). A closed drawer has no rectangle, unless `peek`:
 * then only its strip ({@link HOST_PEEK}) shows. None overlap, so devc web never draws over an
 * app view. A window too small for every minimum gives `/main` its width first, then the column
 * (the rail last); the column gives `/sidebar` its height before Containers.
 */
export function layout(i: LayoutInput): Layout {
  const width = Math.max(0, i.width);
  const height = Math.max(0, i.height);
  const top = Math.min(TITLEBAR_HEIGHT, height);
  const bar = { x: 0, y: 0, width, height: top };
  const footH = i.footer ? Math.min(FOOTER_HEIGHT, height - top) : 0;
  const area = Math.max(0, height - top - footH);
  const mainMin = Math.min(MAIN_MIN, width);
  const railW = Math.min(RAIL, width - mainMin);
  const colMax = width - mainMin - railW;
  const col = Math.round(
    Math.min(colMax, Math.max(SIDEBAR_MIN, i.sidebarWidth ?? SIDEBAR_DEFAULT)),
  );
  const mx = col + railW;
  const mw = width - mx;
  const hostH = i.drawer !== null
    ? Math.min(area, clampDrawer(i.drawer, area))
    : i.peek
    ? Math.min(HOST_PEEK, area)
    : 0;
  const main = { x: mx, y: top, width: mw, height: area - hostH };
  const host = i.drawer !== null || i.peek
    ? { x: mx, y: top + area - hostH, width: mw, height: hostH }
    : null;
  let ch = 0;
  if (i.containers?.folded !== undefined) {
    ch = Math.round(Math.max(0, Math.min(area, i.containers.folded)));
  } else if (i.containers !== null) {
    const wanted = i.containers.height ?? area * CONTAINERS_DEFAULT_SHARE;
    ch = Math.round(
      Math.max(0, Math.min(area - PANE_MIN, Math.max(PANE_MIN, wanted))),
    );
  }
  return {
    bar,
    sidebar: { x: 0, y: top, width: col, height: area - ch },
    containers: i.containers === null
      ? null
      : { x: 0, y: top + area - ch, width: col, height: ch },
    rail: { x: col, y: top, width: railW, height: area },
    main,
    host,
    footer: i.footer ? { x: 0, y: top + area, width, height: footH } : null,
  };
}

/** The left column's width after dragging the rail by `dx`, as {@link layout} will keep it. */
export function dragColumn(
  from: number | null,
  dx: number,
  width: number,
): number {
  const max = Math.max(0, width - Math.min(MAIN_MIN, width) - RAIL);
  return Math.round(
    Math.min(max, Math.max(SIDEBAR_MIN, (from ?? SIDEBAR_DEFAULT) + dx)),
  );
}

/**
 * The Containers pane's height after dragging its strip by `dy` (down shrinks it), as
 * {@link layout} will keep it in a column `area` high.
 */
export function dragContainers(
  from: number | null,
  dy: number,
  area: number,
): number {
  const h = (from ?? area * CONTAINERS_DEFAULT_SHARE) - dy;
  return Math.round(
    Math.max(0, Math.min(area - PANE_MIN, Math.max(PANE_MIN, h))),
  );
}

// ---- the overlay menu ---------------------------------------------------------------------------
// A trusted pane's right-click menu is drawn by the app's overlay view, on top of every other
// view, so it can spread past the pane. Only a trusted pane (the Containers pane) may open it,
// never devc web's views: it would let the page put its text in trusted-looking UI.

/** The overlay page draws its box inset by this much, so its shadow fits inside the view. */
export const MENU_MARGIN = 8;
/** The most items an overlay menu shows. */
export const MENU_ITEMS_MAX = 64;

/** One overlay menu item: a label, red when it is `danger`; `null` is a divider. */
export type MenuEntry = { label: string; danger: boolean } | null;

/**
 * A pane's `{ items, x, y }`, checked: at most {@link MENU_ITEMS_MAX} items, each a divider or a
 * label shown as text ({@link showText}, at most 120 characters), and a point inside the pane
 * (`pane`: its size). `null` when it is none of that.
 */
export function menuRequest(
  v: unknown,
  pane: { width: number; height: number },
): { items: MenuEntry[]; x: number; y: number } | null {
  if (typeof v !== 'object' || v === null) return null;
  const { items, x, y } = v as Record<string, unknown>;
  if (!Array.isArray(items) || items.length === 0) return null;
  if (items.length > MENU_ITEMS_MAX) return null;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!(x >= 0 && x <= pane.width && y >= 0 && y <= pane.height)) return null;
  const out: MenuEntry[] = [];
  for (const it of items) {
    if (it === null) {
      out.push(null);
      continue;
    }
    if (typeof it !== 'object') return null;
    const { label, danger } = it as Record<string, unknown>;
    if (typeof label !== 'string' || label === '') return null;
    out.push({ label: showText(label, 120), danger: danger === true });
  }
  return { items: out, x, y };
}

/**
 * Where the overlay goes for a menu `size` big (as its page measured it) asked for at `at`
 * (window coordinates): its box's corner at the point, opening left of it or above it when it
 * would cross the window's right or bottom edge, then shifted to stay inside the window. Only
 * the window's edges count, never a pane's. A menu taller or wider than the window is cut to
 * it, and its page scrolls.
 */
export function placeMenu(
  at: { x: number; y: number },
  size: { width: number; height: number },
  win: { width: number; height: number },
): Rect {
  const w = Math.min(Math.ceil(size.width) + 2 * MENU_MARGIN, win.width);
  const h = Math.min(Math.ceil(size.height) + 2 * MENU_MARGIN, win.height);
  let x = at.x - MENU_MARGIN;
  let y = at.y - MENU_MARGIN;
  if (x + w > win.width) x = at.x - w + MENU_MARGIN;
  if (y + h > win.height) y = at.y - h + MENU_MARGIN;
  x = Math.max(0, Math.min(x, win.width - w));
  y = Math.max(0, Math.min(y, win.height - h));
  return { x: Math.round(x), y: Math.round(y), width: w, height: h };
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
  const refused = await shownFolderRefusal(real, fs);
  return refused === null
    ? { ok: true, path: real, mount: realMount }
    : { ok: false, label: refused };
}

/** Why the realpath `real` can't be offered: not a folder, or a name that can't be shown. */
async function shownFolderRefusal(
  real: string,
  fs: CdFs,
): Promise<string | null> {
  try {
    if (!(await fs.stat(real)).isDirectory()) return 'Not a folder';
  } catch {
    return 'Not a folder';
  }
  if (real.length > MAX_SHOWN || UNSHOWABLE.test(real)) {
    return "The folder's name can't be shown safely";
  }
  return null;
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

// ---- host actions -----------------------------------------------------------------------------
// devc web's page can ask for a push or a project start (`request_push`, `request_project`); the
// app reads the requests from devc web's server (`GET /desktop/requests`, the desktop token),
// works out what would happen itself, and shows it in the drawer's Actions column for the user
// to confirm. The page, the server's queue and the repo's own text all feed what is shown, so
// everything is checked here first. Why: `.plans/devc-desktop-host-actions.md`.

/** What a request asks for. */
export type ActionKind = 'push' | 'start' | 'stop' | 'down';

/** One request, as devc web's server holds it. */
export interface ActionRequest {
  id: string;
  kind: ActionKind;
  localFolder: string;
  /** The repo folder, for a push; `null` otherwise. */
  folder: string | null;
  at: number;
}

/** The most requests the server keeps, and so the most an answer may carry. */
export const MAX_REQUESTS = 20;

const ACTION_KINDS: readonly string[] = ['push', 'start', 'stop', 'down'];

/** A folder a request may name: a path, at most {@link MAX_SHOWN} long, and showable. */
const requestFolder = (v: unknown): v is string =>
  pathLike(v) && v.length <= MAX_SHOWN && !UNSHOWABLE.test(v);

/**
 * `GET /desktop/requests`'s answer, or `null` when it isn't one: a `seq`, and at most
 * {@link MAX_REQUESTS} well-formed requests, each with a short hex id, a known kind, and
 * showable folders (a push's repo folder, `null` for the others).
 */
export function requestsAnswer(
  v: unknown,
): { seq: number; requests: ActionRequest[] } | null {
  if (typeof v !== 'object' || v === null) return null;
  const { seq, requests } = v as Record<string, unknown>;
  if (!Number.isSafeInteger(seq) || (seq as number) < 0) return null;
  if (!Array.isArray(requests) || requests.length > MAX_REQUESTS) return null;
  const out: ActionRequest[] = [];
  const ids = new Set<string>();
  for (const r of requests) {
    if (typeof r !== 'object' || r === null) return null;
    const { id, kind, localFolder, folder, at } = r as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[0-9a-f]{1,64}$/.test(id)) return null;
    if (ids.has(id)) return null;
    ids.add(id);
    if (typeof kind !== 'string' || !ACTION_KINDS.includes(kind)) return null;
    if (!requestFolder(localFolder)) return null;
    if (kind === 'push' ? !requestFolder(folder) : folder !== null) {
      return null;
    }
    if (typeof at !== 'number' || !Number.isFinite(at)) return null;
    out.push({
      id,
      kind: kind as ActionKind,
      localFolder,
      folder: folder as string | null,
      at,
    });
  }
  return { seq: seq as number, requests: out };
}

/**
 * A request from the app's own Containers pane (a push of `folder`, a repo of the project at
 * `localFolder`, or a container `start`, `stop` or `down` of `localFolder`), as an
 * {@link ActionRequest} with `id`; `null` when it isn't one. It is checked as the server's
 * requests are: a known kind and showable folders.
 */
export function paneRequest(
  id: string,
  kind: unknown,
  localFolder: unknown,
  folder: unknown,
  at: number,
): ActionRequest | null {
  if (typeof kind !== 'string' || !ACTION_KINDS.includes(kind)) return null;
  if (!requestFolder(localFolder)) return null;
  if (kind === 'push' && !requestFolder(folder)) return null;
  return {
    id,
    kind: kind as ActionKind,
    localFolder,
    folder: kind === 'push' ? folder as string : null,
    at,
  };
}

export type HostFolder = { ok: true; path: string } | {
  ok: false;
  label: string;
};

/**
 * The folder on this machine a request names, checked as the `cd` item's is, without the mount:
 * absolute, its realpath (symlinks resolved here), a directory, and a showable name of at most
 * 256 characters. The realpath is what the app runs `devc git` on; the label says why not.
 */
export async function hostFolder(v: unknown, fs: CdFs): Promise<HostFolder> {
  if (!pathLike(v)) return { ok: false, label: 'devc web gave no folder' };
  let real: string;
  try {
    real = await fs.realpath(v);
  } catch {
    return { ok: false, label: "The folder doesn't exist on this machine" };
  }
  const refused = await shownFolderRefusal(real, fs);
  return refused === null
    ? { ok: true, path: real }
    : { ok: false, label: refused };
}

/** `devc git push-plan`'s answer (`devc/git_push.ts`'s `PushPlan`), checked. */
export type PushPlan =
  | {
    ok: true;
    folder: string;
    remote: string;
    branch: string;
    sha: string;
    remoteSha: string | null;
    commits: { sha: string; subject: string; author: string }[];
    totalCommits: number;
    defaultBranch: boolean;
    guarded: string[];
    lfs: boolean;
    fastForward: boolean;
    upToDate: boolean;
  }
  | { ok: false; problem: string };

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const isStr = (v: unknown, max = 4096): v is string =>
  typeof v === 'string' && v.length <= max;

/**
 * `devc git push-plan`'s stdout as a {@link PushPlan}, or a refusal saying it printed something
 * else. `subject`, `author` and `guarded` are the repo's text, which whoever wrote the commits
 * chose: they pass as strings here and are shown as text only ({@link showText}).
 */
export function pushPlanFrom(stdout: string): PushPlan {
  const unexpected = {
    ok: false as const,
    problem: 'devc git push-plan printed something unexpected',
  };
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return unexpected;
  }
  if (typeof v !== 'object' || v === null) return unexpected;
  const p = v as Record<string, unknown>;
  if (p.ok === false) {
    return isStr(p.problem) ? { ok: false, problem: p.problem } : unexpected;
  }
  if (p.ok !== true) return unexpected;
  const commits = p.commits;
  const good = isStr(p.folder) && isStr(p.remote) && isStr(p.branch, 256) &&
    isStr(p.sha) && SHA.test(p.sha) &&
    (p.remoteSha === null || (isStr(p.remoteSha) && SHA.test(p.remoteSha))) &&
    Array.isArray(commits) && commits.length <= 50 &&
    commits.every((c) =>
      typeof c === 'object' && c !== null && isStr(c.sha) && SHA.test(c.sha) &&
      isStr(c.subject) && isStr(c.author)
    ) &&
    Number.isSafeInteger(p.totalCommits) &&
    (p.totalCommits as number) >= commits.length &&
    typeof p.defaultBranch === 'boolean' && Array.isArray(p.guarded) &&
    p.guarded.length <= 1000 && p.guarded.every((g) => isStr(g)) &&
    typeof p.lfs === 'boolean' && typeof p.fastForward === 'boolean' &&
    typeof p.upToDate === 'boolean';
  if (!good) return unexpected;
  return {
    ok: true,
    folder: p.folder as string,
    remote: p.remote as string,
    branch: p.branch as string,
    sha: p.sha as string,
    remoteSha: p.remoteSha as string | null,
    commits: (commits as { sha: string; subject: string; author: string }[])
      .map(({ sha, subject, author }) => ({ sha, subject, author })),
    totalCommits: p.totalCommits as number,
    defaultBranch: p.defaultBranch as boolean,
    guarded: p.guarded as string[],
    lfs: p.lfs as boolean,
    fastForward: p.fastForward as boolean,
    upToDate: p.upToDate as boolean,
  };
}

/** Whether a plan can be pushed: `devc git push` would refuse an LFS pointer or a non-fast-forward. */
export function canPush(plan: PushPlan): boolean {
  return plan.ok && !plan.lfs && plan.fastForward && !plan.upToDate;
}

/** What the user should know before pushing `plan`, one line each. */
export function planWarnings(plan: PushPlan): string[] {
  if (!plan.ok) return [];
  const out: string[] = [];
  if (plan.upToDate) out.push('Up to date: nothing to push');
  if (plan.defaultBranch) {
    out.push(`Pushes the default branch (${showText(plan.branch, 80)})`);
  }
  if (plan.guarded.length > 0) {
    const shown = plan.guarded.slice(0, 5).map((g) => showText(g, 80));
    const more = plan.guarded.length > 5
      ? ` and ${plan.guarded.length - 5} more`
      : '';
    out.push(`Changes workflows: ${shown.join(', ')}${more}`);
  }
  if (!plan.fastForward) {
    out.push('Not a fast-forward of the remote branch: it would be refused');
  }
  if (plan.lfs) out.push('Adds an LFS pointer: it would be refused');
  return out;
}

const UNSHOWABLE_ALL = new RegExp(UNSHOWABLE.source, 'g');

/**
 * `s` as the Actions column shows it: controls, bidi overrides and zero-width characters (which
 * could make it read as something else) as U+FFFD, and at most `max` characters, `…` after.
 */
export function showText(s: string, max = 200): string {
  const clean = s.replace(UNSHOWABLE_ALL, '\ufffd');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** How long a request's confirm button stays disabled after its content last changed. */
export const ARM_MS = 1000;

/** Whether a request whose content last changed at `changedAt` may be confirmed at `now`. */
export function armed(changedAt: number, now: number): boolean {
  return now - changedAt >= ARM_MS;
}

/** The HOST strip's badge: `1 request`, `3 requests`, or nothing. */
export function badgeText(n: number): string {
  return n === 0 ? '' : n === 1 ? '1 request' : `${n} requests`;
}

/** Where a request is: checked, its plan worked out, confirmed and running, or finished. */
export type ActionPhase =
  | 'checking'
  | 'planning'
  | 'ready'
  | 'refused'
  | 'running'
  | 'done';

/** What the main process knows about one request. */
export interface ActionState {
  req: ActionRequest;
  phase: ActionPhase;
  /** The checked folder (the push's repo, or the project), once checked. */
  target: HostFolder | null;
  plan: PushPlan | null;
  lines: string[];
  outcome: { ok: boolean; text: string } | null;
}

/** One card in the Actions column, as the host page draws it: text only. */
export interface ActionCard {
  id: string;
  kind: ActionKind;
  title: string;
  folder: string;
  phase: ActionPhase;
  refusal: string | null;
  plan: {
    branch: string;
    remote: string;
    sha: string;
    commits: { sha: string; subject: string; author: string }[];
    more: number;
  } | null;
  warnings: string[];
  notes: string[];
  /** The confirm button's label, `null` when there is nothing to confirm. */
  confirm: string | null;
  lines: string[];
  outcome: { ok: boolean; text: string } | null;
}

const ACTION_TITLES: Record<ActionKind, string> = {
  push: 'Push',
  start: 'Start container',
  stop: 'Stop',
  down: 'Remove container',
};

/** The most output lines a card keeps. */
export const ACTION_LINES = 200;

/**
 * The card for `a`. `checkout` names the `devc` the app runs when it comes from the checkout
 * (`devc2`), which every push card says, since a container may have written that code.
 */
export function actionCard(
  a: ActionState,
  checkout: string | null,
): ActionCard {
  const { req } = a;
  const refusal = a.target !== null && !a.target.ok
    ? a.target.label
    : a.plan !== null && !a.plan.ok
    ? showText(a.plan.problem, 300)
    : null;
  const plan = a.plan?.ok
    ? {
      branch: showText(a.plan.branch, 80),
      remote: showText(a.plan.remote, 120),
      sha: a.plan.sha.slice(0, 12),
      commits: a.plan.commits.map((c) => ({
        sha: c.sha.slice(0, 7),
        subject: showText(c.subject, 120),
        author: showText(c.author, 60),
      })),
      more: a.plan.totalCommits - a.plan.commits.length,
    }
    : null;
  const notes: string[] = [];
  if (req.kind === 'start') {
    notes.push(
      "Runs its devcontainer.json's initializeCommand on this machine",
    );
  }
  if (req.kind === 'push' && checkout !== null) {
    notes.push(
      `Runs devc from the checkout (${
        showText(checkout, 120)
      }), which a container may have written`,
    );
  }
  const confirmable = a.phase === 'ready' && refusal === null &&
    (req.kind !== 'push' || (a.plan !== null && canPush(a.plan)));
  return {
    id: req.id,
    kind: req.kind,
    title: ACTION_TITLES[req.kind],
    folder: a.target?.ok
      ? a.target.path
      : showText(req.kind === 'push' ? req.folder ?? '' : req.localFolder, 256),
    phase: a.phase,
    refusal,
    plan,
    warnings: a.plan ? planWarnings(a.plan) : [],
    notes,
    confirm: confirmable ? ACTION_TITLES[req.kind] : null,
    lines: a.lines.map((l) => showText(l, 300)),
    outcome: a.outcome &&
      { ok: a.outcome.ok, text: showText(a.outcome.text, 300) },
  };
}

/** What `devc git push`'s exit code means, for the card's outcome. */
export function pushOutcome(
  code: string,
  lastLine: string | undefined,
): { ok: boolean; text: string } {
  if (code === '0') return { ok: true, text: lastLine ?? 'pushed' };
  const why: Record<string, string> = {
    '2': 'the branch moved, or another problem',
    '3': 'an LFS pointer cannot be published',
    '4': 'not a fast-forward, or the push failed',
  };
  return {
    ok: false,
    text: lastLine ?? `devc git push failed (${why[code] ?? code})`,
  };
}
