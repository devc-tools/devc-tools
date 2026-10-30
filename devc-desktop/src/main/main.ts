// devc-desktop: `devc web` in its own window, with a host terminal devc web cannot reach.
//
// One BaseWindow holds these WebContentsViews, never frames of each other:
//   - devc web's three views, `/sidebar` (top of the left column), `/main` (the right) and
//     `/host-status` (its status strip across the foot of the window), paired by a view id
//     (`devc web --no-open …` runs as a child). Locked down because an agent can
//     control those pages: sandboxed, their own partition, no preload, no dialogs, no windows, no
//     navigation off devc web's origin, no permission but copying;
//   - the Containers pane (bundled page + preload), below `/sidebar` under its HOST strip:
//     devc web's Containers section built into the app, on `/ws` with the desktop token;
//   - the rail (bundled page + preload) between the column and `/main`, dragged to resize;
//   - the status view (bundled page + preload) while devc web starts, or after it stopped;
//   - the host view (bundled page + preload): a drawer under `/main` running the user's shell
//     through node-pty, opened only from the app menu;
//   - the title bar view (bundled page + preload): the OS's own bar is hidden, so this one draws
//     the title and drags the window; the window's buttons sit over it. The window's title is
//     still set as before, for the taskbar and anything else that reads it;
//   - the overlay menu (bundled page + preload), added last so it draws over every other view,
//     shown only while the Containers pane's right-click menu is open. A trusted view may draw
//     over devc web's, never the reverse: none of the others overlap.
// Why this shape, and what it was measured against: `.plans/devc-desktop-electron.md`.

import { readFile, realpath, stat } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  app,
  BaseWindow,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  session,
  shell,
  WebContentsView,
} from 'electron';
import * as nodePty from 'node-pty';
import {
  childEnv,
  desktopConfig,
  devcArgs,
  type DevcWeb,
  findDevc,
  type Found,
  globalConfigPath,
  loginEnv,
  looked,
  onPath,
  runDevcCommand,
  startDevcWeb,
} from './launch.ts';
import {
  ACTION_LINES,
  actionCard,
  type ActionState,
  appArgs,
  armed,
  baseName,
  type CdTarget,
  cdTarget,
  clampDrawer,
  containersPermission,
  debugReason,
  devcMayNavigate,
  devcOrigin,
  devcPermission,
  devcToken,
  dragColumn,
  dragContainers,
  DRAWER_DEFAULT_SHARE,
  externalUrl,
  FOOTER_HEIGHT,
  fromView,
  hostFolder,
  type Layout,
  layout,
  MAX_REQUESTS,
  menuLabel,
  menuRequest,
  paneRequest,
  placeMenu,
  pushOutcome,
  pushPlanFrom,
  type Rect,
  requestsAnswer,
  shellIdle,
  shellQuote,
  showText,
  TITLEBAR_HEIGHT,
} from './policy.ts';
import { accountShell, HostPty, hostShell, ptyEnv } from './pty.ts';

/**
 * devc's global config folder. Its `config.jsonc`, else its `config.json`, is where
 * `desktopWebArgs` and `desktopDevc` live: {@link globalConfigPath} picks, on every start.
 */
const CONFIG_DIR = join(app.getPath('home'), '.config/devc');
/** The drawer's height and the left column's sizes, remembered across launches. */
const STATE_PATH = join(app.getPath('userData'), 'desktop-state.json');
const IS_MAC = process.platform === 'darwin';
/**
 * The host terminal's toggle, as the drawer's strip names it: Ctrl+` everywhere (VS Code's
 * terminal toggle), and on macOS Cmd+J too (VS Code's panel toggle).
 */
const TOGGLE = IS_MAC ? 'Cmd+J or Ctrl+`' : 'Ctrl+`';
/** The title bar's colour (as in titlebar.css), and its window buttons' outside macOS. */
const TITLEBAR_COLOR = '#161922';
const TITLEBAR_SYMBOL_COLOR = '#d7dae0';
/**
 * The view id that pairs devc web's `/sidebar` and `/main` views and the Containers pane
 * (`#…&view=`): the server relays between them, and between nothing else.
 */
const VIEW = 'devcd';

/** A request as the app shows it: see `actions` in {@link main}. */
type Shown = ActionState & { changedAt: number; where: 'drawer' | 'pane' };

interface Status {
  phase: 'starting' | 'failed';
  message: string;
  stderr: string[];
}

let status: Status = { phase: 'starting', message: 'Starting…', stderr: [] };
let current: DevcWeb | null = null;
/** The child a restart is stopping, until it has exited. */
let retiring: Promise<void> | null = null;
let stopping = false;
/** devc web's origin while its page is shown; navigation off it is refused. */
let origin: string | null = null;
/** That devc web's token, for `/desktop/` requests. Never logged. */
let devcWebToken: string | null = null;
/**
 * That devc web's desktop token (`--desktop-channel`, read from its stdout), for
 * `/desktop/requests` and `/desktop/project`, and the Containers pane's `/ws`. Never logged,
 * never in a URL or an environment; the one view it is sent to is the pane, through its preload.
 */
let desktopToken: string | null = null;
/**
 * The `devc` the app last ran, for the host actions' `devc git`, and its command when it is the
 * checkout's (`devc2`): the push cards say so.
 */
let runner: { found: Found; checkout: string | null } | null = null;

/** The drawer's height in px, or `null` while closed; `drawerHeight` survives closing. */
let drawerOpen = false;
let drawerHeight: number | null = null;
/** The left column's width as dragged (`null`: the default), and the Containers pane's. */
let sidebarWidth: number | null = null;
/** Whether the left column (`/sidebar`, the Containers pane) shows: Layout → Sidebar. */
let columnOpen = true;
let containersOpen = true;
let containersHeight: number | null = null;
/**
 * The Containers pane's height while its section is folded (down to its heading, as the pane
 * measured it), `null` while open. The pane says which, each time it loads.
 */
let containersFolded: number | null = null;
/** The most a folded pane may ask for: its heading, and the cards above it. */
const FOLDED_MAX = 600;

if (process.env.DEVC_DESKTOP_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
}

const debugging = debugReason(
  (s) => app.commandLine.hasSwitch(s),
  process.execArgv,
);

void app.whenReady().then(main);

/** Everything after Electron is ready: the window, its views, devc web and the host terminal. */
async function main(): Promise<void> {
  const win = new BaseWindow({
    title: 'devcd',
    width: 1400,
    height: 900,
    backgroundColor: '#0d0f14',
    autoHideMenuBar: !IS_MAC,
    titleBarStyle: 'hidden',
    // macOS keeps its traffic lights, centred in the bar; elsewhere the overlay draws the buttons.
    ...(IS_MAC
      ? { trafficLightPosition: { x: 12, y: (TITLEBAR_HEIGHT - 16) / 2 } }
      : {
        titleBarOverlay: {
          color: TITLEBAR_COLOR,
          symbolColor: TITLEBAR_SYMBOL_COLOR,
          height: TITLEBAR_HEIGHT,
        },
      }),
  });

  const titleBarView = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'titlebar',
      preload: join(__dirname, 'preload-titlebar.js'),
    },
  });

  const statusView = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'status',
      preload: join(__dirname, 'preload-status.js'),
    },
  });
  /**
   * devc web's views: `/main` (`devcView`), `/sidebar` and `/host-status` (`footerView`, across
   * the foot of the window), one session between them.
   */
  const devcPrefs = {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    disableDialogs: true,
    partition: 'persist:devc',
  };
  const devcView = new WebContentsView({ webPreferences: devcPrefs });
  const sidebarView = new WebContentsView({ webPreferences: devcPrefs });
  const footerView = new WebContentsView({ webPreferences: devcPrefs });
  const containersView = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:containers',
      preload: join(__dirname, 'preload-containers.js'),
    },
  });
  const railView = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'rail',
      preload: join(__dirname, 'preload-rail.js'),
    },
  });
  const hostView = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:host',
      preload: join(__dirname, 'preload-host.js'),
    },
  });
  const menuView = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'menu',
      preload: join(__dirname, 'preload-menu.js'),
    },
  });
  for (
    const v of [
      statusView,
      sidebarView,
      devcView,
      footerView,
      containersView,
      hostView,
    ]
  ) {
    v.setBackgroundColor('#0d0f14');
    win.contentView.addChildView(v);
  }
  // Their pages paint their own background (the window's shows until they load): see-through,
  // they can spread over the window while a dialog is open and leave the rest of it showing. A
  // view's background set again after its page has loaded doesn't reach the page.
  for (const v of [sidebarView, devcView, containersView]) {
    v.setBackgroundColor('#00000000');
  }
  railView.setBackgroundColor('#303a49');
  win.contentView.addChildView(railView);
  titleBarView.setBackgroundColor(TITLEBAR_COLOR);
  win.contentView.addChildView(titleBarView);
  // The dimming under a devc web dialog where its view may not spread (see devc web's dialogs):
  // the dialog backdrop's black at 45%. Painted by a page of its own, script-free: a view with no
  // page draws no background.
  const dimView = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      partition: 'dim',
    },
  });
  dimView.setBackgroundColor('#00000000');
  dimView.setVisible(false);
  win.contentView.addChildView(dimView);
  void dimView.webContents.loadURL(
    'data:text/html,<html style="background:rgb(0 0 0 / 0.45);height:100%25"></html>',
  );
  dimView.webContents.on('will-navigate', (e) => e.preventDefault());
  dimView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Last, so it draws over every other view; transparent, so only its menu's box shows.
  menuView.setBackgroundColor('#00000000');
  menuView.setVisible(false);
  win.contentView.addChildView(menuView);

  const STATUS_URL = pageUrl('status.html');
  const HOST_URL = pageUrl('host.html');
  const TITLEBAR_URL = pageUrl('titlebar.html');
  const RAIL_URL = pageUrl('rail.html');
  const MENU_URL = pageUrl('menu.html');
  const CONTAINERS_URL = new URL(
    `file://${join(__dirname, 'containers', 'containers.html')}`,
  ).href;

  lockDownDevc();
  lockDownBundled(statusView, STATUS_URL);
  lockDownBundled(hostView, HOST_URL);
  lockDownBundled(titleBarView, TITLEBAR_URL);
  lockDownBundled(railView, RAIL_URL);
  lockDownBundled(menuView, MENU_URL);
  // The pane copies (a path, say) and opens links (a pull request) in the system browser.
  lockDownBundled(containersView, CONTAINERS_URL, {
    permission: containersPermission,
    external: true,
  });

  // ---- layout -------------------------------------------------------------------------------

  /** Shows devc web (`true`) or the status view in the top area, and the drawer when open. */
  let showingDevc = false;

  /**
   * Each request the app shows, by id (see host actions below), with when its content last
   * changed and where it shows: the drawer's (devc web's page asked) or the Containers pane's (its
   * own clicks asked).
   */
  const actions = new Map<string, Shown>();
  /** How many requests the drawer shows: a closed drawer peeks while there are any. */
  const drawerActions = () =>
    [...actions.values()].filter((a) => a.where === 'drawer').length;

  /** The height between the title bar and devc web's host status strip, for a `height` window. */
  const areaOf = (height: number) =>
    height - TITLEBAR_HEIGHT - (showingDevc ? FOOTER_HEIGHT : 0);

  /** The drawer's height while open, before {@link layout} clamps it to the window. */
  function drawerWanted(area: number): number {
    return clampDrawer(drawerHeight ?? area * DRAWER_DEFAULT_SHARE, area);
  }

  /**
   * Whether the Containers pane is on screen: devc web shows, and the user hasn't hidden it or
   * the column.
   */
  const paneShown = () => showingDevc && columnOpen && containersOpen;

  /**
   * The overlay menu while it is open: the Containers pane's menu `seq`, its items, and the point
   * it was asked for, in window coordinates.
   */
  let menuOpen: {
    seq: number;
    items: ({ label: string; danger: boolean } | null)[];
    at: { x: number; y: number };
  } | null = null;

  /**
   * Whether one of the pane's dialogs is open (Add project, the task dialog, a confirm): the
   * view then covers the window below the title bar, transparent, over every view but the
   * overlay menu. The pane draws its own content where the pane is, and the dialog with its
   * backdrop over the whole window, as devc web's page draws its own.
   */
  let paneDialog = false;

  /** The rectangles last applied: the overlay menu and the drags measure against them. */
  let laid = layout({
    width: 0,
    height: 0,
    sidebarWidth,
    column: columnOpen,
    containers: null,
    drawer: null,
    peek: false,
    footer: false,
  });

  // ---- devc web's dialogs ------------------------------------------------------------------------
  // `/sidebar` and `/main` are each only as big as their part of the window, so a dialog would be
  // squeezed into it. While one is open the app spreads that view over devc web's part of the
  // window (the column above the Containers pane and `/main` above the drawer, the rail between),
  // see-through, and its page is drawn in its own place by a stylesheet the app inserts. It never
  // covers an app view: the Containers pane, the drawer, the title bar. The page says a dialog
  // opened or closed in a console line (`client.js`), the one thing the app reads from it, and
  // all it can do with it is spread over devc web's own part of the window.

  /**
   * A devc web view with a dialog open, and the keys of the stylesheets the app inserted for it:
   * `spread` places its page in its own part of the spread view, `reveal` shows the dialog once
   * the view has spread.
   */
  const devcDialogs = new Map<
    WebContentsView,
    { spread: string | null; reveal: string | null }
  >();
  /**
   * The stylesheet hiding a devc web page's dialogs until its view has spread, so one never shows
   * squeezed into the view first, by view. Inserted only once the page has said it reports its
   * dialogs (`devc-desktop:dialog ready`), so a page that doesn't still shows them.
   */
  const devcDialogHidden = new Map<WebContentsView, string>();
  const DIALOGS = 'dialog[open],dialog[open]::backdrop,.dialog-backdrop';

  /** devc web's part of the window: above both the Containers pane and the drawer. */
  function devcRegion(l: Layout): Rect {
    const bottom = Math.min(
      l.sidebar === null ? Infinity : l.sidebar.y + l.sidebar.height,
      l.main.y + l.main.height,
    );
    return {
      x: 0,
      y: l.main.y,
      width: l.main.x + l.main.width,
      height: Math.max(0, bottom - l.main.y),
    };
  }

  /**
   * The app's dimming over the rest of the window below devc web's part of it (the Containers
   * pane, the drawer, the status strip) while a devc web dialog shows, so the dialog reads as
   * covering the window as the page's own does.
   */
  function placeDim(): void {
    const shown = [...devcDialogs.values()].some((d) => d.reveal !== null);
    dimView.setVisible(shown);
    if (!shown) return;
    const region = devcRegion(laid);
    const { width, height } = win.getContentBounds();
    const top = region.y + region.height;
    dimView.setBounds({
      x: 0,
      y: top,
      width,
      height: Math.max(0, height - top),
    });
  }
  // A click on the dimming leaves the keys with the dialog.
  dimView.webContents.on('focus', () => {
    const [view] = devcDialogs.keys();
    view?.webContents.focus();
  });

  /** Puts a devc web view at `own`, or with a dialog open across devc web's part of the window. */
  function placeDevc(view: WebContentsView, own: Rect): void {
    const open = devcDialogs.get(view);
    if (open === undefined) {
      view.setBounds(own);
      return;
    }
    const region = devcRegion(laid);
    // A see-through root whose background is not quite none, so the body's background is not
    // painted across the whole view instead, as CSS does for a root without one.
    const css =
      `html{background:linear-gradient(transparent,transparent)!important}` +
      `body{position:absolute!important;margin:0!important;` +
      `left:${own.x - region.x}px!important;top:${
        own.y - region.y
      }px!important;` +
      `width:${own.width}px!important;height:${own.height}px!important}`;
    const wc = view.webContents;
    const old = open.spread;
    // The page moves into place as the view spreads: neither waits for the other.
    void wc.insertCSS(css).then((key) => {
      if (devcDialogs.get(view) !== open) {
        void wc.removeInsertedCSS(key);
        return;
      }
      open.spread = key;
      if (old) void wc.removeInsertedCSS(old);
      if (open.reveal !== null) return;
      // Shown once the page has drawn at its new size.
      setTimeout(() => {
        if (devcDialogs.get(view) !== open || open.reveal !== null) return;
        void wc.insertCSS(`${DIALOGS}{visibility:visible!important}`).then(
          (r) => {
            if (devcDialogs.get(view) !== open) {
              void wc.removeInsertedCSS(r);
              return;
            }
            open.reveal = r;
            placeDim();
          },
        ).catch(() => {});
      }, 50);
    }).catch(() => {});
    view.setBounds(region);
  }

  function devcDialog(view: WebContentsView, open: boolean): void {
    if (open === devcDialogs.has(view)) return;
    if (open) {
      devcDialogs.set(view, { spread: null, reveal: null });
      hideMenu();
      // Raised over the other devc web view and the rail, then the dimming over what is below
      // them, all under the overlay menu.
      win.contentView.addChildView(view);
      win.contentView.addChildView(dimView);
      win.contentView.addChildView(menuView);
    } else {
      const keys = devcDialogs.get(view)!;
      devcDialogs.delete(view);
      for (const key of [keys.spread, keys.reveal]) {
        if (key) void view.webContents.removeInsertedCSS(key);
      }
    }
    relayout();
  }

  for (const view of [devcView, sidebarView]) {
    const wc = view.webContents;
    wc.on('console-message', (e) => {
      if (e.frame !== wc.mainFrame) return;
      if (e.message === 'devc-desktop:dialog open') devcDialog(view, true);
      if (e.message === 'devc-desktop:dialog closed') devcDialog(view, false);
      // The pages' corner toggle: `/sidebar`'s hides the column, `/main`'s shows it.
      if (e.message === 'devc-desktop:sidebar hide') setColumn(false);
      if (e.message === 'devc-desktop:sidebar show') setColumn(true);
      if (
        e.message === 'devc-desktop:dialog ready' && !devcDialogHidden.has(view)
      ) {
        void wc.insertCSS(`${DIALOGS}{visibility:hidden!important}`).then(
          (key) => devcDialogHidden.set(view, key),
        ).catch(() => {});
      }
    });
    // A page that navigates (a reload, devc web restarted) has no dialog open, nor the CSS. A
    // change of the hash alone (`loadMainHash`) keeps both.
    wc.on('did-start-navigation', (d) => {
      if (!d.isMainFrame || d.isSameDocument) return;
      devcDialogHidden.delete(view);
      if (devcDialogs.delete(view)) relayout();
    });
  }

  function relayout(): void {
    const { width, height } = win.getContentBounds();
    const area = areaOf(height);
    const l = layout({
      width,
      height,
      sidebarWidth,
      column: columnOpen,
      containers: !paneShown()
        ? null
        : containersFolded === null
        ? { height: containersHeight }
        : { height: containersHeight, folded: containersFolded },
      drawer: drawerOpen ? drawerWanted(area) : null,
      peek: !drawerOpen && drawerActions() > 0,
      footer: showingDevc,
    });
    laid = l;
    titleBarView.setBounds(l.bar);
    devcView.setVisible(showingDevc);
    sidebarView.setVisible(showingDevc && l.sidebar !== null);
    footerView.setVisible(l.footer !== null);
    if (l.footer !== null) footerView.setBounds(l.footer);
    railView.setVisible(showingDevc);
    statusView.setVisible(!showingDevc);
    if (showingDevc) {
      placeDevc(devcView, l.main);
      if (l.sidebar !== null) placeDevc(sidebarView, l.sidebar);
      railView.setBounds(l.rail);
    } else {
      // The status page across the window, above the drawer.
      statusView.setBounds({
        x: 0,
        y: l.main.y,
        width,
        height: l.main.height,
      });
    }
    containersView.setVisible(l.containers !== null);
    if (l.containers !== null) placeContainers(l.containers);
    hostView.setVisible(l.host !== null);
    if (l.host !== null) hostView.setBounds(l.host);
    placeDim();
  }
  win.on('resize', () => {
    hideMenu();
    relayout();
  });

  // The window's title is devc web's page title (the active tile's repo, branch and pane title)
  // while it shows, and `devcd` otherwise: a BaseWindow doesn't follow its views' titles by itself.
  // The title bar view shows the same.
  let devcTitle = 'devcd';
  function updateTitle(): void {
    const title = showingDevc ? devcTitle : 'devcd';
    win.setTitle(title);
    titleBarView.webContents.send('titlebar:title', title);
  }
  titleBarView.webContents.on('did-finish-load', updateTitle);
  devcView.webContents.on('page-title-updated', (_e, title) => {
    devcTitle = title || 'devcd';
    updateTitle();
  });

  async function loadState(): Promise<void> {
    try {
      const s = JSON.parse(await readFile(STATE_PATH, 'utf8'));
      const num = (v: unknown) =>
        typeof v === 'number' && Number.isFinite(v) ? v : null;
      drawerHeight = num(s?.drawerHeight);
      sidebarWidth = num(s?.sidebarWidth);
      if (typeof s?.columnOpen === 'boolean') columnOpen = s.columnOpen;
      containersHeight = num(s?.containersHeight);
      if (typeof s?.containersOpen === 'boolean') {
        containersOpen = s.containersOpen;
      }
    } catch { /* first launch */ }
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function saveState(): void {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void import('node:fs/promises').then((fs) =>
        fs.writeFile(
          STATE_PATH,
          JSON.stringify({
            drawerHeight,
            sidebarWidth,
            columnOpen,
            containersHeight,
            containersOpen,
          }),
        )
      ).catch(() => {});
    }, 300);
  }

  // ---- the devc view ----------------------------------------------------------------------------

  /**
   * devc web's views get no way out: no preload (set above), no dialogs, no windows (http(s)
   * goes to the system browser instead), no navigation off its own origin, no webviews, and no
   * permission but copying. Nothing in the main process listens to them, and they never reach
   * the overlay menu.
   */
  function lockDownDevc(): void {
    for (const view of [devcView, sidebarView, footerView]) {
      const wc = view.webContents;
      wc.setWindowOpenHandler(({ url }) => {
        const ext = externalUrl(url);
        if (ext !== null) void shell.openExternal(ext);
        return { action: 'deny' };
      });
      const guard = (e: { preventDefault(): void }, url: string) => {
        if (origin === null || !devcMayNavigate(url, origin)) {
          e.preventDefault();
        }
      };
      wc.on('will-navigate', guard);
      wc.on('will-redirect', guard);
      wc.on('will-frame-navigate', (e) => {
        if (e.isMainFrame) guard(e, e.url);
      });
      wc.on('will-attach-webview', (e) => e.preventDefault());
    }
    const ses = session.fromPartition('persist:devc');
    // The permission's name only: its details carry the page URL, token included.
    ses.setPermissionRequestHandler((_wc, permission, cb) =>
      cb(devcPermission(permission))
    );
    ses.setPermissionCheckHandler((_wc, permission) =>
      devcPermission(permission)
    );
    ses.setDevicePermissionHandler(() => false);
  }

  /**
   * A bundled page's view: it stays on its page, opens nothing, and is granted nothing, unless
   * `opts` says: `permission` names what it is granted, and `external` sends its `window.open`
   * of an http(s) URL to the system browser.
   */
  function lockDownBundled(
    view: WebContentsView,
    url: string,
    opts: { permission?: (p: string) => boolean; external?: boolean } = {},
  ): void {
    const wc = view.webContents;
    const allow = opts.permission ?? (() => false);
    wc.setWindowOpenHandler(({ url: to }) => {
      const ext = opts.external ? externalUrl(to) : null;
      if (ext !== null) void shell.openExternal(ext);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, to) => {
      if (to !== url) e.preventDefault();
    });
    wc.on('will-redirect', (e) => e.preventDefault());
    wc.on('will-attach-webview', (e) => e.preventDefault());
    wc.session.setPermissionRequestHandler((_wc, p, cb) => cb(allow(p)));
    wc.session.setPermissionCheckHandler((_wc, p) => allow(p));
    wc.session.setDevicePermissionHandler(() => false);
  }

  function pageUrl(name: string): string {
    return new URL(`file://${join(__dirname, 'renderer', name)}`).href;
  }

  // ---- devc web, the child ---------------------------------------------------------------------

  function setStatus(next: Status): void {
    status = next;
    console.error(`devc-desktop: ${next.message}`);
    statusView.webContents.send('status:update', status);
  }
  const fail = (message: string, stderr: string[] = []) =>
    setStatus({ phase: 'failed', message, stderr });

  function showStatus(): void {
    showingDevc = false;
    origin = null;
    devcWebToken = null;
    desktopToken = null;
    // Requests belonged to that devc web; a push or start already running carries on.
    for (const [id, a] of actions) {
      if (a.phase !== 'running' && a.phase !== 'done') actions.delete(id);
    }
    actionsChanged();
    devcTitle = 'devcd';
    hideMenu();
    void containersView.webContents.loadURL('about:blank');
    relayout();
    updateTitle();
  }

  /** devc web's page at `path` (`/main`, `/sidebar`, `/host-status`), with its token and the app's view id. */
  function devcPage(path: string, extra = ''): string | null {
    if (origin === null || devcWebToken === null) return null;
    return `${origin}${path}#token=${devcWebToken}&view=${VIEW}${extra}`;
  }

  /**
   * `/main`'s address: the app draws the host status strip (`status=external`), and the page the
   * corner toggle that shows a hidden column (`sidebar=hidden`).
   */
  function mainPage(): string | null {
    return devcPage(
      '/main',
      `&status=external&sidebar=${columnOpen ? 'shown' : 'hidden'}`,
    );
  }

  /**
   * Tells `/main` whether the column shows, by its hash alone, which reloads nothing: the page
   * follows it (`hashchange`).
   */
  function loadMainHash(): void {
    if (origin === null || !showingDevc) return;
    // The page's own address with only `sidebar` changed: it may be `/safe/main`, say.
    const now = devcView.webContents.getURL();
    if (!now.startsWith(`${origin}/`)) return;
    const url = new URL(now);
    const hash = new URLSearchParams(url.hash.slice(1));
    const want = columnOpen ? 'shown' : 'hidden';
    if (hash.get('sidebar') === want) return;
    hash.set('sidebar', want);
    url.hash = hash.toString();
    void devcView.webContents.loadURL(url.toString()).catch(() => {});
  }

  /**
   * Loads `/sidebar`: with the Containers pane showing, without its own Containers section
   * (`containers=external`), and with it hidden, with it, so the column always has one. Its
   * header has the corner toggle that hides the column (`sidebar=shown`).
   */
  function loadSidebar(): void {
    const url = devcPage(
      '/sidebar',
      `${containersOpen ? '&containers=external' : ''}&sidebar=shown`,
    );
    if (url === null) return;
    // Through a blank page: a load that only changes the hash would not reload it.
    void sidebarView.webContents.loadURL('about:blank').then(
      () => sidebarView.webContents.loadURL(url),
    ).catch(() => {});
  }

  /** Loads the Containers pane, which then asks for devc web's address and the desktop token. */
  function loadContainers(): void {
    hideMenu();
    void containersView.webContents.loadURL(`${CONTAINERS_URL}#view=${VIEW}`);
  }

  /** The global config file in use, and its text (`null`: no file). */
  async function readConfig(): Promise<{ path: string; text: string | null }> {
    const path = await globalConfigPath(CONFIG_DIR);
    try {
      return { path, text: await readFile(path, 'utf8') };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return { path, text: null };
      }
      throw e;
    }
  }

  /** Starts `devc web`, unless one is running. Every outcome lands in `status`. */
  async function start(): Promise<void> {
    if (current !== null || retiring !== null || stopping) return;
    setStatus({ phase: 'starting', message: 'Looking for devc…', stderr: [] });
    let config;
    let configPath = join(CONFIG_DIR, 'config.json');
    try {
      const read = await readConfig();
      configPath = read.path;
      config = desktopConfig(read.text);
    } catch (e) {
      return fail(`${configPath}: ${e instanceof Error ? e.message : e}`);
    }
    const found = await findDevc({
      env: (k) => process.env[k],
      onPath,
      loginEnv: () => loginEnv(),
    }, config.devc);
    if (found === null) {
      return fail(
        `devc not found. Looked in ${looked(config.devc).join(', ')}.`,
      );
    }
    runner = {
      found,
      checkout: config.devc.kind === 'devc2' && !process.env.DEVC_DESKTOP_DEVC
        ? found.cmd.join(' ')
        : null,
    };
    const args = devcArgs(
      appArgs(process.argv, app.isPackaged),
      config.webArgs,
    );
    if (current !== null || stopping) return;
    let child: DevcWeb;
    try {
      child = startDevcWeb(found.cmd, args, childEnv(process.env, found.path));
    } catch (e) {
      return fail(
        `cannot run ${found.cmd[0]}: ${e instanceof Error ? e.message : e}`,
      );
    }
    current = child;
    setStatus({
      phase: 'starting',
      message: `Running ${[...found.cmd, ...args].join(' ')}…`,
      stderr: [],
    });
    void child.ready.then((url) => {
      if (current !== child || stopping) return;
      origin = devcOrigin(url);
      devcWebToken = devcToken(url);
      showingDevc = true;
      devcTitle = 'devcd';
      relayout();
      updateTitle();
      void devcView.webContents.loadURL(mainPage()!);
      void footerView.webContents.loadURL(devcPage('/host-status')!);
      loadSidebar();
      const at = origin;
      void child.desktop.then((token) => {
        if (current !== child || stopping) return;
        desktopToken = token;
        loadContainers();
        void pollRequests(child, at, token);
      });
    });
    void child.exited.then((code) => {
      if (current !== child) return;
      current = null;
      if (stopping) return;
      fail(`devc web exited (${code})`, child.stderr());
      showStatus();
    });
  }

  /**
   * Stops `devc web` and starts it again, a new token and all, in the same window. The child is
   * dropped from `current` first, so its exit is not reported as a failure, and the next one
   * starts only once it has exited: under `--live` devc's port is fixed. The host terminal is
   * left alone.
   */
  async function restart(): Promise<void> {
    if (retiring !== null || stopping) return;
    const child = current;
    if (child !== null) {
      current = null;
      setStatus({
        phase: 'starting',
        message: 'Restarting devc web…',
        stderr: [],
      });
      showStatus();
      void devcView.webContents.loadURL('about:blank');
      void sidebarView.webContents.loadURL('about:blank');
      void footerView.webContents.loadURL('about:blank');
      retiring = child.stop();
      await retiring;
      retiring = null;
    }
    await start();
  }

  // ---- the host terminal -----------------------------------------------------------------------

  const hostPty = new HostPty({
    shell: hostShell(process.env, process.platform, accountShell()),
    cwd: app.getPath('home'),
    env: ptyEnv(childEnv(process.env, undefined)),
    onOutput: (data) => hostView.webContents.send('host-term:output', data),
    onExit: (code) => hostView.webContents.send('host-term:exit', code),
  }, nodePty.spawn);

  let hostLoaded = false;

  /** Opens or closes the drawer. Only the app menu calls this: no page can. */
  function toggleHost(): void {
    drawerOpen = !drawerOpen;
    if (drawerOpen && !hostLoaded) {
      hostLoaded = true;
      void hostView.webContents.loadURL(HOST_URL);
    }
    relayout();
    hostView.webContents.send('host-term:shown', drawerOpen);
    if (drawerOpen) hostView.webContents.focus();
    else (showingDevc ? devcView : statusView).webContents.focus();
  }

  /**
   * Shows or hides the left column, `/sidebar` and the Containers pane, leaving `/main` the
   * window. Hidden, the rail stays at the window's edge, and a click or drag on it shows it again.
   */
  function setColumn(open: boolean): void {
    if (open === columnOpen) return;
    columnOpen = open;
    const item = Menu.getApplicationMenu()?.getMenuItemById('sidebar');
    if (item) item.checked = open;
    hideMenu();
    // The keys go to /main rather than to a view that is no longer on screen.
    const focused = [sidebarView, containersView].some((v) =>
      v.webContents.isFocused()
    );
    relayout();
    saveState();
    loadMainHash();
    if (!open && focused && showingDevc) devcView.webContents.focus();
  }

  /** Shows or hides the Containers pane. Hidden, `/sidebar` draws its own Containers section. */
  function toggleContainers(): void {
    containersOpen = !containersOpen;
    hideMenu();
    // Shown into a hidden column, the column shows too.
    if (containersOpen) setColumn(true);
    relayout();
    saveState();
    loadSidebar();
    if (containersOpen && showingDevc) containersView.webContents.focus();
  }

  /** Every host-terminal message must come from the host page itself. */
  const fromHost = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
    fromView(
      e,
      {
        webContents: hostView.webContents,
        mainFrame: hostView.webContents.mainFrame,
      },
      HOST_URL,
    );

  ipcMain.on('host-term:start', (e, cols: unknown, rows: unknown) => {
    if (!fromHost(e) || debugging !== null || !drawerOpen) return;
    hostPty.start(Number(cols), Number(rows));
  });
  ipcMain.on('host-term:input', (e, data: unknown) => {
    if (!fromHost(e) || typeof data !== 'string') return;
    hostPty.write(data);
  });
  ipcMain.on('host-term:resize', (e, cols: unknown, rows: unknown) => {
    if (!fromHost(e)) return;
    hostPty.resize(Number(cols), Number(rows));
  });
  ipcMain.on('host-term:drag', (e, dy: unknown) => {
    if (
      !fromHost(e) || !drawerOpen || typeof dy !== 'number' ||
      !Number.isFinite(dy)
    ) return;
    const area = areaOf(win.getContentBounds().height);
    drawerHeight = clampDrawer(
      (drawerHeight ?? area * DRAWER_DEFAULT_SHARE) - dy,
      area,
    );
    relayout();
    saveState();
  });
  ipcMain.handle('host-term:info', (e) => {
    if (!fromHost(e)) throw new Error('refused');
    return {
      user: userInfo().username,
      host: hostname().replace(/\.local$/, ''),
      refused: debugging,
      toggle: TOGGLE,
      open: drawerOpen,
    };
  });

  // The right-click item: `cd` to the host folder behind devc web's active terminal pane. The
  // folder comes from devc web's server, never from its page directly, and is checked by
  // `cdTarget` before it is shown, and again before it is typed.

  /**
   * The checked folders: the pane's (or the reason there is none, as the item's label says it),
   * and its container's primary repo, `null` when devc web names none or it fails the checks.
   */
  async function activeCd(): Promise<
    { pane: CdTarget; primary: CdTarget | null }
  > {
    const none = (label: string) => ({
      pane: { ok: false as const, label },
      primary: null,
    });
    if (origin === null || devcWebToken === null) {
      return none("devc web isn't running");
    }
    if (!hostPty.running) return none("The host shell isn't running");
    let answer: unknown;
    try {
      // Node's fetch, not Electron's `net`: Chromium's stack may add an Origin, which the
      // server refuses on `/desktop/`.
      const res = await fetch(`${origin}/desktop/active-folder`, {
        headers: { Authorization: `Bearer ${devcWebToken}` },
        signal: AbortSignal.timeout(3000),
      });
      if (res.status !== 200) throw new Error(String(res.status));
      answer = await res.json();
    } catch {
      return none('devc web gave no folder');
    }
    const fs = { realpath, stat };
    const p = (answer as { primary?: { folder?: unknown; mount?: unknown } })
      ?.primary;
    const primary = typeof p === 'object' && p !== null
      ? await cdTarget({ ok: true, folder: p.folder, mount: p.mount }, fs)
      : null;
    return {
      pane: await cdTarget(answer, fs),
      primary: primary?.ok ? primary : null,
    };
  }

  /** Whether the shell is at its prompt; otherwise the busy program's name. */
  function busyWith(): string | null {
    const fg = hostPty.foreground;
    if (fg === null || shellIdle(fg, hostPty.shell)) return null;
    return baseName(fg);
  }

  let menuPending = false;
  ipcMain.on('host-term:context-menu', (e) => {
    if (!fromHost(e) || !drawerOpen || menuPending) return;
    menuPending = true;
    void activeCd().then(({ pane, primary }) => {
      const busy = busyWith();
      const busySuffix = busy !== null ? ` (busy: ${busy})` : '';
      const item = (
        which: 'pane' | 'primary',
        target: CdTarget,
        suffix: string,
      ): MenuItemConstructorOptions => {
        if (!target.ok) return { label: target.label, enabled: false };
        const label = menuLabel(
          target,
          app.getPath('home'),
          process.platform,
          suffix + busySuffix,
        );
        return label === null
          ? { label: "The folder's name is too long to show", enabled: false }
          : {
            label,
            enabled: busy === null,
            click: () => void cdTo(which, target.path),
          };
      };
      const items = [item('pane', pane, '')];
      // The primary repo, unless the pane's item already goes there.
      if (primary?.ok && !(pane.ok && pane.path === primary.path)) {
        items.push(item('primary', primary, ' (primary)'));
      }
      Menu.buildFromTemplate(items).popup({ window: win });
    }).finally(() => menuPending = false);
  });

  /** Checks again, and types the `cd` only if it still names the folder the item showed. */
  async function cdTo(which: 'pane' | 'primary', shown: string): Promise<void> {
    const target = (await activeCd())[which];
    if (!target?.ok || target.path !== shown || busyWith() !== null) {
      shell.beep();
      return;
    }
    // Ctrl+E, Ctrl+U: whatever was typed on the prompt goes first.
    hostPty.write(`\x05\x15cd ${shellQuote(target.path)}\r`);
    hostView.webContents.focus();
  }

  // ---- host actions ------------------------------------------------------------------------------
  // devc web's page asks (`request_push`, `request_project`); the app reads the requests from its
  // server with the desktop token, works out what would happen itself, and the user confirms it
  // in the drawer's Actions column. A request never opens the drawer or takes focus: a closed
  // drawer shows only its HOST strip, badged. Why: `.plans/devc-desktop-host-actions.md`. The
  // Containers pane's own Push…, Start, Stop and Remove take the same path (`where: 'pane'`),
  // shown and confirmed in the pane instead.

  function sendActions(): void {
    const cards = (where: Shown['where']) =>
      [...actions.values()].filter((a) => a.where === where).map((a) =>
        actionCard(a, runner?.checkout ?? null)
      );
    if (hostLoaded) {
      hostView.webContents.send('host-actions:list', cards('drawer'));
    }
    if (paneLoaded()) {
      containersView.webContents.send('containers:actions', cards('pane'));
    }
  }

  /** Redraws the column and the strip, loading the host page if a closed drawer must peek. */
  function actionsChanged(): void {
    if (drawerActions() > 0 && !hostLoaded) {
      hostLoaded = true;
      void hostView.webContents.loadURL(HOST_URL);
    }
    relayout();
    sendActions();
  }

  /** Applies `change` to `a`, if it is still shown. A content change re-arms its confirm. */
  function update(a: Shown, change: () => void): void {
    if (actions.get(a.req.id) !== a) return;
    change();
    a.changedAt = Date.now();
    actionsChanged();
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const desktopAuth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /**
   * Long-polls `child`'s `GET /desktop/requests` while it is the running devc web. Node's fetch,
   * not Electron's `net`, as for the `cd` item: no Origin.
   */
  async function pollRequests(
    child: DevcWeb,
    at: string,
    token: string,
  ): Promise<void> {
    let seq = -1;
    while (current === child && !stopping) {
      try {
        const res = await fetch(`${at}/desktop/requests?after=${seq}`, {
          headers: desktopAuth(token),
          signal: AbortSignal.timeout(35_000),
        });
        if (res.status !== 200) throw new Error(String(res.status));
        const answer = requestsAnswer(await res.json());
        if (answer === null) throw new Error('malformed');
        if (current !== child) return;
        seq = answer.seq;
        reconcile(answer.requests);
      } catch {
        await sleep(2000);
      }
    }
  }

  /** New requests get a card and their checks; ones the server dropped go, unless confirmed. */
  function reconcile(requests: ActionState['req'][]): void {
    const ids = new Set(requests.map((r) => r.id));
    for (const [id, a] of actions) {
      if (
        a.where === 'drawer' && !ids.has(id) && a.phase !== 'running' &&
        a.phase !== 'done'
      ) {
        actions.delete(id);
      }
    }
    for (const req of requests) {
      if (actions.has(req.id)) continue;
      add(req, 'drawer');
    }
    actionsChanged();
  }

  /** Shows a new request `where`, and starts its checks. */
  function add(req: ActionState['req'], where: Shown['where']): void {
    const a: Shown = {
      req,
      phase: 'checking',
      target: null,
      plan: null,
      lines: [],
      outcome: null,
      changedAt: Date.now(),
      where,
    };
    actions.set(req.id, a);
    void check(a);
  }

  /** The env `devc git` runs with: the app's, with the login shell's `PATH` when it gave one. */
  const devcEnv = (found: Found) => childEnv(process.env, found.path);

  /** Checks the request's folder, and for a push runs `devc git push-plan` there. */
  async function check(a: Shown): Promise<void> {
    const { req } = a;
    const target = await hostFolder(
      req.kind === 'push' ? req.folder : req.localFolder,
      { realpath, stat },
    );
    if (!target.ok || req.kind !== 'push') {
      update(a, () => {
        a.target = target;
        a.phase = target.ok ? 'ready' : 'refused';
      });
      return;
    }
    update(a, () => {
      a.target = target;
      a.phase = 'planning';
    });
    const r = runner;
    const out = r === null
      ? { code: 'no devc', stdout: '' }
      : await runDevcCommand(
        r.found.cmd,
        ['git', 'push-plan', target.path],
        devcEnv(r.found),
        { timeoutMs: 120_000 },
      );
    const plan = out.code === '0' ? pushPlanFrom(out.stdout) : {
      ok: false as const,
      problem: `devc git push-plan failed (${out.code})`,
    };
    update(a, () => {
      a.plan = plan;
      a.phase = plan.ok ? 'ready' : 'refused';
    });
  }

  function progress(a: Shown, line: string): void {
    a.lines.push(line);
    if (a.lines.length > ACTION_LINES) a.lines.shift();
    if (a.where === 'drawer' && hostLoaded) {
      hostView.webContents.send(
        'host-actions:progress',
        a.req.id,
        showText(line, 300),
      );
    } else if (a.where === 'pane' && paneLoaded()) {
      containersView.webContents.send(
        'containers:action-progress',
        a.req.id,
        showText(line, 300),
      );
    }
  }

  /** Runs a confirmed request: the push of the plan's exact SHA, or the project action. */
  async function confirm(id: string): Promise<void> {
    const a = actions.get(id);
    // Only where the card is on screen: the open drawer, or the pane.
    const visible = a?.where === 'pane' ? paneShown() : drawerOpen;
    if (
      a === undefined || !visible || !armed(a.changedAt, Date.now()) ||
      actionCard(a, null).confirm === null
    ) {
      shell.beep();
      return;
    }
    update(a, () => {
      a.phase = 'running';
      a.lines = [];
    });
    let outcome: { ok: boolean; text: string };
    if (a.req.kind === 'push') {
      outcome = await push(a);
    } else outcome = await projectAction(a);
    update(a, () => {
      a.phase = 'done';
      a.outcome = outcome;
    });
    if (a.where === 'drawer') void dismissOnServer(id);
  }

  async function push(a: Shown): Promise<{ ok: boolean; text: string }> {
    const r = runner;
    if (r === null || !a.target?.ok || !a.plan?.ok) {
      return { ok: false, text: "devc isn't known" };
    }
    const out = await runDevcCommand(
      r.found.cmd,
      ['git', 'push', a.target.path, '--sha', a.plan.sha],
      devcEnv(r.found),
      { timeoutMs: 600_000, onLine: (line) => progress(a, line) },
    );
    return pushOutcome(out.code, a.lines.at(-1));
  }

  /** `POST /desktop/project`, its NDJSON progress streamed into the card. */
  async function projectAction(
    a: Shown,
  ): Promise<{ ok: boolean; text: string }> {
    const at = origin;
    const token = desktopToken;
    if (at === null || token === null) {
      return { ok: false, text: "devc web isn't running" };
    }
    try {
      const res = await fetch(`${at}/desktop/project`, {
        method: 'POST',
        headers: { ...desktopAuth(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: a.req.kind,
          localFolder: a.req.localFolder,
        }),
      });
      if (res.status === 409) {
        return {
          ok: false,
          text: a.where === 'pane'
            ? "devc web runs with --live-yolo: hide this pane (Layout → Containers Pane) and use devc web's own Projects section"
            : 'devc web runs with --live-yolo: start it from its page',
        };
      }
      if (res.status !== 200 || res.body === null) {
        return { ok: false, text: `devc web refused it (${res.status})` };
      }
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk as Uint8Array, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const text = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let o: unknown;
          try {
            o = JSON.parse(text);
          } catch {
            continue;
          }
          const m = o as {
            line?: unknown;
            done?: unknown;
            ok?: unknown;
            problem?: unknown;
          };
          if (typeof m.line === 'string') progress(a, m.line);
          else if (m.done === true) {
            return m.ok === true ? { ok: true, text: 'Done' } : {
              ok: false,
              text: typeof m.problem === 'string' ? m.problem : 'it failed',
            };
          }
        }
      }
      return { ok: false, text: 'devc web stopped answering' };
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
  }

  async function dismissOnServer(id: string): Promise<void> {
    if (origin === null || desktopToken === null) return;
    try {
      await fetch(`${origin}/desktop/requests/${id}/dismiss`, {
        method: 'POST',
        headers: desktopAuth(desktopToken),
        signal: AbortSignal.timeout(3000),
      });
    } catch { /* it expires on its own */ }
  }

  /** Drops a card `where` shows, unless it is running; a drawer request also on the server. */
  function dismiss(id: string, where: Shown['where']): void {
    const a = actions.get(id);
    if (a === undefined || a.where !== where || a.phase === 'running') return;
    actions.delete(id);
    actionsChanged();
    if (where === 'drawer' && a.phase !== 'done') void dismissOnServer(id);
  }

  ipcMain.on('host-actions:confirm', (e, id: unknown) => {
    if (!fromHost(e) || typeof id !== 'string') return;
    if (actions.get(id)?.where === 'drawer') void confirm(id);
  });
  ipcMain.on('host-actions:dismiss', (e, id: unknown) => {
    if (fromHost(e) && typeof id === 'string') dismiss(id, 'drawer');
  });
  hostView.webContents.on('did-finish-load', () => {
    sendActions();
    hostView.webContents.send('host-term:shown', drawerOpen);
  });

  // ---- the Containers pane -------------------------------------------------------------------------
  // devc web's Containers section, bundled into the app (`renderer/containers.ts`), below the
  // `/sidebar` view. It is the one view the desktop token is handed to, through its preload, and
  // only while it is at its own bundled page: with it, `/ws` gives the pane the server's desktop
  // role. Its pushes and container actions come here, and show in it as cards to confirm.

  /** Whether the pane is at its bundled page (not blank while devc web is down). */
  const paneLoaded = () =>
    containersView.webContents.getURL().split('#')[0] === CONTAINERS_URL;

  const fromContainers = (
    e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
  ) =>
    fromView(
      e,
      {
        webContents: containersView.webContents,
        mainFrame: containersView.webContents.mainFrame,
      },
      CONTAINERS_URL,
    );

  ipcMain.handle('containers:token', (e) => {
    if (!fromContainers(e)) throw new Error('refused');
    return origin !== null && desktopToken !== null
      ? { origin, token: desktopToken }
      : null;
  });
  containersView.webContents.on('did-finish-load', () => {
    if (paneLoaded()) sendActions();
  });
  containersView.webContents.on('did-start-navigation', (d) => {
    if (d.isMainFrame) hideMenu();
  });

  ipcMain.on('containers:drag', (e, dy: unknown) => {
    if (
      !fromContainers(e) || !paneShown() || laid.containers === null ||
      containersFolded !== null ||
      typeof dy !== 'number' || !Number.isFinite(dy)
    ) return;
    hideMenu();
    containersHeight = dragContainers(
      containersHeight ?? laid.containers.height,
      dy,
      (laid.sidebar?.height ?? 0) + laid.containers.height,
    );
    relayout();
    saveState();
  });

  /** The pane's view while a dialog is open: the window below the title bar. */
  function spreadBounds(): Rect {
    const { width, height } = win.getContentBounds();
    const top = Math.min(TITLEBAR_HEIGHT, height);
    return { x: 0, y: top, width, height: height - top };
  }

  /** Puts the pane at `pane`, or with a dialog open across the window, telling it where it is. */
  function placeContainers(pane: Rect): void {
    if (!paneDialog) {
      containersView.setBounds(pane);
      return;
    }
    const spread = spreadBounds();
    containersView.setBounds(spread);
    containersView.webContents.send('containers:expanded', {
      x: pane.x,
      y: pane.y - spread.y,
      width: pane.width,
      height: pane.height,
    });
  }

  ipcMain.on('containers:dialog', (e, open: unknown) => {
    if (!fromContainers(e) || typeof open !== 'boolean') return;
    if (open && (!paneShown() || laid.containers === null)) return;
    if (open === paneDialog) return;
    paneDialog = open;
    hideMenu();
    if (open) {
      // Re-adding a view raises it: over the drawer and the rest, under the overlay menu.
      win.contentView.addChildView(containersView);
      win.contentView.addChildView(menuView);
    }
    relayout();
    if (!open) containersView.webContents.send('containers:expanded', null);
  });
  // A pane that navigates away (devc web stopped, the pane reloaded) has no dialog open.
  containersView.webContents.on('did-start-navigation', (d) => {
    if (!d.isMainFrame || !paneDialog) return;
    paneDialog = false;
    relayout();
  });

  ipcMain.on('containers:reset', (e) => {
    if (!fromContainers(e) || !paneShown() || containersFolded !== null) return;
    containersHeight = null;
    relayout();
    saveState();
  });
  // The section folded (the pane shrinks to `height`, its heading) or opened (its own height).
  ipcMain.on('containers:fold', (e, open: unknown, height: unknown) => {
    if (!fromContainers(e) || typeof open !== 'boolean') return;
    if (open) containersFolded = null;
    else if (
      typeof height === 'number' && Number.isFinite(height) && height > 0 &&
      height <= FOLDED_MAX
    ) containersFolded = height;
    else return;
    hideMenu();
    relayout();
  });

  let paneSeq = 0;
  /** A push, start, stop or removal the pane's own click asked for: a card in the pane. */
  function paneAsks(
    kind: unknown,
    localFolder: unknown,
    folder: unknown,
  ): void {
    const req = paneRequest(
      `pane-${++paneSeq}`,
      kind,
      localFolder,
      folder,
      Date.now(),
    );
    if (req === null) return;
    const pane = [...actions.values()].filter((a) => a.where === 'pane');
    // Asking again for one that is still shown shows that one; and only so many at once.
    const same = pane.some((a) =>
      a.phase !== 'done' && a.req.kind === req.kind &&
      a.req.localFolder === req.localFolder && a.req.folder === req.folder
    );
    if (same || pane.length >= MAX_REQUESTS) {
      if (!same) shell.beep();
      sendActions();
      return;
    }
    add(req, 'pane');
    actionsChanged();
  }

  ipcMain.on('containers:push', (e, localFolder: unknown, folder: unknown) => {
    if (fromContainers(e) && paneShown()) paneAsks('push', localFolder, folder);
  });
  ipcMain.on(
    'containers:project',
    (e, action: unknown, localFolder: unknown) => {
      if (!fromContainers(e) || !paneShown()) return;
      if (action === 'start' || action === 'stop' || action === 'down') {
        paneAsks(action, localFolder, null);
      }
    },
  );
  ipcMain.on('containers:confirm', (e, id: unknown) => {
    if (!fromContainers(e) || typeof id !== 'string') return;
    if (actions.get(id)?.where === 'pane') void confirm(id);
  });
  ipcMain.on('containers:dismiss', (e, id: unknown) => {
    if (fromContainers(e) && typeof id === 'string') dismiss(id, 'pane');
  });

  // ---- the rail --------------------------------------------------------------------------------------

  const fromRail = (e: Electron.IpcMainEvent) =>
    fromView(
      e,
      {
        webContents: railView.webContents,
        mainFrame: railView.webContents.mainFrame,
      },
      RAIL_URL,
    );
  ipcMain.on('rail:drag', (e, dx: unknown) => {
    if (
      !fromRail(e) || !showingDevc || typeof dx !== 'number' ||
      !Number.isFinite(dx)
    ) return;
    // A hidden column comes back at its width, which the drag then changes.
    setColumn(true);
    hideMenu();
    sidebarWidth = dragColumn(
      sidebarWidth ?? laid.sidebar?.width ?? null,
      dx,
      win.getContentBounds().width,
    );
    relayout();
    saveState();
  });
  // A click on the rail shows a hidden column; it never hides one.
  ipcMain.on('rail:click', (e) => {
    if (fromRail(e) && showingDevc) setColumn(true);
  });

  // ---- the overlay menu ------------------------------------------------------------------------------
  // The Containers pane's right-click menus, drawn by a trusted view over every other one, so
  // they can spread past the pane. The pane sends the items; the overlay page measures itself;
  // the app places it against the window's edges (`placeMenu`). It closes on a pick, Escape, its
  // blur and a window resize. devc web's views never reach it: their menus stay in their pages.

  function hideMenu(): void {
    if (menuOpen === null) return;
    menuOpen = null;
    menuView.setVisible(false);
  }

  const fromMenu = (e: Electron.IpcMainEvent) =>
    fromView(
      e,
      {
        webContents: menuView.webContents,
        mainFrame: menuView.webContents.mainFrame,
      },
      MENU_URL,
    );

  ipcMain.on('containers:menu', (e, seq: unknown, req: unknown) => {
    // A menu in one of its dialogs comes from the view spread over the window.
    const pane = paneDialog && laid.containers !== null
      ? spreadBounds()
      : laid.containers;
    if (
      !fromContainers(e) || !paneShown() || pane === null ||
      !Number.isSafeInteger(seq)
    ) return;
    const m = menuRequest(req, pane);
    if (m === null) return;
    hideMenu();
    menuOpen = {
      seq: seq as number,
      items: m.items,
      at: { x: pane.x + m.x, y: pane.y + m.y },
    };
    // Laid out across the window while hidden, so the page can measure itself before it shows.
    const { width, height } = win.getContentBounds();
    menuView.setBounds({ x: 0, y: 0, width, height });
    menuView.webContents.send('menu:show', m.items);
  });
  ipcMain.on('menu:size', (e, w: unknown, h: unknown) => {
    if (
      !fromMenu(e) || menuOpen === null || typeof w !== 'number' ||
      typeof h !== 'number' || !(w > 0) || !(h > 0) || !Number.isFinite(w) ||
      !Number.isFinite(h)
    ) return;
    const { width, height } = win.getContentBounds();
    menuView.setBounds(
      placeMenu(menuOpen.at, { width: w, height: h }, { width, height }),
    );
    menuView.setVisible(true);
    menuView.webContents.focus();
  });
  ipcMain.on('menu:pick', (e, index: unknown) => {
    if (!fromMenu(e) || menuOpen === null) return;
    const { seq, items } = menuOpen;
    if (
      typeof index !== 'number' || !Number.isInteger(index) ||
      items[index] == null
    ) return;
    hideMenu();
    // Focused first: an item that copies needs its document focused (the pane waits for it).
    containersView.webContents.focus();
    containersView.webContents.send('containers:menu-pick', seq, index);
  });
  ipcMain.on('menu:dismiss', (e) => {
    if (fromMenu(e)) hideMenu();
  });
  // Any other view taking the focus closes it too, should the page's own blur not have.
  for (
    const v of [
      devcView,
      sidebarView,
      footerView,
      containersView,
      railView,
      hostView,
      titleBarView,
    ]
  ) {
    v.webContents.on('focus', hideMenu);
    // On a Mac only a left press moves the focus to a view: a right-click opening a page's own
    // menu leaves it where it was, so a later click elsewhere blurs nothing and the menu stays.
    // Any press focuses the view it lands in, so the page's blur closes its menu.
    v.webContents.on('input-event', (_e, input) => {
      if (input.type === 'mouseDown' && !v.webContents.isFocused()) {
        v.webContents.focus();
      }
    });
  }

  // ---- the status view ---------------------------------------------------------------------------

  const fromStatus = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
    fromView(
      e,
      {
        webContents: statusView.webContents,
        mainFrame: statusView.webContents.mainFrame,
      },
      STATUS_URL,
    );
  ipcMain.handle('status:get', (e) => {
    if (!fromStatus(e)) throw new Error('refused');
    return status;
  });
  ipcMain.on('status:restart', (e) => {
    if (fromStatus(e)) void restart();
  });

  // ---- menus, closing ----------------------------------------------------------------------------

  /**
   * Stops `devc web` and the host shell, waiting for both, then exits. Closing the window or
   * quitting is held until they are gone.
   */
  async function shutdown(): Promise<never> {
    stopping = true;
    await Promise.all([current?.stop(), retiring, hostPty.stop()]);
    app.exit(0);
    throw new Error('unreachable');
  }

  win.on('close', (e) => {
    e.preventDefault();
    void shutdown();
  });
  app.on('before-quit', (e) => {
    e.preventDefault();
    void shutdown();
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => void shutdown());
  }

  /**
   * The app menu. On macOS the Cmd shortcuts never reach a terminal. Elsewhere Ctrl+C, Ctrl+R and
   * the like belong to the terminals, so the app's own shortcuts take Ctrl+Shift, and the Edit
   * items do too. Ctrl+` (the host terminal) is taken on both: nothing in a terminal uses it.
   */
  function menu(): MenuItemConstructorOptions[] {
    const key = (mac: string, other: string) => (IS_MAC ? mac : other);
    return [
      {
        label: 'devc web',
        submenu: [
          {
            label: 'Restart devc web',
            accelerator: key('Cmd+R', 'Ctrl+Shift+R'),
            click: () => void restart(),
          },
          {
            label: 'Host Terminal',
            accelerator: key('Cmd+J', 'Ctrl+`'),
            click: toggleHost,
          },
          // A menu item has one shortcut, so on macOS Ctrl+` is a second, hidden item; macOS
          // fires a hidden item's shortcut (`acceleratorWorksWhenHidden`).
          ...(IS_MAC
            ? [{
              label: 'Host Terminal',
              accelerator: 'Ctrl+`',
              visible: false,
              acceleratorWorksWhenHidden: true,
              click: toggleHost,
            }]
            : []),
          { type: 'separator' },
          {
            label: 'Quit devc web',
            accelerator: key('Cmd+Q', 'Ctrl+Shift+Q'),
            click: () => void shutdown(),
          },
        ],
      },
      {
        label: 'Layout',
        submenu: [
          {
            id: 'sidebar',
            label: 'Sidebar',
            type: 'checkbox',
            checked: columnOpen,
            accelerator: key('Cmd+B', 'Ctrl+Shift+B'),
            click: (item) => setColumn(item.checked),
          },
          {
            label: 'Containers Pane',
            type: 'checkbox',
            checked: containersOpen,
            accelerator: key('Cmd+Shift+E', 'Ctrl+Shift+E'),
            click: toggleContainers,
          },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo', accelerator: key('Cmd+Z', 'Ctrl+Shift+Z') },
          { role: 'redo', accelerator: key('Shift+Cmd+Z', 'Ctrl+Shift+Y') },
          { type: 'separator' },
          { role: 'cut', accelerator: key('Cmd+X', 'Ctrl+Shift+X') },
          { role: 'copy', accelerator: key('Cmd+C', 'Ctrl+Shift+C') },
          { role: 'paste', accelerator: key('Cmd+V', 'Ctrl+Shift+V') },
          { role: 'selectAll', accelerator: key('Cmd+A', 'Ctrl+Shift+A') },
        ],
      },
      {
        label: 'View',
        submenu: [
          {
            label: 'Developer Tools (devc web)',
            accelerator: key('Alt+Cmd+I', 'Ctrl+Shift+I'),
            click: () => devcView.webContents.toggleDevTools(),
          },
          {
            label: 'Developer Tools (devc web sidebar)',
            click: () => sidebarView.webContents.toggleDevTools(),
          },
          {
            label: 'Developer Tools (devc web status strip)',
            click: () => footerView.webContents.toggleDevTools(),
          },
        ],
      },
      {
        label: 'Window',
        submenu: [{ role: 'minimize' }],
      },
    ];
  }
  await loadState();
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu()));
  void statusView.webContents.loadURL(STATUS_URL);
  void titleBarView.webContents.loadURL(TITLEBAR_URL);
  void railView.webContents.loadURL(RAIL_URL);
  void menuView.webContents.loadURL(MENU_URL);
  showStatus();
  void start();
}
