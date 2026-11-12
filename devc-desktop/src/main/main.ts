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
//   - the host view (bundled page + preload): a drawer under `/main` showing panes of the app's
//     own Herdr session (`herdr.ts`), opened only from the app menu. No permission but copying
//     (copy-on-select), as its host tiles;
//   - a host tile's view (bundled page + the host preload) per New Host Tile: one shell over a
//     `host` tile in `/main`'s own layout, placed where `/main` says the tile is, and hidden
//     whenever devc web may draw over it;
//   - the title bar view (bundled page + preload): the OS's own bar is hidden, so this one draws
//     the title and drags the window; the window's buttons sit over it. The window's title is
//     still set as before, for the taskbar and anything else that reads it;
//   - the overlay menu (bundled page + preload), added last so it draws over every other view,
//     shown only while the Containers pane's right-click menu is open. A trusted view may draw
//     over devc web's, never the reverse: none of the others overlap.
// Why this shape, and what it was measured against: `.plans/devc-desktop-electron.md`.

import { randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  app,
  BaseWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell,
  WebContentsView,
} from 'electron';
import {
  appearanceNamed,
  type Theme,
  themeColors,
  themeNamed,
  THEMES,
  themeVars,
} from 'devc-web/lib/themes.js';
import {
  childEnv,
  desktopConfig,
  devcArgs,
  type DevcWeb,
  findDevc,
  type Found,
  globalConfigPath,
  livePage,
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
  ambiguousPress,
  appArgs,
  armed,
  baseName,
  type CdTarget,
  cdTarget,
  cellOf,
  clampDrawer,
  containersPermission,
  type CoverChange,
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
  HOST_SHORTCUTS,
  HOST_THEMES,
  type HostCommand,
  type HostFolder,
  hostFolder,
  hostMenuEntries,
  hostPermission,
  hostTerminalOptions,
  hostTheme,
  type HostThemeChoice,
  hostThemeOf,
  isShellId,
  type Layout,
  layout,
  MAX_REQUESTS,
  MAX_SHELLS,
  type MenuEntry,
  menuLabel,
  menuRequest,
  openFileRequest,
  paneRequest,
  parseSlotLine,
  placeMenu,
  placeSlot,
  pushOutcome,
  pushPlanFrom,
  recentChanges,
  type Rect,
  REQUEST_KINDS_PARAM,
  requestsAnswer,
  shellQuote,
  showText,
  SLOT_ID,
  swatchBitmap,
  swatchTone,
  terminalCommand,
  termSize,
  TITLEBAR_HEIGHT,
} from './policy.ts';
import { accountShell, hostShell } from './pty.ts';
import {
  bridgeSupported,
  busyWith as herdrBusyWith,
  closePane,
  controlPane,
  createShell,
  desktopSessionName,
  ensureServer,
  findHerdr,
  type HerdrTarget,
  herdrVersion,
  listPanes,
  type PaneControl,
  type PaneInfo,
  readSelection,
} from './herdr.ts';

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
/**
 * A request the app shows. `direct`: a terminal request (the page's or the Containers pane's) the
 * app opens without a confirm (its devc web is not live, see `livePage`); it shows nowhere unless
 * its check or open fails.
 */
type Shown = ActionState & {
  changedAt: number;
  where: 'drawer' | 'pane';
  direct?: boolean;
};

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
let runner: { found: Found; checkout: string | null; live: boolean } | null =
  null;

/** View → Theme: devc web's colors and the app's own (not the host terminals'). */
let uiTheme: Theme = themeNamed(undefined);
/**
 * View → Appearance: Electron's `nativeTheme.themeSource`, which every page sees as
 * `prefers-color-scheme` (devc web picks its mode from that) and the app's own views follow.
 */
let appearance: 'system' | 'light' | 'dark' = appearanceNamed(undefined);
/** View → Host Terminal Color: the theme host terminals are themed with (saved as `hostColor`). */
let hostColor: HostThemeChoice = hostThemeOf(undefined);
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
  lockDownBundled(hostView, HOST_URL, {
    permission: hostPermission,
    external: true,
  });
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
    [...actions.values()].filter((a) => a.where === 'drawer' && !a.direct)
      .length;

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
    items: MenuEntry[];
    at: { x: number; y: number };
  } | null = null;

  /**
   * Whether one of the pane's dialogs is open (Add project, the task dialog, a confirm): the
   * view then covers the window below the title bar, transparent, over every view but the
   * overlay menu. The pane draws its own content where the pane is, and the dialog with its
   * backdrop over the whole window, as devc web's page draws its own.
   */
  let paneDialog = false;

  // ---- host tiles: state (the code is under "host tiles" below) ---------------------------------

  /**
   * A host tile's view: one host shell over a `host` tile in `/main`'s layout, where `/main`'s
   * slot lines say. See `.plans/archived/devc-desktop-host-tiles.md`.
   */
  interface Slot {
    /** The slot id devc web's tile names; a new one on Restore Host Tiles. */
    id: string;
    /** Its pane of the app's Herdr session. */
    pane: string;
    view: WebContentsView;
    /** The tile's last line: its CSS rectangle, `null` for hidden, `undefined` until one came. */
    line: Rect | null | undefined;
    /** Where the view covers now, `null` while hidden. */
    shown: Rect | null;
    /** When it was last shown, in ms; 0 never. */
    seenAt: number;
    /** Its pane exited or was ended: the view goes once its tile does. */
    ended: boolean;
    /** Focus it when it is next shown: it is new, or was hidden while it had the focus. */
    focusOnShow: boolean;
  }
  /** By slot id. */
  const slots = new Map<string, Slot>();
  /** `/main` says a tile or row is being dragged, or a menu is open: every slot hides. */
  let slotDrag = false;
  let slotOverlay = false;
  /** The slots' recent coverage changes, for {@link ambiguousPress}. */
  let coverChanges: CoverChange[] = [];
  /** The view whose keys are dropped after an ambiguous press, until a press that is not. */
  let muted: Electron.WebContents | null = null;
  /** Panes moved to the drawer before its page could hear of them: its `info` takes them. */
  const pendingAdopt: string[] = [];
  /**
   * Host tiles' panes by slot id, saved across restarts: a slot line from `/main` for a saved id
   * (its restored layout) reattaches that pane. Only ids the app issued are ever here.
   */
  const savedSlots = new Map<string, string>();
  /** The drawer's page has asked for its `info`: it hears `host-term:adopt` from now on. */
  let hostPageReady = false;
  /** A pending {@link applySlots}, and when it last ran. */
  let slotTimer: ReturnType<typeof setTimeout> | null = null;
  let slotsAppliedAt = 0;

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
      // Raised for the dialog, devc web's view is over the host tiles' views: they go back on top.
      restackSlots();
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
      // The pages' corner toggle: `/sidebar`'s hides the column, `/main`'s shows it. Heard only
      // from a focused view: a click on the toggle focuses its view first (the `mouseDown`
      // handler below), so a page asking while the keys are elsewhere (the Containers pane, the
      // drawer) is not the user, and must not move the column or the focus out from under them.
      const toggle = wc.isFocused();
      if (e.message === 'devc-desktop:sidebar hide' && toggle) setColumn(false);
      if (e.message === 'devc-desktop:sidebar show' && toggle) setColumn(true);
      // Host tiles live in `/main` only.
      if (view === devcView) slotLine(e.message);
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
      // A new page: no host tile is placed until it says so again.
      if (view === devcView) resetSlotLines();
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
    railView.setVisible(showingDevc && l.rail.width > 0);
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
    applySlots();
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
      hostColor = hostThemeOf(s?.hostColor);
      uiTheme = themeNamed(s?.uiTheme);
      appearance = appearanceNamed(s?.appearance);
      const saved = s?.hostSlots;
      if (typeof saved === 'object' && saved !== null) {
        for (const [id, pane] of Object.entries(saved)) {
          if (SLOT_ID.test(id) && isShellId(pane)) savedSlots.set(id, pane);
        }
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
            hostColor: hostColor.value,
            uiTheme: uiTheme.name,
            appearance,
            hostSlots: Object.fromEntries(savedSlots),
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
    return `${origin}${path}#token=${devcWebToken}&view=${VIEW}&theme=${uiTheme.name}${extra}`;
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
    const args = devcArgs(
      appArgs(process.argv, app.isPackaged),
      config.webArgs,
    );
    runner = {
      found,
      checkout: config.devc.kind === 'devc2' && !process.env.DEVC_DESKTOP_DEVC
        ? found.cmd.join(' ')
        : null,
      live: livePage(args),
    };
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
        tileFactsSent = '';
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

  // Panes of the app's own Herdr session (`herdr.ts`): nothing here runs a shell itself, and
  // devc web never connects to this session (`desktopSessionName`). One view at a time controls
  // a pane (`attachments`). See `.plans/archived/host-terminal-herdr.md`.

  const hostShellPath = hostShell(
    process.env,
    process.platform,
    accountShell(),
  );
  const herdrEnv = childEnv(process.env, undefined);
  let herdr: HerdrTarget | null = null;
  /** Why the host terminal is off, as its pages show it, or null. */
  let refusal: string | null = debugging === null
    ? null
    : `The host terminal is off: ${debugging}.`;
  /** Settles once Herdr is found and its server runs, or `refusal` says why not (D2). */
  const herdrReady: Promise<void> = refusal !== null
    ? Promise.resolve()
    : (async () => {
      const path = await findHerdr(hostShellPath, herdrEnv);
      if (path === null) {
        refusal =
          "The host terminal needs Herdr: herdr was not found on your login shell's PATH";
        return;
      }
      const t: HerdrTarget = {
        herdrPath: path,
        session: desktopSessionName(app.getPath('userData')),
        env: herdrEnv,
      };
      if (!(await bridgeSupported(t))) {
        refusal = `The host terminal needs Herdr: ${await herdrVersion(
          t,
        )} has no remote-api-bridge`;
        return;
      }
      try {
        await ensureServer(t, hostShellPath, app.getPath('home'));
      } catch (e) {
        refusal = `The host terminal needs Herdr: ${
          e instanceof Error ? e.message : String(e)
        }`;
        return;
      }
      herdr = t;
      // Saved host tiles whose panes Herdr no longer has: nothing to reattach.
      const panes = await refreshPanes();
      for (const [id, pane] of [...savedSlots]) {
        if (!panes.has(pane)) forgetSlot(id);
      }
      updateRestoreItem();
    })();

  /** Which view controls each pane now, by pane id. */
  const attachments = new Map<
    string,
    { wc: Electron.WebContents; ctl: PaneControl }
  >();
  /** The session's panes as last listed, by id. */
  let paneList = new Map<string, PaneInfo>();

  async function refreshPanes(): Promise<Map<string, PaneInfo>> {
    if (herdr === null) return paneList;
    try {
      paneList = new Map((await listPanes(herdr)).map((p) => [p.pane_id, p]));
    } catch { /* keep the last list */ }
    return paneList;
  }

  // ---- host tiles' tabs ---------------------------------------------------------------------
  // What each host tile's tab shows in devc web: its shell's folder, title and agent status, read
  // from this app's own Herdr session and posted with the desktop token (`POST
  // /desktop/host-tiles`), keyed by slot id. Never the session or a pane id. Only while devc web
  // is not live (`livePage`): a page a container could have written learns nothing of a host
  // shell. See `.plans/archived/devc-web-host-tile-tabs.md`.

  /** How often the host tiles' facts are read again. */
  const TILE_FACTS_MS = 2000;
  /** The body last posted to this devc web, so only a change is sent; `''` before one. */
  let tileFactsSent = '';
  let tileFactsBusy = false;

  async function postTileFacts(): Promise<void> {
    const at = origin;
    const token = desktopToken;
    if (
      tileFactsBusy || runner === null || runner.live || at === null ||
      token === null || herdr === null
    ) return;
    tileFactsBusy = true;
    try {
      const live = [...slots.values()].filter((s) => !s.ended);
      const tiles: Record<string, unknown> = {};
      if (live.length > 0) {
        const panes = await refreshPanes();
        for (const s of live) {
          const p = panes.get(s.pane);
          if (p === undefined) continue;
          tiles[s.id] = {
            cwd: p.cwd,
            foreground_cwd: p.foreground_cwd,
            title: p.title,
            agent: p.agent,
            agent_status: p.agent_status,
          };
        }
      }
      const body = JSON.stringify({ tiles });
      if (body === tileFactsSent) return;
      const res = await fetch(`${at}/desktop/host-tiles`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 204 && desktopToken === token) tileFactsSent = body;
    } catch {
      /* the next tick tries again */
    } finally {
      tileFactsBusy = false;
    }
  }
  setInterval(() => void postTileFacts(), TILE_FACTS_MS);

  /** Lets go of a pane: it keeps running in Herdr. */
  function releasePane(id: string): void {
    const a = attachments.get(id);
    if (a === undefined) return;
    attachments.delete(id);
    a.ctl.release();
  }

  /** A new pane in `folder` (the home folder by default): its id. */
  async function newPane(folder?: string): Promise<string> {
    await herdrReady;
    if (refusal !== null || herdr === null) throw new Error(refusal ?? 'off');
    if ((await refreshPanes()).size >= MAX_SHELLS) {
      throw new Error('too many host shells');
    }
    const cwd = folder ?? app.getPath('home');
    const id = await createShell(herdr, cwd);
    paneList.set(id, {
      pane_id: id,
      cwd,
      foreground_cwd: cwd,
      title: '',
      agent: '',
      agent_status: '',
    });
    return id;
  }

  /** The session's panes no drawer tile and no host tile shows, newest first. */
  async function unshownPanes(): Promise<string[]> {
    await herdrReady;
    if (herdr === null) return [];
    const list = await refreshPanes();
    const shown = new Set([
      ...attachments.keys(),
      ...[...slots.values()].map((s) => s.pane),
    ]);
    return [...list.keys()].filter((id) => !shown.has(id)).reverse();
  }

  /** `user@host`, and the shell's title when Herdr has one: what Close terminal… names. */
  function paneLabel(id: string): string {
    const who = `${userInfo().username}@${hostname().replace(/\.local$/, '')}`;
    const title = paneList.get(id)?.title ?? '';
    return title ? `${who} ${title}` : who;
  }

  // The panes' folders and titles, for links and tab titles, while any is shown.
  setInterval(() => {
    if (attachments.size === 0 || herdr === null) return;
    void refreshPanes().then((list) => {
      const byView = new Map<
        Electron.WebContents,
        { paneId: string; cwd: string; title: string }[]
      >();
      for (const [id, a] of attachments) {
        const p = list.get(id);
        if (p === undefined) continue;
        const panes = byView.get(a.wc) ?? [];
        panes.push({ paneId: id, cwd: p.foreground_cwd, title: p.title });
        byView.set(a.wc, panes);
      }
      for (const [wc, panes] of byView) {
        if (!wc.isDestroyed()) wc.send('host-term:panes', panes);
      }
    });
  }, 2000);

  let hostLoaded = false;
  /** The drawer was last opened by the user (not a request): an empty one makes a pane. */
  let drawerByUser = false;

  /** Opens or closes the drawer. Only the app menu calls this: no page can. */
  function toggleHost(): void {
    setDrawer(!drawerOpen, true);
  }

  /**
   * Opens or closes the drawer. `focus`: an open drawer takes the focus (the user opened it); a
   * closing one always hands it back. A new host action opens it without (`false`).
   */
  function setDrawer(open: boolean, focus: boolean): void {
    drawerOpen = open;
    drawerByUser = open && focus;
    if (drawerOpen && !hostLoaded) {
      hostLoaded = true;
      void hostView.webContents.loadURL(HOST_URL);
    }
    relayout();
    hostView.webContents.send('host-term:shown', drawerOpen, drawerByUser);
    if (drawerOpen) {
      if (focus) hostView.webContents.focus();
    } else (showingDevc ? devcView : statusView).webContents.focus();
  }

  /**
   * **New File**: the key press `/main` takes for a new draft (Cmd+N, Alt+Shift+N), sent to it
   * whichever view has the focus. `/main` has no way to hear from the app but its keys.
   */
  function newFile(): void {
    if (!showingDevc) return;
    devcView.webContents.focus();
    const modifiers: ('meta' | 'alt' | 'shift')[] = IS_MAC
      ? ['meta']
      : ['alt', 'shift'];
    devcView.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: 'n',
      modifiers,
    });
    devcView.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: 'n',
      modifiers,
    });
  }

  /**
   * Shows or hides the left column, `/sidebar` and the Containers pane, leaving `/main` the
   * window, as devc web's own page hides its sidebar: the rail goes too.
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

  /**
   * Whether the sender may use shell `id`: the drawer's page any but a host tile's, a host tile's
   * view its own alone.
   */
  function mayUse(
    e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
    id: unknown,
  ): id is string {
    if (!isShellId(id)) return false;
    const slot = slotOf(e);
    if (slot !== undefined) return id === slot.pane && !slot.ended;
    return fromHost(e) && slotOfPane(id) === undefined;
  }

  ipcMain.handle('host-term:create', async (e) => {
    if (!fromHost(e)) throw new Error('refused');
    return await newPane();
  });
  ipcMain.handle('host-term:unshown', async (e) => {
    if (!fromHost(e)) throw new Error('refused');
    return await unshownPanes();
  });
  ipcMain.handle(
    'host-term:attach',
    async (e, id: unknown, cols: unknown, rows: unknown) => {
      if (!mayUse(e, id)) throw new Error('refused');
      await herdrReady;
      const t = herdr;
      if (t === null) throw new Error(refusal ?? 'off');
      const info = paneList.get(id) ?? (await refreshPanes()).get(id);
      if (info === undefined) throw new Error('pane gone');
      const wc = e.sender;
      // One view controls a pane: a takeover replaces the last one.
      releasePane(id);
      const ctl: PaneControl = controlPane(
        t,
        id,
        termSize(cols, 80),
        termSize(rows, 24),
        {
          frame: (f) => {
            if (!wc.isDestroyed()) wc.send('host-term:frame', id, f);
          },
          closed: (reason) => {
            if (attachments.get(id)?.ctl !== ctl) return;
            attachments.delete(id);
            if (!wc.isDestroyed()) wc.send('host-term:closed', id, reason);
            const slot = slotOfPane(id);
            if (slot !== undefined && slot.view.webContents === wc) {
              slotEnded(slot);
            }
          },
        },
      );
      attachments.set(id, { wc, ctl });
      return { paneId: id, cwd: info.foreground_cwd };
    },
  );
  ipcMain.on('host-term:pane-command', (e, id: unknown, cmd: unknown) => {
    if (!mayUse(e, id)) return;
    const a = attachments.get(id);
    if (a === undefined || a.wc !== e.sender) return;
    const c = terminalCommand(cmd);
    if (c !== null) a.ctl.send(c);
  });
  ipcMain.handle(
    'host-term:read-selection',
    async (e, id: unknown, anchor: unknown, cursor: unknown) => {
      const a = cellOf(anchor);
      const c = cellOf(cursor);
      if (!mayUse(e, id) || herdr === null || a === null || c === null) {
        throw new Error('refused');
      }
      return await readSelection(herdr, id, a, c);
    },
  );
  ipcMain.on('host-term:release', (e, id: unknown) => {
    if (!isShellId(id) || attachments.get(id)?.wc !== e.sender) return;
    releasePane(id);
  });
  // The drawer tab's trash button: the app asks first (the pages are granted no dialogs).
  ipcMain.on('host-term:end', (e, id: unknown) => {
    if (mayUse(e, id)) void closeTerminal(id);
  });
  ipcMain.on('host-term:open-file', (e, file: unknown) => {
    if (!fromHost(e) && slotOf(e) === undefined) return;
    const f = openFileRequest(file);
    if (f === null) return;
    setMainHash({
      'open-host-file': f.path,
      ...(f.line !== undefined ? { 'open-line': String(f.line) } : {}),
      ...(f.column !== undefined ? { 'open-column': String(f.column) } : {}),
    });
  });

  /**
   * **Close terminal…**: asks, in devc web's words, then ends the pane in Herdr; its tile goes
   * (a host tile's in devc web too). See `.plans/archived/host-terminal-herdr.md` (D6).
   */
  async function closeTerminal(id: string): Promise<void> {
    const t = herdr;
    if (t === null) return;
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      message: `Close terminal "${paneLabel(id)}"? Its process ends.`,
      buttons: ['Close terminal', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return;
    releasePane(id);
    try {
      await closePane(t, id);
    } catch { /* gone already */ }
    paneList.delete(id);
    const slot = slotOfPane(id);
    if (slot !== undefined) {
      askToClose(slot.id);
      dropSlot(slot);
    } else hostView.webContents.send('host-term:remove', id);
  }

  // The page's last tile closed: the drawer goes with it, and opening it again starts a new one.
  ipcMain.on('host-term:hide', (e) => {
    if (fromHost(e) && drawerOpen) toggleHost();
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
  ipcMain.handle('host-term:info', async (e) => {
    await herdrReady;
    const who = {
      user: userInfo().username,
      host: hostname().replace(/\.local$/, ''),
      refused: refusal,
      color: hostTerminalOptions(hostThemeNow(), uiMode()),
    };
    const slot = slotOf(e);
    if (slot !== undefined) return { ...who, pane: slot.pane };
    if (!fromHost(e)) throw new Error('refused');
    hostPageReady = true;
    return {
      ...who,
      toggle: TOGGLE,
      open: drawerOpen,
      byUser: drawerByUser,
      adopt: pendingAdopt.splice(0),
    };
  });

  // The right-click item: `cd` to the host folder behind devc web's active terminal pane. The
  // folder comes from devc web's server, never from its page directly, and is checked by
  // `cdTarget` before it is shown, and again before it is typed.

  /**
   * The checked folders: the pane's (or the reason there is none, as the item's label says it),
   * and its container's primary repo, `null` when devc web names none or it fails the checks.
   */
  async function activeCd(id: string): Promise<
    { pane: CdTarget; primary: CdTarget | null }
  > {
    const none = (label: string) => ({
      pane: { ok: false as const, label },
      primary: null,
    });
    if (origin === null || devcWebToken === null) {
      return none("devc web isn't running");
    }
    if (!attachments.has(id)) {
      return none("The host shell isn't running");
    }
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

  /** Whether the pane's shell is at its prompt (null); otherwise the busy program's name. */
  async function busyWith(id: string): Promise<string | null> {
    return herdr === null ? null : await herdrBusyWith(herdr, id);
  }

  /** A shell's `cd` items: the active pane's folder, and its container's primary one. */
  async function cdItems(id: string): Promise<MenuItemConstructorOptions[]> {
    const { pane, primary } = await activeCd(id);
    const busy = await busyWith(id);
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
          click: () => void cdTo(id, which, target.path),
        };
    };
    const items = [item('pane', pane, '')];
    // The primary repo, unless the pane's item already goes there.
    if (primary?.ok && !(pane.ok && pane.path === primary.path)) {
      items.push(item('primary', primary, ' (primary)'));
    }
    return items;
  }

  let menuPending = false;
  ipcMain.on('host-term:context-menu', (e, id: unknown) => {
    if (menuPending || !isShellId(id)) return;
    const slot = slotOf(e);
    if (slot !== undefined) {
      if (id !== slot.pane) return;
    } else if (!fromHost(e) || !drawerOpen || slotOfPane(id) !== undefined) {
      return;
    }
    menuPending = true;
    void hostMenu(slot ?? null, id).finally(() => menuPending = false);
  });

  /**
   * A host terminal's right-click menu, the drawer's or a host tile's (`hostMenuEntries`): splits,
   * the `cd` items, the move, **Close** (lets go of the pane) and **Close terminal…** (ends it).
   */
  async function hostMenu(slot: Slot | null, id: string): Promise<void> {
    const cd = slot?.ended ? [] : await cdItems(id);
    const keys = (name: HostCommand): MenuItemConstructorOptions => ({
      accelerator: HOST_SHORTCUTS[name][IS_MAC ? 'mac' : 'other'],
      registerAccelerator: false,
    });
    /** A split or a new tab: the drawer's page makes it, or a new host tile beside this one. */
    const run = (name: Exclude<HostCommand, 'close'>) => {
      if (slot !== null) {
        slotCommand(slot, name);
        return;
      }
      hostView.webContents.focus();
      hostView.webContents.send('host-term:command', name, id);
    };
    const items: MenuItemConstructorOptions[] = [];
    for (const entry of hostMenuEntries(slot === null ? 'drawer' : 'slot')) {
      switch (entry) {
        case 'split-right':
          items.push({
            label: 'Split vertically',
            ...keys('split-right'),
            click: () => run('split-right'),
          });
          break;
        case 'split-below':
          items.push({
            label: 'Split horizontally',
            ...keys('split-below'),
            click: () => run('split-below'),
          });
          break;
        case 'new-tab':
          items.push({
            label: 'New terminal in this stack',
            ...keys('new-tab'),
            click: () => run('new-tab'),
          });
          break;
        case 'separator':
          items.push({ type: 'separator' });
          break;
        case 'cd':
          items.push(...cd);
          break;
        case 'move':
          items.push(
            slot === null
              ? {
                label: 'Move to Main Area',
                enabled: showingDevc && refusal === null && attachments.has(id),
                click: () => void moveToMain(id),
              }
              : {
                label: 'Move to Bottom Panel',
                enabled: !slot.ended && refusal === null,
                click: () => moveToDrawer(slot),
              },
          );
          break;
        case 'close':
          items.push(
            slot === null
              ? {
                label: 'Close',
                ...keys('close'),
                click: () => {
                  hostView.webContents.focus();
                  hostView.webContents.send('host-term:command', 'close', id);
                },
              }
              : { label: 'Close', click: () => closeSlot(slot) },
          );
          break;
        case 'close-terminal':
          items.push({
            label: 'Close terminal…',
            enabled: !slot?.ended,
            click: () => void closeTerminal(id),
          });
          break;
      }
    }
    // No separator first, last or twice in a row (no `cd` items, say).
    const trimmed = items.filter((it, i) =>
      it.type !== 'separator' ||
      (i > 0 && i < items.length - 1 && items[i - 1].type !== 'separator')
    );
    Menu.buildFromTemplate(trimmed).popup({ window: win });
  }

  /** Checks again, and types the `cd` only if it still names the folder the item showed. */
  async function cdTo(
    id: string,
    which: 'pane' | 'primary',
    shown: string,
  ): Promise<void> {
    const target = (await activeCd(id))[which];
    if (!target?.ok || target.path !== shown || (await busyWith(id)) !== null) {
      shell.beep();
      return;
    }
    // Ctrl+E, Ctrl+U: whatever was typed on the prompt goes first.
    attachments.get(id)?.ctl.send({
      type: 'terminal.input',
      bytes: Buffer.from(`\x05\x15cd ${shellQuote(target.path)}\r`).toString(
        'base64',
      ),
    });
    (slotOfPane(id)?.view ?? hostView).webContents.focus();
  }

  // ---- host tiles --------------------------------------------------------------------------------
  // Host shells in `/main`'s own layout: the app menu's New Host Tile issues a slot id, asks
  // `/main` (its hash) for a `host` tile, and lays a view of its own over the tile's content
  // wherever `/main`'s slot lines say. devc web draws the tab and decides where the tile is, and
  // nothing else: it cannot make a slot, end its shell, read it or type into it. A slot hides
  // whenever devc web might draw over it (a dialog, a drag, a menu). A press on a point a slot
  // just started or stopped covering is ambiguous: the view pressed gets no keys until a press
  // that is not. See `.plans/archived/devc-desktop-host-tiles.md`.

  const SLOT_URL = pageUrl('slot.html');

  function slotOfPane(paneId: string): Slot | undefined {
    for (const slot of slots.values()) if (slot.pane === paneId) return slot;
    return undefined;
  }

  /** The host tile whose view's own page sent `e`, if any. */
  function slotOf(
    e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
  ): Slot | undefined {
    for (const slot of slots.values()) {
      const wc = slot.view.webContents;
      if (fromView(e, { webContents: wc, mainFrame: wc.mainFrame }, SLOT_URL)) {
        return slot;
      }
    }
    return undefined;
  }

  const sameRect = (a: Rect | null, b: Rect | null) =>
    a === b ||
    (a !== null && b !== null && a.x === b.x && a.y === b.y &&
      a.width === b.width && a.height === b.height);

  /** Shows a slot's view at `want`, or hides it, recording the change for ambiguous presses. */
  function setShown(slot: Slot, want: Rect | null): void {
    if (sameRect(slot.shown, want)) return;
    const now = Date.now();
    coverChanges = [
      ...recentChanges(coverChanges, now),
      { old: slot.shown, now: want, at: now },
    ];
    const wasHidden = slot.shown === null;
    if (want === null && slot.view.webContents.isFocused()) {
      slot.focusOnShow = true;
    }
    slot.shown = want;
    if (want === null) {
      slot.view.setVisible(false);
    } else {
      slot.view.setBounds(want);
      slot.view.setVisible(true);
      slot.seenAt = now;
      if (wasHidden && slot.focusOnShow) {
        slot.focusOnShow = false;
        slot.view.webContents.focus();
      }
    }
    updateRestoreItem();
  }

  /** Puts every slot where its line says, or hides it while devc web may draw over it. */
  function applySlots(): void {
    if (slotTimer !== null) {
      clearTimeout(slotTimer);
      slotTimer = null;
    }
    slotsAppliedAt = Date.now();
    const blocked = !showingDevc || devcDialogs.size > 0 || paneDialog ||
      slotDrag || slotOverlay;
    const zoom = devcView.webContents.getZoomFactor();
    for (const slot of slots.values()) {
      const line = slot.line;
      setShown(
        slot,
        blocked || line === undefined || line === null
          ? null
          : placeSlot(line, zoom, laid.main),
      );
    }
  }

  // Lines can come every frame: views move at most once per 16 ms, the latest place winning.
  function scheduleSlots(): void {
    if (slotTimer !== null) return;
    slotTimer = setTimeout(
      applySlots,
      Math.max(0, 16 - (Date.now() - slotsAppliedAt)),
    );
  }

  /** A `/main` console line: a host tile's place, or a drag or menu starting or ending. */
  function slotLine(message: string): void {
    if (!message.startsWith('devc-desktop:')) return;
    const what = message.slice('devc-desktop:'.length);
    if (what === 'drag start' || what === 'drag end') {
      slotDrag = what === 'drag start';
      applySlots();
      return;
    }
    if (what === 'overlay open' || what === 'overlay closed') {
      slotOverlay = what === 'overlay open';
      applySlots();
      return;
    }
    const parsed = parseSlotLine(message);
    if (parsed === null) return;
    let slot = slots.get(parsed.id);
    // A host tile `/main` restored from its saved layout: its pane, if the app saved this id.
    const pane = savedSlots.get(parsed.id);
    if (
      slot === undefined && pane !== undefined && refusal === null &&
      slotOfPane(pane) === undefined && parsed.rect !== null
    ) {
      slot = makeSlot(parsed.id, pane);
    }
    // An id the app did not issue, or retired: nothing.
    if (slot === undefined) return;
    slot.line = parsed.rect;
    if (parsed.rect === null) {
      if (slot.ended) {
        dropSlot(slot);
        return;
      }
      applySlots();
      return;
    }
    scheduleSlots();
  }

  /** `/main` is loading a new page: nothing is placed, dragged or open until it says so. */
  function resetSlotLines(): void {
    slotDrag = false;
    slotOverlay = false;
    for (const slot of slots.values()) slot.line = undefined;
    applySlots();
  }

  /** The host tiles' views over devc web's, under the dimming and the overlay menu. */
  function restackSlots(): void {
    for (const slot of slots.values()) win.contentView.addChildView(slot.view);
    win.contentView.addChildView(dimView);
    win.contentView.addChildView(menuView);
  }

  /**
   * Asks `/main` for a `host` tile for slot `id`, by its hash alone (nothing reloads): beside the
   * host tile of slot `place.at`, when given and still in the layout.
   */
  function askForTile(
    id: string,
    place?: { at: string; where: 'right' | 'below' | 'stack' },
  ): void {
    setMainHash({
      'host-slot': id,
      ...(place ? { 'host-at': place.at, 'host-where': place.where } : {}),
    });
  }

  /** Asks `/main` to close the host tile of slot `id` (its shell went to the drawer). */
  function askToClose(id: string): void {
    setMainHash({ 'host-gone': id });
  }

  /** `/main`'s hash with these host-tile parameters (and no others), nothing else changed. */
  function setMainHash(params: Record<string, string>): void {
    if (origin === null || !showingDevc) return;
    const now = devcView.webContents.getURL();
    if (!now.startsWith(`${origin}/`)) return;
    const url = new URL(now);
    const hash = new URLSearchParams(url.hash.slice(1));
    for (
      const k of [
        'host-slot',
        'host-at',
        'host-where',
        'host-gone',
        'open-host-file',
        'open-line',
        'open-column',
      ]
    ) {
      hash.delete(k);
    }
    for (const [k, v] of Object.entries(params)) hash.set(k, v);
    url.hash = hash.toString();
    void devcView.webContents.loadURL(url.toString()).catch(() => {});
  }

  /**
   * **New Host Tile** (the app menu, or a host tile's own split): a new pane (or `pane`, moved from
   * the drawer) in `/main`'s layout, beside the host tile `place.at` names when given.
   */
  async function newHostTile(
    place?: { at: string; where: 'right' | 'below' | 'stack' },
    pane?: string,
  ): Promise<void> {
    if (!showingDevc || refusal !== null) {
      shell.beep();
      return;
    }
    let id = pane;
    if (id === undefined) {
      try {
        id = await newPane();
      } catch {
        shell.beep();
        return;
      }
    }
    const slot = makeSlot(randomBytes(16).toString('hex'), id);
    askForTile(slot.id, place);
  }

  /** A host tile's view for slot `id` on pane `pane`: placed once `/main`'s slot lines say. */
  function makeSlot(id: string, pane: string): Slot {
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'persist:host',
        preload: join(__dirname, 'preload-host.js'),
      },
    });
    view.setBackgroundColor(hostTermBg());
    view.setVisible(false);
    lockDownBundled(view, SLOT_URL, {
      permission: hostPermission,
      external: true,
    });
    watchPresses(view.webContents);
    themed(view);
    const slot: Slot = {
      id,
      pane,
      view,
      line: undefined,
      shown: null,
      seenAt: 0,
      ended: false,
      focusOnShow: true,
    };
    slots.set(slot.id, slot);
    savedSlots.set(slot.id, slot.pane);
    saveState();
    restackSlots();
    void view.webContents.loadURL(SLOT_URL);
    updateRestoreItem();
    return slot;
  }

  /** Slot `id` is retired (its tile went, or its pane did): no restart brings it back. */
  function forgetSlot(id: string): void {
    if (savedSlots.delete(id)) saveState();
  }

  /** Live host tiles devc web shows nowhere: closed, or lost with a reload or a reset. */
  function lostSlots(now: number): Slot[] {
    return [...slots.values()].filter((s) =>
      !s.ended && s.shown === null && now - s.seenAt >= 2000
    );
  }

  /**
   * **Restore Host Tiles**: each lost host tile back in `/main`'s layout, under a new slot id (the
   * old one is retired), one hash change per tile; and every pane of the session no view shows,
   * as drawer tiles.
   */
  async function restoreHostTiles(): Promise<void> {
    const lost = lostSlots(Date.now());
    lost.forEach((slot, i) => {
      slots.delete(slot.id);
      forgetSlot(slot.id);
      slot.id = randomBytes(16).toString('hex');
      savedSlots.set(slot.id, slot.pane);
      slot.line = undefined;
      slots.set(slot.id, slot);
      setTimeout(() => askForTile(slot.id), i * 100);
    });
    if (lost.length > 0) saveState();
    const unshown = await unshownPanes();
    for (const id of unshown) deliverToDrawer(id);
    if (lost.length === 0 && unshown.length === 0) shell.beep();
  }

  function updateRestoreItem(): void {
    const item = Menu.getApplicationMenu()?.getMenuItemById(
      'restore-host-tiles',
    );
    if (item) {
      // Unshown panes are only known by asking Herdr: with it running, the item is on.
      item.enabled = herdr !== null ||
        [...slots.values()].some((s) => !s.ended && s.shown === null);
    }
  }

  /** A host tile's pane is over: its view stays, saying so, until its tile goes. */
  function slotEnded(slot: Slot): void {
    slot.ended = true;
    forgetSlot(slot.id);
    if (slot.line === null || slot.line === undefined) dropSlot(slot);
  }

  /** Takes a host tile's view away; its pane, if any, keeps running (it is let go). */
  function dropSlot(slot: Slot): void {
    if (attachments.get(slot.pane)?.wc === slot.view.webContents) {
      releasePane(slot.pane);
    }
    setShown(slot, null);
    slots.delete(slot.id);
    forgetSlot(slot.id);
    if (muted === slot.view.webContents) muted = null;
    win.contentView.removeChildView(slot.view);
    slot.view.webContents.close();
    updateRestoreItem();
  }

  /** A host tile's **Close**: its tab closes in devc web, and its pane is let go. */
  function closeSlot(slot: Slot): void {
    askToClose(slot.id);
    dropSlot(slot);
  }

  /**
   * A split or a new tab from a host tile (its menu, or its page's shortcut): a new host tile,
   * which `/main` places beside this one (`host-at`, `host-where`).
   */
  function slotCommand(slot: Slot, name: HostCommand): void {
    const where = name === 'split-right'
      ? 'right'
      : name === 'split-below'
      ? 'below'
      : name === 'new-tab'
      ? 'stack'
      : null;
    if (where === null) return;
    void newHostTile({ at: slot.id, where });
  }
  ipcMain.on('host-term:slot-command', (e, name: unknown) => {
    const slot = slotOf(e);
    if (
      slot !== undefined &&
      (name === 'split-right' || name === 'split-below' || name === 'new-tab')
    ) slotCommand(slot, name);
  });

  // ---- moving a pane between the drawer and `/main`'s layout --------------------------------------
  // The pane never stops: the view that has it lets go, and the view taking it attaches it, with
  // its screen as Herdr has it. Only the app moves a pane, from its own menus.

  /** **Move to Main Area** (the drawer's right-click menu): the pane to a new host tile. */
  async function moveToMain(id: string): Promise<void> {
    if (
      !showingDevc || refusal !== null || !attachments.has(id) ||
      slotOfPane(id) !== undefined
    ) {
      shell.beep();
      return;
    }
    releasePane(id);
    hostView.webContents.send('host-term:remove', id);
    await newHostTile(undefined, id);
  }

  /** **Move to Bottom Panel** (a host tile's right-click menu): the pane to the drawer. */
  function moveToDrawer(slot: Slot): void {
    if (slot.ended || refusal !== null) {
      shell.beep();
      return;
    }
    const id = slot.pane;
    askToClose(slot.id);
    dropSlot(slot);
    deliverToDrawer(id);
  }

  /** A pane's tile in the drawer, which opens if it is closed. */
  function deliverToDrawer(id: string): void {
    if (!hostPageReady) pendingAdopt.push(id);
    else hostView.webContents.send('host-term:adopt', id);
    if (!drawerOpen) toggleHost();
    else hostView.webContents.focus();
  }

  /**
   * Presses and keys, for every view: a press where a host tile just appeared or vanished mutes
   * the view it landed in (its keys are dropped) until a press anywhere that is not ambiguous.
   * Focus is left where the press put it.
   */
  function watchPresses(wc: Electron.WebContents): void {
    wc.on('input-event', (_e, input) => {
      if (input.type !== 'mouseDown') return;
      const c = screen.getCursorScreenPoint();
      const b = win.getContentBounds();
      const p = { x: c.x - b.x, y: c.y - b.y };
      setMuted(ambiguousPress(coverChanges, p, Date.now()) ? wc : null);
    });
    wc.on('before-input-event', (e, input) => {
      if (muted === wc && (input.type === 'keyDown' || input.type === 'char')) {
        e.preventDefault();
      }
    });
    wc.on('focus', () => {
      hideMenu();
      // Another view took the focus: a hidden host tile no longer gets it back when shown.
      for (const slot of slots.values()) {
        if (slot.view.webContents !== wc) slot.focusOnShow = false;
      }
    });
    // As for the other views (see their loop below): any press focuses the view it lands in.
    wc.on('input-event', (_e, input) => {
      if (input.type === 'mouseDown' && !wc.isFocused()) wc.focus();
    });
  }

  function setMuted(wc: Electron.WebContents | null): void {
    if (muted === wc) return;
    const was = muted;
    muted = wc;
    for (const slot of slots.values()) {
      const v = slot.view.webContents;
      if (v === was) v.send('host-term:guard', false);
      if (v === wc) v.send('host-term:guard', true);
    }
  }

  /** View → Host Terminal Color: the host terminals' theme, never devc web's business. */
  function setHostColor(c: HostThemeChoice): void {
    hostColor = c;
    saveState();
    rethemeHost();
  }

  // ---- host actions ------------------------------------------------------------------------------
  // devc web's page asks (`request_push`, `request_project`, `request_terminal`); the app reads
  // the requests from its server with the desktop token, works out what would happen itself, and
  // the user confirms it in the drawer's Actions column. A new request opens a closed drawer but never takes focus; a
  // drawer the user closes again shows only its HOST strip, badged, while requests wait. Why:
  // `.plans/devc-desktop-host-actions.md`. The
  // Containers pane's own Push…, Start, Stop and Remove take the same path (`where: 'pane'`),
  // shown and confirmed in the pane instead.

  function sendActions(): void {
    const cards = (where: Shown['where']) =>
      [...actions.values()].filter((a) => a.where === where && !a.direct).map((
        a,
      ) => actionCard(a, runner?.checkout ?? null));
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
        const res = await fetch(
          `${at}/desktop/requests?after=${seq}&kinds=${REQUEST_KINDS_PARAM}`,
          {
            headers: desktopAuth(token),
            signal: AbortSignal.timeout(35_000),
          },
        );
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
    let added = false;
    for (const req of requests) {
      if (actions.has(req.id)) continue;
      // A terminal the page asked for while devc web is not live opens unasked (`check`).
      if (!add(req, 'drawer').direct) added = true;
    }
    // A new request opens a closed drawer so its card shows, but never takes focus: a key meant
    // for devc web can't reach the card, whose confirm also waits 1 s after any change.
    if (added && !drawerOpen) setDrawer(true, false);
    actionsChanged();
  }

  /** Shows a new request `where`, and starts its checks. */
  function add(req: ActionState['req'], where: Shown['where']): Shown {
    const a: Shown = {
      req,
      phase: 'checking',
      target: null,
      plan: null,
      lines: [],
      outcome: null,
      changedAt: Date.now(),
      where,
      direct: req.kind === 'terminal' && runner !== null && !runner.live,
    };
    actions.set(req.id, a);
    void check(a);
    return a;
  }

  /**
   * A `direct` terminal request, checked: opened at once, its card gone and a page's request
   * dismissed on the server. A refused check or a failed open shows its card where it was asked
   * instead: the Containers pane, or the drawer, opened (never focused), as any request's.
   */
  async function openDirect(a: Shown): Promise<void> {
    if (actions.get(a.req.id) !== a) return;
    let outcome: { ok: boolean; text: string } | null = null;
    if (a.phase === 'ready') {
      update(a, () => {
        a.phase = 'running';
      });
      outcome = await openTerminal(a);
      if (outcome.ok) {
        if (actions.get(a.req.id) === a) actions.delete(a.req.id);
        actionsChanged();
        if (a.where === 'drawer') void dismissOnServer(a.req.id);
        return;
      }
    }
    if (actions.get(a.req.id) !== a) return;
    update(a, () => {
      a.direct = false;
      if (outcome !== null) {
        a.phase = 'done';
        a.outcome = outcome;
      }
    });
    if (a.where === 'pane') return;
    if (outcome !== null) void dismissOnServer(a.req.id);
    if (!drawerOpen) setDrawer(true, false);
  }

  /** The env `devc git` runs with: the app's, with the login shell's `PATH` when it gave one. */
  const devcEnv = (found: Found) => childEnv(process.env, found.path);

  /**
   * Checks the request's folder, and for a push runs `devc git push-plan` there. A terminal is
   * refused first when the host terminal is off (no Herdr).
   */
  async function check(a: Shown): Promise<void> {
    const { req } = a;
    if (req.kind === 'terminal') await herdrReady;
    const target: HostFolder = req.kind === 'terminal' && refusal !== null
      ? { ok: false, label: refusal }
      : await hostFolder(
        req.kind === 'push' || req.kind === 'terminal'
          ? req.folder
          : req.localFolder,
        { realpath, stat },
      );
    if (!target.ok || req.kind !== 'push') {
      update(a, () => {
        a.target = target;
        a.phase = target.ok ? 'ready' : 'refused';
      });
      if (a.direct) await openDirect(a);
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
    } else if (a.req.kind === 'terminal') {
      outcome = await openTerminal(a);
    } else outcome = await projectAction(a);
    update(a, () => {
      a.phase = 'done';
      a.outcome = outcome;
    });
    if (a.where === 'drawer') void dismissOnServer(id);
  }

  /**
   * A confirmed terminal: a new pane in the folder checked again (a symlink swapped in since the
   * check would move it), in a new host tile in `/main`'s layout.
   */
  async function openTerminal(
    a: Shown,
  ): Promise<{ ok: boolean; text: string }> {
    const now = await hostFolder(a.req.folder, { realpath, stat });
    if (!a.target?.ok || !now.ok || now.path !== a.target.path) {
      return { ok: false, text: 'The folder moved since it was checked' };
    }
    if (!showingDevc) return { ok: false, text: "devc web isn't showing" };
    let pane: string;
    try {
      pane = await newPane(now.path);
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
    const slot = makeSlot(randomBytes(16).toString('hex'), pane);
    askForTile(slot.id);
    return { ok: true, text: 'Opened' };
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
    hostView.webContents.send('host-term:shown', drawerOpen, drawerByUser);
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
    'containers:terminal',
    (e, localFolder: unknown, folder: unknown) => {
      if (fromContainers(e) && paneShown()) {
        paneAsks('terminal', localFolder, folder);
      }
    },
  );
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
    hideMenu();
    sidebarWidth = dragColumn(
      sidebarWidth ?? laid.sidebar?.width ?? null,
      dx,
      win.getContentBounds().width,
    );
    relayout();
    saveState();
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
      items[index] == null || items[index]!.disabled === true
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
    // On a Mac only a left press moves the focus to a view: a right-click opening a page's own
    // menu leaves it where it was, so a later click elsewhere blurs nothing and the menu stays.
    // Any press focuses the view it lands in, so the page's blur closes its menu. Each view's
    // focus closes the menu too, and presses mute or unmute views around host tiles.
    watchPresses(v.webContents);
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

  // ---- the theme -----------------------------------------------------------------------------------
  // View → Theme recolors devc web (its views' hash, `theme=`; the page applies it) and the app's
  // own views (their stylesheets read the same variables, inserted here) and window. The host
  // terminals' pages take View → Host Terminal Color's theme instead, in the same mode. See
  // `.plans/archived/devc-ui-themes.md` and `.plans/archived/host-terminal-themes.md`.

  /** The mode the app shows: View → Appearance, through the OS's for System. */
  const uiMode = () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light';

  /** The host terminals' theme: View → Host Terminal Color's, or `uiTheme` for Same as Theme. */
  function hostThemeNow(): Theme {
    return hostTheme(hostColor, uiTheme);
  }

  /** A host terminal's background in the current mode: its views' own color, before a paint. */
  function hostTermBg(): string {
    return themeColors(hostThemeNow(), uiMode()).termBg;
  }

  /** Whether `wc` is a host terminal's page (the drawer or a host tile), themed with the host theme. */
  function isHostPage(wc: Electron.WebContents): boolean {
    if (wc === hostView.webContents) return true;
    for (const slot of slots.values()) {
      if (slot.view.webContents === wc) return true;
    }
    return false;
  }

  /** A theme's variables in the current mode, over each page's own `:root`. */
  const themeCss = (theme: Theme) =>
    `html:root{${
      Object.entries(themeVars(theme, uiMode())).map(([k, v]) => `${k}:${v}`)
        .join(';')
    }}`;
  /** The stylesheet inserted into each of the app's views, by its webContents. */
  const themeKeys = new Map<Electron.WebContents, string>();

  function themeView(wc: Electron.WebContents): void {
    const css = themeCss(isHostPage(wc) ? hostThemeNow() : uiTheme);
    const old = themeKeys.get(wc);
    void wc.insertCSS(css).then((key) => {
      themeKeys.set(wc, key);
      if (old !== undefined) void wc.removeInsertedCSS(old).catch(() => {});
    }).catch(() => {});
  }

  /** One of the app's own views: themed now, and again on each page it loads. */
  function themed(view: WebContentsView): void {
    const wc = view.webContents;
    wc.on('dom-ready', () => {
      themeKeys.delete(wc);
      themeView(wc);
    });
    if (!wc.isLoading() && wc.getURL() !== '') themeView(wc);
  }

  /** `theme=` in a devc web view's hash: a hash-only load, nothing reloads. */
  function setDevcTheme(view: WebContentsView): void {
    if (origin === null) return;
    const now = view.webContents.getURL();
    if (!now.startsWith(`${origin}/`)) return;
    const url = new URL(now);
    const hash = new URLSearchParams(url.hash.slice(1));
    if (hash.get('theme') === uiTheme.name) return;
    hash.set('theme', uiTheme.name);
    url.hash = hash.toString();
    void view.webContents.loadURL(url.toString()).catch(() => {});
  }

  /** The window's and views' own colors: what shows before a page paints, and the title bar's. */
  function nativeColors(): void {
    const c = themeColors(uiTheme, uiMode());
    win.setBackgroundColor(c.bg);
    for (const v of [statusView, footerView]) v.setBackgroundColor(c.bg);
    railView.setBackgroundColor(c.border);
    titleBarView.setBackgroundColor(c.sidebarHead);
    if (!IS_MAC) {
      win.setTitleBarOverlay({
        color: c.sidebarHead,
        symbolColor: c.text,
        height: TITLEBAR_HEIGHT,
      });
    }
  }

  /**
   * The host terminals' theme or mode changed: their pages' variables, their terminals' colors
   * (`host-term:color`, replaced outright) and their views' own background.
   */
  function rethemeHost(): void {
    const options = hostTerminalOptions(hostThemeNow(), uiMode());
    const bg = hostTermBg();
    const views = [hostView, ...[...slots.values()].map((s) => s.view)];
    for (const v of views) {
      v.setBackgroundColor(bg);
      if (themeKeys.has(v.webContents)) themeView(v.webContents);
      v.webContents.send('host-term:color', options);
    }
  }

  /** The mode changed (View → Appearance, or the OS under System): the app's views follow. */
  function retheme(): void {
    nativeColors();
    for (const wc of themeKeys.keys()) if (!isHostPage(wc)) themeView(wc);
    rethemeHost();
  }

  /** View → Appearance: devc web's views follow `prefers-color-scheme` by themselves. */
  function setAppearance(value: typeof appearance): void {
    appearance = value;
    saveState();
    nativeTheme.themeSource = value;
  }

  function setUiTheme(theme: Theme): void {
    uiTheme = theme;
    saveState();
    nativeColors();
    for (const wc of themeKeys.keys()) if (!isHostPage(wc)) themeView(wc);
    rethemeHost();
    // Same as Theme's swatch is this theme's.
    setMenu();
    for (const v of [devcView, sidebarView, footerView]) setDevcTheme(v);
  }

  /** A menu item's color swatch. */
  function swatch(fill: string, opts: { edge?: string; inner?: string }) {
    return nativeImage.createFromBitmap(swatchBitmap(16, fill, opts), {
      width: 16,
      height: 16,
    });
  }

  // ---- menus, closing ----------------------------------------------------------------------------

  /**
   * Stops `devc web` and the host shell, waiting for both, then exits. Closing the window or
   * quitting is held until they are gone.
   */
  async function shutdown(): Promise<never> {
    stopping = true;
    // The panes keep running in Herdr: the next start reattaches them.
    for (const id of [...attachments.keys()]) releasePane(id);
    await Promise.all([current?.stop(), retiring]);
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
  /**
   * The app menu, built from the current state; built again when a swatch changes (View → Theme
   * changes Same as Theme's). Restore Host Tiles' enabled state is set after building.
   */
  function setMenu(): void {
    Menu.setApplicationMenu(Menu.buildFromTemplate(menu()));
    updateRestoreItem();
  }

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
          {
            label: 'New Host Tile',
            accelerator: key('Cmd+Shift+J', 'Ctrl+Shift+`'),
            click: () => void newHostTile(),
          },
          {
            id: 'restore-host-tiles',
            label: 'Restore Host Tiles',
            enabled: false,
            click: restoreHostTiles,
          },
          {
            label: 'New File',
            accelerator: key('Cmd+N', 'Alt+Shift+N'),
            click: newFile,
          },
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
          { type: 'separator' },
          {
            label: 'Appearance',
            submenu: (['system', 'light', 'dark'] as const).map((v) => ({
              label: { system: 'System', light: 'Light', dark: 'Dark' }[v],
              type: 'radio' as const,
              checked: v === appearance,
              click: () => setAppearance(v),
            })),
          },
          {
            label: 'Theme',
            submenu: THEMES.map((t) => ({
              label: t.label,
              type: 'radio' as const,
              checked: t.name === uiTheme.name,
              // Its background's hue, bright enough to tell apart in a light menu, edged in the
              // background itself.
              icon: swatch(swatchTone(t.colors.panel), {
                edge: t.colors.panel,
              }),
              click: () => setUiTheme(t),
            })),
          },
          {
            label: 'Host Terminal Color',
            // View → Theme's swatch for each choice's theme (Same as Theme: the current one's).
            submenu: HOST_THEMES.map((c) => {
              const panel = hostTheme(c, uiTheme).colors.panel;
              return {
                label: c.label,
                type: 'radio' as const,
                checked: c.value === hostColor.value,
                icon: swatch(swatchTone(panel), { edge: panel }),
                click: () => setHostColor(c),
              };
            }),
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
  nativeTheme.themeSource = appearance;
  nativeTheme.on('updated', retheme);
  setMenu();
  nativeColors();
  for (
    const v of [
      titleBarView,
      statusView,
      railView,
      menuView,
      containersView,
      hostView,
    ]
  ) themed(v);
  void statusView.webContents.loadURL(STATUS_URL);
  void titleBarView.webContents.loadURL(TITLEBAR_URL);
  void railView.webContents.loadURL(RAIL_URL);
  void menuView.webContents.loadURL(MENU_URL);
  showStatus();
  void start();
}
