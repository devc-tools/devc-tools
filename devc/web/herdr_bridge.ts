// `devc web`'s link to each container's Herdr server: `herdr remote-api-bridge` (a hidden
// subcommand that relays stdio to the session's API socket) run through `docker exec -i`.
// See `.plans/devc-web.md` § Background for the measured protocol this file follows — one
// request per connection, an `events.subscribe` connection that streams, inconsistently spelled
// event names, and no event replay.
//
// Not to be confused with `devc/bridge.ts`, which is devc-bridge (host commands granted to a
// container). Nothing here touches it.

import {
  type ContainerInfo,
  dockerExecArgv,
  loginShellArgv,
} from '@devc-tools/core/container.ts';
import { closeGracefully, type LineProc, runText, spawnLines } from './proc.ts';
import {
  type ContainerRecord,
  resolveConnection,
  resolveHerdrPath,
} from './containers.ts';

/** The browser-visible state of one container. */
export type ContainerState =
  | 'connecting'
  | 'connected'
  | 'no-session'
  | 'no-herdr'
  | 'unsupported'
  | 'error';

/**
 * What every Herdr process for one container is started with: how to reach the container (the
 * same `ContainerInfo` `devc attach` uses, from `resolveConnection`), plus which `herdr` and
 * which session.
 */
export interface HerdrTarget {
  info: ContainerInfo;
  herdrPath: string;
  session: string;
}

/** `docker exec -i …` argv for `herdr --session <S> <rest…>`. Never `-t`: a pty corrupts JSON. */
export function herdrArgv(t: HerdrTarget, rest: string[]): string[] {
  return dockerExecArgv(t.info, {
    interactive: true,
    cmd: [t.herdrPath, '--session', t.session, ...rest],
  });
}

/**
 * The login-shell script `herdr server` runs inside when devc web starts it (via
 * `loginShellArgv`, as `devc herdr`'s attach does), so the server — and every pane it spawns,
 * which inherits its environment — gets the user's profile (`~/.local/bin` on `PATH`, say) on top
 * of the `remoteEnv` every exec carries. `SHELL` is exported because Herdr gives a pane `$SHELL`,
 * else `/bin/sh` (no rc files, no prompt); a project config need not set it in `remoteEnv`, and
 * bash only sets it, from the passwd entry, without exporting it. The command rides along as
 * `$0`/`$@`.
 */
export const SERVER_SCRIPT = 'export SHELL; exec "$0" "$@"';

/** The global event types the lifecycle connection subscribes to. */
export const GLOBAL_EVENT_TYPES = [
  'workspace.created',
  'workspace.updated',
  'workspace.metadata_updated',
  'workspace.renamed',
  'workspace.moved',
  'workspace.reordered',
  'workspace.closed',
  'workspace.focused',
  'worktree.created',
  'worktree.opened',
  'worktree.removed',
  'tab.created',
  'tab.closed',
  'tab.focused',
  'tab.renamed',
  'tab.moved',
  'pane.created',
  'pane.closed',
  'pane.updated',
  'pane.focused',
  'pane.moved',
  'pane.exited',
  'pane.agent_detected',
  'layout.updated',
] as const;

/**
 * Herdr sends most event names with underscores (`pane_created`) but some with dots
 * (`pane.agent_status_changed`). A name with no `.` has its **first** `_` turned into one, so
 * `workspace_metadata_updated` becomes `workspace.metadata_updated`.
 */
export function normalizeEventName(name: string): string {
  return name.includes('.') ? name : name.replace('_', '.');
}

const STRUCTURAL_PANE_EVENTS = new Set([
  'pane.created',
  'pane.closed',
  'pane.moved',
  'pane.exited',
]);

/** Whether a (normalized) event changes the tree, and so calls for a fresh snapshot. */
export function isStructuralEvent(name: string): boolean {
  return name.startsWith('workspace.') || name.startsWith('tab.') ||
    name.startsWith('worktree.') || name.startsWith('layout.') ||
    STRUCTURAL_PANE_EVENTS.has(name);
}

/**
 * Whether a `docker exec` command (as `docker events` space-joins it) runs `herdr` in a way that
 * may have started a server: any token named `herdr` — `devc herdr` wraps it as
 * `/bin/bash -lc '…' herdr --session devc` — but never a `remote-api-bridge`, which is devc
 * web's own probing and would otherwise retrigger itself.
 */
export function isHerdrLaunch(command: string): boolean {
  const tokens = command.split(/\s+/);
  return !tokens.includes('remote-api-bridge') &&
    tokens.some((t) => t.split('/').pop() === 'herdr');
}

/** The bridge's stderr when the session has no server. */
export function isNoSessionError(stderr: string): boolean {
  return stderr.includes('failed to connect to remote Herdr API socket') ||
    stderr.includes('kind: NotFound');
}

/** A failed bridge call: `no_session` when the session has no server. */
export class BridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

async function exitError(proc: LineProc): Promise<BridgeError> {
  const stderr = (await proc.stderr).trim();
  return isNoSessionError(stderr)
    ? new BridgeError('no_session', 'no Herdr server for this session')
    : new BridgeError('bridge_exited', stderr || 'Herdr bridge exited');
}

/** `remote-api-bridge --check`: true only for exactly `herdr-api-bridge-v1` and exit 0. */
export async function bridgeSupported(t: HerdrTarget): Promise<boolean> {
  const out = await runText(
    'docker',
    herdrArgv(t, ['remote-api-bridge', '--check']),
  )
    .catch(() => null);
  return out !== null && out.code === 0 &&
    out.stdout.trim() === 'herdr-api-bridge-v1';
}

let nextId = 0;

/**
 * One request on a fresh bridge connection (Herdr resets a connection's second request).
 * Resolves with `result`; rejects with a {@link BridgeError} carrying Herdr's error code, or
 * `no_session` / `bridge_exited`.
 */
export async function bridgeRequest(
  t: HerdrTarget,
  method: string,
  params: unknown,
): Promise<unknown> {
  const proc = spawnLines('docker', herdrArgv(t, ['remote-api-bridge']));
  const id = `devc-web-${++nextId}`;
  try {
    await proc.write(JSON.stringify({ id, method, params }));
    for await (const line of proc.lines) {
      let msg: { id?: unknown; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== id) continue;
      if (msg.error !== undefined) {
        const err = msg.error as { code?: unknown; message?: unknown };
        throw new BridgeError(
          String(err.code ?? 'herdr_error'),
          String(err.message ?? 'Herdr returned an error'),
        );
      }
      return msg.result;
    }
    throw await exitError(proc);
  } finally {
    void closeGracefully(proc);
  }
}

/**
 * A new pane in its own Herdr tab — how the browser makes every pane, since it owns all layout
 * and never splits one. Herdr 0.9.5's `tab.create` result carries the tab's `root_pane`, though
 * its bundled schema doesn't list it; without one, the pane is found with `pane.list` in the
 * tab's workspace. Never focuses the tab: a Herdr TUI attached to the same session keeps its
 * focus. A session with no workspace (a server just started, with no TUI) has nowhere to put a
 * tab — `tab.create` answers `workspace_not_found` — so the pane comes from `workspace.create`.
 */
export async function createShell(
  t: HerdrTarget,
  opts: { workspace_id?: string; cwd?: string },
): Promise<{ pane_id: string; tab_id: string }> {
  const cwd = opts.cwd !== undefined ? { cwd: opts.cwd } : {};
  const created = await bridgeRequest(t, 'tab.create', {
    ...(opts.workspace_id !== undefined
      ? { workspace_id: opts.workspace_id }
      : {}),
    ...cwd,
    focus: false,
  }).catch((e) => {
    if (
      !(e instanceof BridgeError && e.code === 'workspace_not_found') ||
      opts.workspace_id !== undefined
    ) {
      throw e;
    }
    return bridgeRequest(t, 'workspace.create', { ...cwd, focus: false });
  }) as
    | {
      tab?: { tab_id?: unknown; workspace_id?: unknown };
      root_pane?: { pane_id?: unknown };
    }
    | undefined;
  const tab_id = created?.tab?.tab_id;
  const workspace_id = created?.tab?.workspace_id;
  if (typeof tab_id !== 'string' || typeof workspace_id !== 'string') {
    throw new BridgeError('herdr_error', 'tab.create returned no tab');
  }
  const root = created?.root_pane?.pane_id;
  if (typeof root === 'string') return { pane_id: root, tab_id };
  const listed = await bridgeRequest(t, 'pane.list', { workspace_id }) as
    | { panes?: unknown }
    | undefined;
  const panes = Array.isArray(listed?.panes) ? listed.panes : [];
  const pane = panes.find((p) =>
    (p as { tab_id?: unknown })?.tab_id === tab_id
  ) as { pane_id?: unknown } | undefined;
  if (typeof pane?.pane_id !== 'string') {
    throw new BridgeError('herdr_error', `no pane in new tab ${tab_id}`);
  }
  return { pane_id: pane.pane_id, tab_id };
}

/** A path compared as a folder: without its trailing `/` (but `/` stays `/`). */
function folderKey(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') || '/' : path;
}

/**
 * The shell pane (no `agent`) whose `cwd` is `dir` (a container path), or null. `cwd` is the
 * shell's own directory; `foreground_cwd` (a child's) is ignored, and agent panes never count.
 * Several matches: the lowest-numbered tab wins (workspace number, then tab number, from the
 * snapshot's `workspaces` / `tabs`), else the first in snapshot order.
 */
export function paneAtFolder(
  snapshot: Record<string, unknown> | null,
  dir: string,
): { pane_id: string; tab_id: string } | null {
  if (snapshot === null) return null;
  const list = (v: unknown): Record<string, unknown>[] =>
    (Array.isArray(v)
      ? v
      : typeof v === 'object' && v !== null
      ? Object.values(v)
      : []).filter((x) => typeof x === 'object' && x !== null);
  const num = (v: unknown) => typeof v === 'number' ? v : Infinity;
  const wsNumber = new Map(
    list(snapshot.workspaces).map((w) => [w.workspace_id, num(w.number)]),
  );
  const tabOrder = new Map(
    list(snapshot.tabs).map((t) => [
      t.tab_id,
      [wsNumber.get(t.workspace_id) ?? Infinity, num(t.number)],
    ]),
  );
  const want = folderKey(dir);
  const matches = list(snapshot.panes).filter((p) =>
    (p.agent === undefined || p.agent === null || p.agent === '') &&
    typeof p.cwd === 'string' && folderKey(p.cwd) === want &&
    typeof p.pane_id === 'string' && typeof p.tab_id === 'string'
  );
  const order = (p: Record<string, unknown>) =>
    tabOrder.get(p.tab_id) ?? [Infinity, Infinity];
  matches.sort((a, b) => {
    const [aw, at] = order(a);
    const [bw, bt] = order(b);
    return aw !== bw ? (aw < bw ? -1 : 1) : at !== bt ? (at < bt ? -1 : 1) : 0;
  });
  const found = matches[0];
  return found
    ? { pane_id: found.pane_id as string, tab_id: found.tab_id as string }
    : null;
}

/** An open `events.subscribe` connection. */
export interface Subscription {
  /** Resolves when the bridge exits, with why. */
  ended: Promise<BridgeError>;
  close(): Promise<void>;
}

/** An event as delivered to {@link subscribe}'s callback: normalized name and Herdr's `data`. */
export interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}

/** The pseudo-event {@link subscribe} delivers for Herdr's `events_lost` overflow error. */
export const EVENTS_LOST = 'events_lost';

/**
 * Opens an `events.subscribe` connection and resolves once Herdr has answered
 * `subscription_started`. Rejects with a {@link BridgeError} when the bridge exits or errors
 * first. Events are delivered with normalized names; an `events_lost` error is delivered as the
 * event {@link EVENTS_LOST}.
 */
export async function subscribe(
  t: HerdrTarget,
  subscriptions: Record<string, string>[],
  onEvent: (ev: HerdrEvent) => void,
): Promise<Subscription> {
  const proc = spawnLines('docker', herdrArgv(t, ['remote-api-bridge']));
  const id = `devc-web-sub-${++nextId}`;
  await proc.write(
    JSON.stringify({
      id,
      method: 'events.subscribe',
      params: { subscriptions },
    }),
  );
  const close = () => closeGracefully(proc);

  let started!: () => void;
  let failed!: (e: BridgeError) => void;
  const startedP = new Promise<void>((res, rej) => {
    started = res;
    failed = rej;
  });
  let isStarted = false;

  const ended = (async (): Promise<BridgeError> => {
    let lastError: BridgeError | null = null;
    for await (const line of proc.lines) {
      let msg: {
        id?: unknown;
        result?: { type?: unknown };
        error?: { code?: unknown; message?: unknown };
        event?: unknown;
        data?: unknown;
      };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.error !== undefined) {
        const code = String(msg.error.code ?? 'herdr_error');
        if (code === EVENTS_LOST && isStarted) {
          onEvent({ event: EVENTS_LOST, data: {} });
          continue;
        }
        lastError = new BridgeError(
          code,
          String(msg.error.message ?? 'Herdr returned an error'),
        );
        if (!isStarted) {
          failed(lastError);
          void close();
        }
        continue;
      }
      if (!isStarted) {
        if (msg.id === id && msg.result?.type === 'subscription_started') {
          isStarted = true;
          started();
        }
        continue;
      }
      if (typeof msg.event === 'string') {
        const data = typeof msg.data === 'object' && msg.data !== null
          ? msg.data as Record<string, unknown>
          : {};
        onEvent({ event: normalizeEventName(msg.event), data });
      }
    }
    const err = lastError ?? await exitError(proc);
    if (!isStarted) failed(err);
    return err;
  })();

  await startedP;
  return { ended, close };
}

// ---------------------------------------------------------------------------------------------
// Per-container lifecycle
// ---------------------------------------------------------------------------------------------

/** What a {@link ContainerSession} tells the server. */
export interface SessionHooks {
  onState(): void;
  onSnapshot(snapshot: Record<string, unknown>): void;
  onPaneUpdated(pane: Record<string, unknown>): void;
  onAgentStatus(
    paneId: string,
    agent: unknown,
    agentStatus: unknown,
  ): void;
  /** The Herdr connection is gone: drop every pane controller for this container. */
  onTeardown(reason: string): void;
}

const SNAPSHOT_COALESCE_MS = 50;
const START_SESSION_WAIT_MS = 300;
/** With {@link START_SESSION_WAIT_MS}, about 15 s: Herdr's first start can be slow. */
const START_SESSION_TRIES = 50;
/** A lifecycle connection that dies sooner than this after (re)starting is not restarted. */
const MIN_RESTART_INTERVAL_MS = 5000;

/** The `pane_id` of every pane in a snapshot. `panes` may be an array or a map. */
export function snapshotPaneIds(snapshot: Record<string, unknown>): string[] {
  return snapshotPanes(snapshot)
    .map((p) => p.pane_id)
    .filter((id): id is string => typeof id === 'string');
}

/** A snapshot's panes (a list or an object of them), each an object; none for `null`. */
export function snapshotPanes(
  snapshot: Record<string, unknown> | null,
): { pane_id?: unknown; tab_id?: unknown }[] {
  const panes = snapshot?.panes;
  const list = Array.isArray(panes)
    ? panes
    : typeof panes === 'object' && panes !== null
    ? Object.values(panes)
    : [];
  return list.filter((p) => typeof p === 'object' && p !== null);
}

/** What a {@link ContainerSession} runs commands with; tests replace it. */
export interface SessionDeps {
  runText: typeof runText;
  startTries: number;
  startWaitMs: number;
  /** Whether the session has a server: see {@link serverAnswers}. */
  serverUp: (t: HerdrTarget) => Promise<boolean>;
  /** How to reach the container: see {@link resolveConnection}. */
  resolve: (record: ContainerRecord) => Promise<ContainerInfo>;
  /** The container's `herdr`, `''` for none: see {@link resolveHerdrPath}. */
  herdrPath: (info: ContainerInfo) => Promise<string>;
}

/**
 * Whether `t`'s session has a server, by one bridge request. Only `no_session` counts as no:
 * any other failure is for the lifecycle to report.
 */
export async function serverAnswers(t: HerdrTarget): Promise<boolean> {
  try {
    await bridgeRequest(t, 'workspace.list', {});
    return true;
  } catch (e) {
    return !(e instanceof BridgeError && e.code === 'no_session');
  }
}

/** The last 10 lines of the session's `herdr-server.log` in the container, or '' when unreadable. */
export async function serverLogTail(
  t: HerdrTarget,
  run: typeof runText = runText,
): Promise<string> {
  const out = await run(
    'docker',
    dockerExecArgv(t.info, {
      cmd: [
        'sh',
        '-c',
        'tail -n 10 "$HOME/.config/herdr/sessions/$1/herdr-server.log"',
        '_',
        t.session,
      ],
    }),
  ).catch(() => null);
  return out !== null && out.code === 0 ? out.stdout.trimEnd() : '';
}

/**
 * Whether `command` is on the PATH of a login shell for the container's remote user: the PATH
 * `devc claude` gets, and the one a new Herdr tab's shell has.
 */
export async function commandInstalled(
  t: HerdrTarget,
  command: string,
  run: typeof runText = runText,
): Promise<boolean> {
  const out = await run(
    'docker',
    dockerExecArgv(t.info, {
      cmd: loginShellArgv('command -v "$1" >/dev/null', '_', command),
    }),
  ).catch(() => null);
  return out !== null && out.code === 0;
}

/**
 * One container's Herdr connection, through the states in the plan's lifecycle: resolve the
 * user and `herdr` path, check the bridge, subscribe (lifecycle connection), snapshot, then a
 * second subscription for per-pane agent status, swapped (new first, then old closed) whenever
 * the pane set changes.
 *
 * Every async step checks `#gen` afterwards: `retry`, `startSession` and `dispose` bump it, so a
 * superseded run's late results are dropped instead of clobbering the new one.
 */
export class ContainerSession {
  state: ContainerState = 'connecting';
  error: string | undefined;
  snapshot: Record<string, unknown> | null = null;
  target: HerdrTarget | null = null;

  #gen = 0;
  #lifecycle: Subscription | null = null;
  #status: Subscription | null = null;
  #statusPaneIds = '';
  #snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  #snapshotRunning = false;
  #snapshotDirty = false;
  #lastStart = 0;
  #awaiting = false;
  readonly #deps: SessionDeps;

  constructor(
    readonly record: ContainerRecord,
    readonly session: string,
    private hooks: SessionHooks,
    deps: Partial<SessionDeps> = {},
  ) {
    this.#deps = {
      runText,
      startTries: START_SESSION_TRIES,
      startWaitMs: START_SESSION_WAIT_MS,
      serverUp: serverAnswers,
      resolve: resolveConnection,
      herdrPath: resolveHerdrPath,
      ...deps,
    };
  }

  #setState(state: ContainerState, error?: string): void {
    this.state = state;
    this.error = error;
    if (state !== 'connected') this.snapshot = null;
    this.hooks.onState();
  }

  /**
   * Runs the lifecycle from the top. Safe to call again: it tears the old run down. Resolves the
   * connection and `herdr` first when there is no target yet.
   */
  async run(): Promise<void> {
    const gen = await this.#reset('retry');
    try {
      if (this.target === null && !await this.#resolve(gen)) return;
      await this.#connect(gen);
    } catch (e) {
      if (gen !== this.#gen) return;
      this.#setState('error', e instanceof Error ? e.message : String(e));
    }
  }

  /** The page's Retry: resolves the connection again (a config edit since), then {@link run}. */
  async retry(): Promise<void> {
    this.target = null;
    await this.run();
  }

  /**
   * How to reach the container and its `herdr`, into `target`. `false` when this run should stop
   * here: superseded, no `herdr` (state `no-herdr`), or a thrown resolution (left to the caller's
   * catch, which reports it as `error`).
   */
  async #resolve(gen: number): Promise<boolean> {
    const info = await this.#deps.resolve(this.record);
    const herdrPath = await this.#deps.herdrPath(info);
    if (gen !== this.#gen) return false;
    if (herdrPath === '') {
      this.target = null;
      this.#setState('no-herdr', 'herdr is not installed in this container');
      return false;
    }
    this.target = { info, herdrPath, session: this.session };
    return true;
  }

  /**
   * `herdr --session <S> server`, detached and inside {@link SERVER_SCRIPT}'s login shell, then
   * the lifecycle
   * from the bridge check on. Throws
   * a `no_session` {@link BridgeError} carrying the server log's tail when, after the retries,
   * there is still no server.
   */
  async startSession(): Promise<void> {
    if (this.target === null) {
      throw new Error('herdr has not been located in this container');
    }
    // Resolved again, so a server started now gets the config's current `remoteEnv`.
    const info = await this.#deps.resolve(this.record);
    const t: HerdrTarget = { ...this.target, info };
    this.target = t;
    const out = await this.#deps.runText(
      'docker',
      dockerExecArgv(t.info, {
        detach: true,
        cmd: loginShellArgv(
          SERVER_SCRIPT,
          t.herdrPath,
          '--session',
          t.session,
          'server',
        ),
      }),
    );
    if (out.code !== 0) {
      throw new Error(out.stderr.trim() || 'starting the Herdr server failed');
    }
    await this.#awaitServer();
    if (this.state === 'no-session') {
      const { startTries, startWaitMs } = this.#deps;
      const seconds = Math.round(startTries * startWaitMs / 1000);
      const logTail = await serverLogTail(t, this.#deps.runText);
      throw new BridgeError(
        'no_session',
        `Herdr didn't come up in ${seconds}s.\n${logTail}`,
      );
    }
  }

  /**
   * `herdr` was just exec'd in the container (see {@link isHerdrLaunch}) — by `devc herdr`, say.
   * A container sitting in `no-session` reconnects once that has brought a server up.
   */
  async herdrLaunched(): Promise<void> {
    if (this.state !== 'no-session' || this.#awaiting) return;
    await this.#awaitServer();
  }

  /**
   * The server needs a moment to create its socket: poll for it while it still reads as no
   * session, and run the lifecycle once it answers. Bounded, and only right after a start —
   * `no-session` itself is never polled. The poll is a bare probe, not the lifecycle, so the
   * state stays `no-session` throughout instead of flickering through `connecting` on every try:
   * an exec that merely mentions `herdr` (see {@link isHerdrLaunch}) starts one too. Stops when
   * the session is retried or disposed meanwhile.
   */
  async #awaitServer(): Promise<void> {
    this.#awaiting = true;
    let gen = this.#gen;
    try {
      for (let i = 0; i < this.#deps.startTries; i++) {
        if (this.target === null || gen !== this.#gen) return;
        if (await this.#deps.serverUp(this.target)) {
          if (gen !== this.#gen) return;
          await this.run();
          if (this.state !== 'no-session') return;
          gen = this.#gen;
        }
        await new Promise((r) => setTimeout(r, this.#deps.startWaitMs));
      }
    } finally {
      this.#awaiting = false;
    }
  }

  /** Stops everything for good (the container is gone, or the server is shutting down). */
  async dispose(): Promise<void> {
    await this.#reset('container stopped');
  }

  /** Bumps the generation and closes both connections. Returns the new generation. */
  async #reset(reason: string): Promise<number> {
    const gen = ++this.#gen;
    clearTimeout(this.#snapshotTimer);
    this.#snapshotTimer = undefined;
    this.#snapshotDirty = false;
    const lifecycle = this.#lifecycle;
    const status = this.#status;
    this.#lifecycle = null;
    this.#status = null;
    this.#statusPaneIds = '';
    if (lifecycle !== null || status !== null) this.hooks.onTeardown(reason);
    await Promise.all([lifecycle?.close(), status?.close()]);
    return gen;
  }

  async #connect(gen: number): Promise<void> {
    const t = this.target!;
    this.#setState('connecting');
    if (!await bridgeSupported(t)) {
      if (gen !== this.#gen) return;
      this.#setState(
        'unsupported',
        'this herdr has no remote-api-bridge (Herdr 0.9.5 or later is needed)',
      );
      return;
    }
    if (gen !== this.#gen) return;

    let lifecycle: Subscription;
    try {
      lifecycle = await subscribe(
        t,
        GLOBAL_EVENT_TYPES.map((type) => ({ type })),
        (ev) => this.#onLifecycleEvent(gen, ev),
      );
    } catch (e) {
      if (gen !== this.#gen) return;
      if (e instanceof BridgeError && e.code === 'no_session') {
        this.#setState('no-session');
      } else {
        this.#setState('error', e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (gen !== this.#gen) {
      void lifecycle.close();
      return;
    }
    this.#lifecycle = lifecycle;
    this.#lastStart = Date.now();
    lifecycle.ended.then((why) => this.#onLifecycleEnded(gen, why));

    await this.#takeSnapshot(gen);
  }

  #onLifecycleEvent(gen: number, ev: HerdrEvent): void {
    if (gen !== this.#gen) return;
    if (ev.event === EVENTS_LOST || isStructuralEvent(ev.event)) {
      this.#scheduleSnapshot(gen);
    } else if (ev.event === 'pane.updated') {
      const pane = ev.data.pane;
      if (typeof pane === 'object' && pane !== null) {
        this.#patchPane(pane as Record<string, unknown>);
        this.hooks.onPaneUpdated(pane as Record<string, unknown>);
      }
    }
  }

  #onStatusEvent(gen: number, ev: HerdrEvent): void {
    if (gen !== this.#gen) return;
    if (ev.event === EVENTS_LOST) {
      this.#scheduleSnapshot(gen);
      return;
    }
    if (ev.event !== 'pane.agent_status_changed') return;
    const paneId = ev.data.pane_id;
    if (typeof paneId !== 'string') return;
    this.#patchPane({
      pane_id: paneId,
      agent: ev.data.agent,
      agent_status: ev.data.agent_status,
    }, true);
    this.hooks.onAgentStatus(paneId, ev.data.agent, ev.data.agent_status);
  }

  /**
   * A pane Herdr changed without telling the event stream: `pane.rename` answers with the
   * renamed pane but sends no `pane.updated`. Patched in and broadcast as that event would be,
   * and a snapshot follows, so one already on its way with the old name can't leave it stale.
   */
  paneChanged(pane: Record<string, unknown>): void {
    if (this.#patchPane(pane)) this.hooks.onPaneUpdated(pane);
    this.#scheduleSnapshot(this.#gen);
  }

  /**
   * Keeps the cached snapshot current, so a browser that connects later sees the latest. False
   * when the snapshot has no such pane (yet).
   */
  #patchPane(pane: Record<string, unknown>, merge = false): boolean {
    const panes = this.snapshot?.panes;
    if (!Array.isArray(panes)) return false;
    const i = panes.findIndex((p) => p?.pane_id === pane.pane_id);
    if (i === -1) return false;
    panes[i] = merge ? { ...panes[i], ...pane } : pane;
    return true;
  }

  #scheduleSnapshot(gen: number): void {
    if (this.#snapshotTimer !== undefined) return;
    this.#snapshotTimer = setTimeout(() => {
      this.#snapshotTimer = undefined;
      void this.#takeSnapshot(gen);
    }, SNAPSHOT_COALESCE_MS);
  }

  async #takeSnapshot(gen: number): Promise<void> {
    if (this.#snapshotRunning) {
      this.#snapshotDirty = true;
      return;
    }
    this.#snapshotRunning = true;
    try {
      const result = await bridgeRequest(this.target!, 'session.snapshot', {})
        .catch((e) => e as Error);
      if (gen !== this.#gen) return;
      if (result instanceof Error) {
        // A failed snapshot while the lifecycle connection lives is transient; the next event
        // retries. Before the first one, it is the connection's failure.
        if (this.snapshot === null) this.#setState('error', result.message);
        return;
      }
      const snap = (result as { snapshot?: unknown })?.snapshot;
      if (typeof snap !== 'object' || snap === null) {
        if (this.snapshot === null) {
          this.#setState('error', 'session.snapshot returned no snapshot');
        }
        return;
      }
      const snapshot = snap as Record<string, unknown>;
      await this.#swapStatusConnection(gen, snapshotPaneIds(snapshot));
      if (gen !== this.#gen) return;
      this.snapshot = snapshot;
      if (this.state !== 'connected') {
        this.state = 'connected';
        this.error = undefined;
        this.hooks.onState();
      }
      this.hooks.onSnapshot(snapshot);
    } finally {
      this.#snapshotRunning = false;
      // `#reset` clears the flag, so a set one belongs to the current generation even when this
      // run was a superseded one.
      if (this.#snapshotDirty) {
        this.#snapshotDirty = false;
        this.#scheduleSnapshot(this.#gen);
      }
    }
  }

  /**
   * Opens a status connection for exactly `paneIds` when the set changed: the new one first,
   * then the old one closed, so no status change falls in a gap (duplicates are harmless).
   */
  async #swapStatusConnection(gen: number, paneIds: string[]): Promise<void> {
    const key = [...paneIds].sort().join('\n');
    if (key === this.#statusPaneIds) return;
    const old = this.#status;
    let next: Subscription | null = null;
    if (paneIds.length > 0) {
      try {
        next = await subscribe(
          this.target!,
          paneIds.map((pane_id) => ({
            type: 'pane.agent_status_changed',
            pane_id,
          })),
          (ev) => this.#onStatusEvent(gen, ev),
        );
      } catch {
        // Badges go stale until the next structural event retries; the tree still works.
        return;
      }
      if (gen !== this.#gen) {
        void next.close();
        return;
      }
    }
    this.#status = next;
    this.#statusPaneIds = key;
    void old?.close();
  }

  async #onLifecycleEnded(gen: number, why: BridgeError): Promise<void> {
    if (gen !== this.#gen) return;
    const startedAt = this.#lastStart;
    await this.#reset('Herdr connection lost');
    const newGen = this.#gen;
    // Server stopped, or something else? A one-shot call tells them apart. If the server is
    // in fact still there (an `events_lost` that closed the stream, say), reconnect — unless
    // that is already looping.
    const probe = await bridgeRequest(this.target!, 'session.snapshot', {})
      .then(() => null, (e) => e as Error);
    if (newGen !== this.#gen) return;
    if (probe instanceof BridgeError && probe.code === 'no_session') {
      this.#setState('no-session');
    } else if (
      probe === null && Date.now() - startedAt >= MIN_RESTART_INTERVAL_MS
    ) {
      await this.#connect(newGen);
    } else {
      this.#setState('error', probe?.message ?? why.message);
    }
  }
}
