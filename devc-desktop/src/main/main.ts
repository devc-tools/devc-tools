// devc-desktop: `devc web` in its own window, with a host terminal devc web cannot reach.
//
// One BaseWindow holds four WebContentsViews, never frames of each other:
//   - the devc view: devc web's page (`devc web --no-open …` runs as a child), locked down
//     because an agent can control that page: sandboxed, its own partition, no preload, no
//     dialogs, no windows, no navigation off its origin, no permission but copying;
//   - the status view (bundled page + preload) while devc web starts, or after it stopped;
//   - the host view (bundled page + preload): a drawer at the bottom running the user's shell
//     through node-pty, opened only from the app menu;
//   - the title bar view (bundled page + preload): the OS's own bar is hidden, so this one draws
//     the title and drags the window; the window's buttons sit over it. The window's title is
//     still set as before, for the taskbar and anything else that reads it.
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
  debugReason,
  devcMayNavigate,
  devcOrigin,
  devcPermission,
  devcToken,
  DRAWER_DEFAULT_SHARE,
  externalUrl,
  fromView,
  hostFolder,
  layout,
  menuLabel,
  pushOutcome,
  pushPlanFrom,
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
/** The drawer's height, remembered across launches. */
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
 * `/desktop/requests` and `/desktop/project`. Held here only: never logged, never in a URL or
 * an environment, never sent to a view.
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
  const devcView = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      disableDialogs: true,
      partition: 'persist:devc',
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
  for (const v of [statusView, devcView, hostView]) {
    v.setBackgroundColor('#0d0f14');
    win.contentView.addChildView(v);
  }
  titleBarView.setBackgroundColor(TITLEBAR_COLOR);
  win.contentView.addChildView(titleBarView);

  const STATUS_URL = pageUrl('status.html');
  const HOST_URL = pageUrl('host.html');
  const TITLEBAR_URL = pageUrl('titlebar.html');

  lockDownDevc();
  lockDownBundled(statusView, STATUS_URL);
  lockDownBundled(hostView, HOST_URL);
  lockDownBundled(titleBarView, TITLEBAR_URL);

  // ---- layout -------------------------------------------------------------------------------

  /** Shows devc web (`true`) or the status view in the top area, and the drawer when open. */
  let showingDevc = false;

  /** Each request the app shows, by id (see host actions below), with when its content last changed. */
  const actions = new Map<string, ActionState & { changedAt: number }>();

  function relayout(): void {
    const { width, height } = win.getContentBounds();
    const area = height - TITLEBAR_HEIGHT;
    const h = drawerOpen
      ? clampDrawer(drawerHeight ?? area * DRAWER_DEFAULT_SHARE, area)
      : null;
    const { bar, main, host } = layout(
      width,
      height,
      h,
      !drawerOpen && actions.size > 0,
    );
    titleBarView.setBounds(bar);
    devcView.setVisible(showingDevc);
    statusView.setVisible(!showingDevc);
    (showingDevc ? devcView : statusView).setBounds(main);
    hostView.setVisible(host !== null);
    if (host !== null) hostView.setBounds(host);
  }
  win.on('resize', relayout);

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
      if (typeof s?.drawerHeight === 'number') drawerHeight = s.drawerHeight;
    } catch { /* first launch */ }
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function saveState(): void {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void import('node:fs/promises').then((fs) =>
        fs.writeFile(STATE_PATH, JSON.stringify({ drawerHeight }))
      ).catch(() => {});
    }, 300);
  }

  // ---- the devc view ----------------------------------------------------------------------------

  /**
   * devc web's view gets no way out: no preload (set above), no dialogs, no windows (http(s)
   * goes to the system browser instead), no navigation off its own origin, no webviews, and no
   * permission but copying. Nothing in the main process listens to it.
   */
  function lockDownDevc(): void {
    const wc = devcView.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      const ext = externalUrl(url);
      if (ext !== null) void shell.openExternal(ext);
      return { action: 'deny' };
    });
    const guard = (e: { preventDefault(): void }, url: string) => {
      if (origin === null || !devcMayNavigate(url, origin)) e.preventDefault();
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('will-frame-navigate', (e) => {
      if (e.isMainFrame) guard(e, e.url);
    });
    wc.on('will-attach-webview', (e) => e.preventDefault());
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

  /** A bundled page's view: it stays on its page, opens nothing, and is granted nothing. */
  function lockDownBundled(view: WebContentsView, url: string): void {
    const wc = view.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e, to) => {
      if (to !== url) e.preventDefault();
    });
    wc.on('will-attach-webview', (e) => e.preventDefault());
    wc.session.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    wc.session.setPermissionCheckHandler(() => false);
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
    relayout();
    updateTitle();
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
      void devcView.webContents.loadURL(url);
      const at = origin;
      void child.desktop.then((token) => {
        if (current !== child || stopping) return;
        desktopToken = token;
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
    const area = win.getContentBounds().height - TITLEBAR_HEIGHT;
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
  // drawer shows only its HOST strip, badged. Why: `.plans/devc-desktop-host-actions.md`.

  function sendActions(): void {
    if (!hostLoaded) return;
    hostView.webContents.send(
      'host-actions:list',
      [...actions.values()].map((a) => actionCard(a, runner?.checkout ?? null)),
    );
  }

  /** Redraws the column and the strip, loading the host page if a closed drawer must peek. */
  function actionsChanged(): void {
    if (actions.size > 0 && !hostLoaded) {
      hostLoaded = true;
      void hostView.webContents.loadURL(HOST_URL);
    }
    relayout();
    sendActions();
  }

  /** Applies `change` to `a`, if it is still shown. A content change re-arms its confirm. */
  function update(
    a: ActionState & { changedAt: number },
    change: () => void,
  ): void {
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
      if (!ids.has(id) && a.phase !== 'running' && a.phase !== 'done') {
        actions.delete(id);
      }
    }
    for (const req of requests) {
      if (actions.has(req.id)) continue;
      const a = {
        req,
        phase: 'checking' as const,
        target: null,
        plan: null,
        lines: [],
        outcome: null,
        changedAt: Date.now(),
      };
      actions.set(req.id, a);
      void check(a);
    }
    actionsChanged();
  }

  /** The env `devc git` runs with: the app's, with the login shell's `PATH` when it gave one. */
  const devcEnv = (found: Found) => childEnv(process.env, found.path);

  /** Checks the request's folder, and for a push runs `devc git push-plan` there. */
  async function check(a: ActionState & { changedAt: number }): Promise<void> {
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

  function progress(a: ActionState, line: string): void {
    a.lines.push(line);
    if (a.lines.length > ACTION_LINES) a.lines.shift();
    if (hostLoaded) {
      hostView.webContents.send(
        'host-actions:progress',
        a.req.id,
        showText(line, 300),
      );
    }
  }

  /** Runs a confirmed request: the push of the plan's exact SHA, or the project action. */
  async function confirm(id: string): Promise<void> {
    const a = actions.get(id);
    if (
      a === undefined || !drawerOpen || !armed(a.changedAt, Date.now()) ||
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
    void dismissOnServer(id);
  }

  async function push(a: ActionState): Promise<{ ok: boolean; text: string }> {
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
    a: ActionState,
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
          text: 'devc web runs with --live-yolo: start it from its page',
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

  ipcMain.on('host-actions:confirm', (e, id: unknown) => {
    if (!fromHost(e) || typeof id !== 'string') return;
    void confirm(id);
  });
  ipcMain.on('host-actions:dismiss', (e, id: unknown) => {
    if (!fromHost(e) || typeof id !== 'string') return;
    const a = actions.get(id);
    if (a === undefined || a.phase === 'running') return;
    actions.delete(id);
    actionsChanged();
    if (a.phase !== 'done') void dismissOnServer(id);
  });
  hostView.webContents.on('did-finish-load', () => {
    sendActions();
    hostView.webContents.send('host-term:shown', drawerOpen);
  });

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
        ],
      },
      {
        label: 'Window',
        submenu: [{ role: 'minimize' }],
      },
    ];
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu()));

  await loadState();
  void statusView.webContents.loadURL(STATUS_URL);
  void titleBarView.webContents.loadURL(TITLEBAR_URL);
  showStatus();
  void start();
}
