// `devc web`'s language server sessions: one per (container, language, root, options), each a
// `devc-lsp-<language> serve` process run in the file's container through `docker exec`, behind
// an `LspSession` (lsp_session.ts) every attached browser connection shares. The manager runs the
// launcher's `describe` on each attach (with the repo's `language-servers.json` entry, when one
// matches), starts or reuses the session, watches its root (lsp_watch.ts), and stops it when it
// has been idle, its settings changed, its container stopped, or devc web stops. See
// `.plans/devc-web-lsp-core.md` § Process and § Launcher contract.
//
// `describe`/`options` and `serve` are injected (`LauncherRun`, `ServeSpawn`), so the tests run
// a local fake server (`tests/fixtures/fake_lsp_server.ts`) with no Docker.

import {
  type ContainerInfo,
  type ContainerMount,
  dockerExecArgv,
  loginShellArgv,
} from '@devc-tools/core/container.ts';
import {
  containerToHostPath,
  hostToContainerPath,
} from '@devc-tools/core/mount_paths.ts';
import { runDocker } from './container_files.ts';
import { encodeMessage, FrameReader } from './lsp_framing.ts';
import {
  LSP_LANGUAGE_NAMES,
  type LspLanguage,
  lspLanguageFor,
} from './lsp_languages.ts';
import {
  canonicalJson,
  launcherFlags,
  type LspConfigStore,
  type LspProject,
  matchProject,
  normalizeRoot,
  rootContains,
  withProject,
} from './lsp_config.ts';
import {
  type Clock,
  fileUri,
  LSP_IDLE_MS,
  LspSession,
  type LspState,
  type Peer,
  realClock,
  type ServerPort,
} from './lsp_session.ts';
import { RootWatcher, UNWATCHED_NOTICE } from './lsp_watch.ts';
import { type ByteProc, closeGracefully, spawnBytes } from './proc.ts';

/** How long `describe` and `options` may take: `runDocker`'s timeout. */
export const DESCRIBE_TIMEOUT_MS = 15_000;
/** How long `shutdown` may take to be answered before `exit` is sent anyway. */
const SHUTDOWN_WAIT_MS = 5000;
/** How long the server may take to exit after `exit` before its `docker exec` client is killed. */
const EXIT_GRACE_MS = 2000;

/** A finished launcher run: `describe` or `options`. */
export interface LauncherOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `devc-lsp-<language> args…` in the container, to completion. May throw (the 15 s timeout
 * surfaces as a thrown abort).
 */
export type LauncherRun = (
  info: ContainerInfo,
  language: LspLanguage,
  args: string[],
) => Promise<LauncherOutput>;

/** Starts `devc-lsp-<language> serve …` in the container, its stdio piped. May throw. */
export type ServeSpawn = (
  info: ContainerInfo,
  language: LspLanguage,
  args: string[],
) => ByteProc;

/** The launcher's command line: `devc-lsp-<language> args…` through the remote user's login shell. */
export function launcherArgv(
  info: ContainerInfo,
  language: LspLanguage,
  args: string[],
  interactive = false,
): string[] {
  return dockerExecArgv(info, {
    ...(interactive ? { interactive: true } : {}),
    cwd: '/',
    cmd: loginShellArgv('exec "devc-lsp-$0" "$@"', language, ...args),
  });
}

/** `describe` and `options` with `runDocker` (killed after 15 s). */
export const runLauncher: LauncherRun = async (info, language, args) => {
  const out = await runDocker(launcherArgv(info, language, args));
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: out.stderr,
  };
};

/** `serve` with `spawnBytes('docker', …)`. */
export const spawnServe: ServeSpawn = (info, language, args) =>
  spawnBytes('docker', launcherArgv(info, language, args, true));

/** Whether container `id` is still running, to tell a server's crash from its container stopping. */
async function dockerRunning(id: string): Promise<boolean> {
  try {
    const out = await new Deno.Command('docker', {
      args: ['inspect', '-f', '{{.State.Running}}', id],
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
    }).output();
    return out.code === 0 &&
      new TextDecoder().decode(out.stdout).trim() === 'true';
  } catch {
    return false;
  }
}

export type LspErrorCode =
  | 'not_connected'
  | 'no_language_server'
  | 'unsupported'
  | 'describe_failed'
  | 'start_failed'
  | 'bad_request';

/** A refused attach or settings request, in the `fail` shape's `code` and `message`. */
export class LspError extends Error {
  constructor(readonly code: LspErrorCode, message: string) {
    super(message);
  }
}

/** The file an attach or settings request is about. */
export interface LspTarget {
  info: ContainerInfo;
  mounts: ContainerMount[];
  /** The file's absolute container path. */
  path: string;
  /**
   * The file's repo, for a repo file (the message had a `root`): `folder` is the repo folder on
   * the host, `hostPath` the file there. Absent for a container file (the Files node).
   */
  repo?: { folder: string; hostPath: string };
}

/** `lsp_attach`'s answer. */
export interface AttachResult {
  session: string;
  uri: string;
  languageId: string;
  server: string;
  /** `describe`'s root: the session's workspace folder, for the tile's status title. */
  root: string;
  state: LspState;
  detail?: string;
}

/** `describe`'s JSON, checked. */
interface Described {
  root: string;
  languageId: string;
  server: string;
  initializationOptions: unknown;
  settings: Record<string, unknown>;
}

/** A repo file's settings: the file, the matching entry, and where the checkout is. */
interface RepoMatch {
  /** The settings file. */
  path: string;
  /** The checkout root on the host, and in the container (null: not mounted). */
  checkoutHost: string;
  checkoutContainer: string | null;
  /** The file, checkout-relative. */
  rel: string;
  project: LspProject | null;
}

interface Record_ {
  key: string;
  session: LspSession;
  containerId: string;
  language: LspLanguage;
  info: ContainerInfo;
  mounts: ContainerMount[];
  described: Described;
  /** `serve`'s arguments: `--root` and, with an entry, `--options`. */
  serveArgs: string[];
  /** The entry the session was built from (null: detection and defaults), and its settings file. */
  project: LspProject | null;
  configPath: string | null;
  /** The checkout-relative paths of the repo files attached to it. */
  files: Set<string>;
  proc: ByteProc | null;
  watcher: RootWatcher | null;
  /** Ended (exited, or stopped): kept only while connections still name it. */
  ended: boolean;
}

/** `ms` for an `exited` detail: `30 min`, `10 s`. */
function duration(ms: number): string {
  return ms >= 60_000
    ? `${Math.round(ms / 60_000)} min`
    : `${Math.round(ms / 1000)} s`;
}

/** The first non-empty line of `text`, or ''. */
function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
}

/** The last non-empty line of `text`, or ''. */
function lastLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).filter((l) => l !== '').pop() ??
    '';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class LspManager {
  #run: LauncherRun;
  #spawn: ServeSpawn;
  #idleMs: number;
  #clock: Clock;
  #config: LspConfigStore | null;
  #running: (id: string) => Promise<boolean>;
  #watchFs: typeof Deno.watchFs | undefined;
  #warn: (line: string) => void;
  /** Live sessions by key. */
  #byKey = new Map<string, Record_>();
  /** Every session a connection may still name, ended ones included. */
  #byId = new Map<string, Record_>();

  constructor(opts: {
    run?: LauncherRun;
    spawn?: ServeSpawn;
    idleMs?: number;
    clock?: Clock;
    config?: LspConfigStore | null;
    containerRunning?: (id: string) => Promise<boolean>;
    watchFs?: typeof Deno.watchFs;
    warn?: (line: string) => void;
  } = {}) {
    this.#run = opts.run ?? runLauncher;
    this.#spawn = opts.spawn ?? spawnServe;
    this.#idleMs = opts.idleMs ?? LSP_IDLE_MS;
    this.#clock = opts.clock ?? realClock;
    this.#config = opts.config ?? null;
    this.#running = opts.containerRunning ?? dockerRunning;
    this.#watchFs = opts.watchFs;
    this.#warn = opts.warn ?? console.error;
  }

  /** The live session with id `id`, for tests and status. */
  session(id: string): LspSession | null {
    return this.#byId.get(id)?.session ?? null;
  }

  /** How many sessions are live. */
  get size(): number {
    return this.#byKey.size;
  }

  // -------------------------------------------------------------------------------------------
  // Attach
  // -------------------------------------------------------------------------------------------

  /**
   * Starts or reuses the session for `target`'s file and attaches `peer` to it. Throws
   * {@link LspError}: `unsupported` (no language for the name, or `describe` exits 3),
   * `no_language_server` (127), `describe_failed`, `start_failed`.
   */
  async attach(peer: Peer, target: LspTarget): Promise<AttachResult> {
    const language = lspLanguageFor(target.path);
    if (language === null) {
      throw new LspError(
        'unsupported',
        `no language server for ${target.path}`,
      );
    }
    const match = await this.#repoMatch(language, target);
    const flags = match?.checkoutContainer
      ? launcherFlags(match.project, match.checkoutContainer)
      : [];
    const described = await this.#describe(
      target.info,
      language,
      target.path,
      flags,
    );
    const options = match?.project ? canonicalJson(match.project.options) : '';
    const key = [target.info.containerId, language, described.root, options]
      .join('\n');
    let record = this.#byKey.get(key);
    if (!record) {
      record = this.#create(key, language, target, described, match);
      this.#start(record);
    }
    if (match) record.files.add(match.rel);
    record.session.attach(peer);
    const { session } = record;
    return {
      session: session.id,
      uri: fileUri(target.path),
      languageId: described.languageId,
      server: described.server,
      root: described.root,
      state: session.state,
      ...(session.detail !== '' ? { detail: session.detail } : {}),
    };
  }

  /** A repo file's settings file and matching entry; null for a container file. */
  async #repoMatch(
    language: LspLanguage,
    target: LspTarget,
  ): Promise<RepoMatch | null> {
    if (!target.repo || !this.#config) return null;
    const repo = await this.#config.forFolder(target.repo.folder);
    if (!repo) return null;
    const hostPath = target.repo.hostPath;
    const rel = hostPath === repo.checkoutRoot
      ? ''
      : hostPath.startsWith(`${repo.checkoutRoot}/`)
      ? hostPath.slice(repo.checkoutRoot.length + 1)
      : null;
    if (rel === null) return null;
    const checkoutContainer = hostToContainerPath(
      repo.checkoutRoot,
      target.mounts,
    );
    return {
      path: repo.path,
      checkoutHost: repo.checkoutRoot,
      checkoutContainer,
      rel,
      project: matchProject(repo.projects, language, rel),
    };
  }

  #create(
    key: string,
    language: LspLanguage,
    target: LspTarget,
    described: Described,
    match: RepoMatch | null,
  ): Record_ {
    const project = match?.checkoutContainer ? match.project : null;
    const record: Record_ = {
      key,
      containerId: target.info.containerId,
      language,
      info: target.info,
      mounts: target.mounts,
      described,
      serveArgs: [
        'serve',
        '--root',
        described.root,
        ...(project
          ? launcherFlags(project, match!.checkoutContainer!).slice(2)
          : []),
      ],
      project,
      configPath: match?.path ?? null,
      files: new Set(),
      proc: null,
      watcher: null,
      ended: false,
      session: null as unknown as LspSession,
    };
    record.session = new LspSession({
      id: crypto.randomUUID(),
      root: described.root,
      initializationOptions: described.initializationOptions,
      settings: described.settings,
      idleMs: this.#idleMs,
      clock: this.#clock,
      onIdle: () =>
        void this.#stop(record, `stopped after ${duration(this.#idleMs)} idle`),
      onWatchers: (w) => record.watcher?.setWatchers(w),
      onExited: () => this.#ended(record),
    });
    this.#byKey.set(key, record);
    this.#byId.set(record.session.id, record);
    return record;
  }

  /** Spawns the record's `serve` and connects its session to it; `start_failed` if it can't. */
  #start(record: Record_) {
    let proc: ByteProc;
    try {
      proc = this.#spawn(record.info, record.language, record.serveArgs);
    } catch (e) {
      this.#byKey.delete(record.key);
      this.#byId.delete(record.session.id);
      throw new LspError(
        'start_failed',
        this.#message(
          record.language,
          e instanceof Error ? e.message : String(e),
        ),
      );
    }
    record.proc = proc;
    record.session.connect(this.#port(record, proc));
    record.watcher?.stop();
    record.watcher = null;
    const hostRoot = containerToHostPath(record.described.root, record.mounts);
    if (hostRoot === null) {
      record.session.setNotice(UNWATCHED_NOTICE);
      return;
    }
    record.watcher = new RootWatcher({
      hostRoot,
      root: record.described.root,
      clock: this.#clock,
      ...(this.#watchFs ? { watchFs: this.#watchFs } : {}),
      notify: (changes) =>
        record.session.notifyServer('workspace/didChangeWatchedFiles', {
          changes,
        }),
      onFailure: (e) => {
        this.#warn(
          `devc web: can't watch ${hostRoot} for the ${
            LSP_LANGUAGE_NAMES[record.language]
          } language server (${
            e instanceof Error ? e.message : e
          }); ${UNWATCHED_NOTICE}`,
        );
        record.session.setNotice(UNWATCHED_NOTICE);
      },
    });
  }

  /** The {@link ServerPort} over a `serve` process: framed stdio, and its exit with a reason. */
  #port(record: Record_, proc: ByteProc): ServerPort {
    const reader = new FrameReader();
    let onMessage: (m: Record<string, unknown>) => void = () => {};
    const exitHandlers: ((reason: string) => void)[] = [];
    let exitReason: string | null = null;
    (async () => {
      try {
        for await (const chunk of proc.stdout) {
          for (const msg of reader.push(chunk)) {
            if (isObject(msg)) onMessage(msg);
          }
        }
      } catch { /* stdout broke: the exit below says why */ }
      const { code } = await proc.status;
      const stderr = await proc.stderr;
      let reason: string;
      if (!(await this.#running(record.containerId))) {
        reason = 'container stopped';
      } else {
        const tail = lastLine(stderr) || firstLine(reader.discarded);
        reason = `exit code ${code ?? 'unknown'}${tail ? `: ${tail}` : ''}`;
      }
      exitReason = reason;
      for (const fn of exitHandlers) fn(reason);
    })();
    return {
      send: (msg) => void proc.write(encodeMessage(msg)),
      onMessage: (fn) => onMessage = fn,
      onExit: (fn) => {
        if (exitReason !== null) fn(exitReason);
        else exitHandlers.push(fn);
      },
    };
  }

  /**
   * Runs `describe` and checks its JSON. Throws {@link LspError}: `unsupported` (exit 3),
   * `no_language_server` (127), `describe_failed` (anything else, or a timeout).
   */
  async #describe(
    info: ContainerInfo,
    language: LspLanguage,
    path: string,
    flags: string[],
  ): Promise<Described> {
    const out = await this.#launch(info, language, [
      'describe',
      path,
      ...flags,
    ]);
    if (out.code === 3) {
      throw new LspError(
        'unsupported',
        this.#message(
          language,
          firstLine(out.stderr) || 'this file is not served',
        ),
      );
    }
    if (out.code !== 0) this.#launchFailed(language, out);
    const d = parseObject(out.stdout);
    const bad = (why: string): never => {
      throw new LspError(
        'describe_failed',
        this.#message(language, `describe ${why}`),
      );
    };
    if (!d) return bad('printed no JSON object');
    if (d.protocol !== 1) {
      return bad(`speaks protocol ${JSON.stringify(d.protocol)}, not 1`);
    }
    if (typeof d.root !== 'string' || !d.root.startsWith('/')) {
      return bad('gave no absolute root');
    }
    if (typeof d.languageId !== 'string' || d.languageId === '') {
      return bad('gave no languageId');
    }
    return {
      root: d.root.length > 1 ? d.root.replace(/\/+$/, '') : d.root,
      languageId: d.languageId,
      server: typeof d.server === 'string' ? d.server : '',
      initializationOptions: d.initializationOptions ?? {},
      settings: isObject(d.settings) ? d.settings : {},
    };
  }

  /**
   * A launcher run, a throw (the timeout) or a non-zero exit after the timeout being
   * `describe_failed` with `describe timed out after 15 s`.
   */
  async #launch(
    info: ContainerInfo,
    language: LspLanguage,
    args: string[],
  ): Promise<LauncherOutput> {
    const started = Date.now();
    const timedOut = () => {
      throw new LspError(
        'describe_failed',
        this.#message(
          language,
          `${args[0]} timed out after ${DESCRIBE_TIMEOUT_MS / 1000} s`,
        ),
      );
    };
    let out: LauncherOutput;
    try {
      out = await this.#run(info, language, args);
    } catch {
      return timedOut();
    }
    if (out.code !== 0 && Date.now() - started >= DESCRIBE_TIMEOUT_MS) {
      timedOut();
    }
    return out;
  }

  /** A failed launcher run: 127 is `no_language_server`, anything else `describe_failed`. */
  #launchFailed(language: LspLanguage, out: LauncherOutput): never {
    if (out.code === 127) {
      throw new LspError(
        'no_language_server',
        this.#message(language, `devc-lsp-${language} is not installed`),
      );
    }
    throw new LspError(
      'describe_failed',
      this.#message(language, firstLine(out.stderr) || `exit code ${out.code}`),
    );
  }

  /** `<Language> language server: <detail>`, the `fail` message and the tile's status line. */
  #message(language: LspLanguage, detail: string): string {
    return `${LSP_LANGUAGE_NAMES[language]} language server: ${detail}`;
  }

  // -------------------------------------------------------------------------------------------
  // Messages, detach, restart
  // -------------------------------------------------------------------------------------------

  /** `lsp_send`: dropped unless `peer` is attached to session `id`. */
  send(peer: Peer, id: string, message: Record<string, unknown>): void {
    const record = this.#byId.get(id);
    if (!record || !record.session.has(peer)) return;
    record.session.fromPeer(peer, message);
  }

  /** `lsp_detach`: `peer` stops using session `id`; its documents are closed. */
  detach(peer: Peer, id: string): void {
    const record = this.#byId.get(id);
    if (!record) return;
    record.session.detach(peer);
    if (record.ended && record.session.peerCount === 0) this.#byId.delete(id);
  }

  /** A connection closed: detached from every session. */
  detachAll(peer: Peer): void {
    for (const [id, record] of [...this.#byId]) {
      if (record.session.has(peer)) this.detach(peer, id);
    }
  }

  /**
   * `lsp_restart`: the server is stopped (gracefully) and started again with the same key; every
   * attached connection is told `starting`. An ended session whose key is free starts again too.
   */
  async restart(id: string): Promise<void> {
    const record = this.#byId.get(id);
    if (!record) {
      throw new LspError('bad_request', 'unknown language server session');
    }
    if (record.ended) {
      if (this.#byKey.has(record.key)) {
        throw new LspError(
          'bad_request',
          'the language server was already started again',
        );
      }
      record.ended = false;
      this.#byKey.set(record.key, record);
    } else {
      await this.#stopProcess(record);
    }
    this.#start(record);
  }

  // -------------------------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------------------------

  /** `lsp_settings_get`'s answer for `target`'s file. */
  async settingsGet(target: LspTarget): Promise<Record<string, unknown>> {
    const language = lspLanguageFor(target.path);
    if (language === null) {
      throw new LspError(
        'unsupported',
        `no language server for ${target.path}`,
      );
    }
    const out = await this.#launch(target.info, language, ['options']);
    if (out.code !== 0) this.#launchFailed(language, out);
    const schema = parseObject(out.stdout);
    if (!schema || schema.protocol !== 1 || !Array.isArray(schema.options)) {
      throw new LspError(
        'describe_failed',
        this.#message(
          language,
          !schema
            ? 'options printed no JSON object'
            : `options speaks protocol ${
              JSON.stringify(schema.protocol)
            }, not 1`,
        ),
      );
    }
    let detected: { root: string; server: string } | null;
    try {
      const d = await this.#describe(target.info, language, target.path, []);
      detected = { root: d.root, server: d.server };
    } catch (e) {
      if (!(e instanceof LspError && e.code === 'unsupported')) throw e;
      detected = null;
    }
    const match = await this.#repoMatch(language, target);
    const editable = match !== null && match.checkoutContainer !== null;
    return {
      language,
      checkoutRoot: editable ? match.checkoutContainer : null,
      path: editable ? match.rel : null,
      detected,
      entry: editable && match.project
        ? { root: match.project.root, options: match.project.options }
        : null,
      schema,
      editable,
    };
  }

  /**
   * `lsp_settings_set`: replaces (or adds) the entry for the file's language at `entry.root`, or
   * with `entry` null removes the one matching the file; written atomically. The config watch
   * then restarts the sessions it changes (and so does this call, without waiting for it).
   */
  async settingsSet(
    target: LspTarget,
    entry: { root: string; options: Record<string, unknown> } | null,
  ): Promise<void> {
    const language = lspLanguageFor(target.path);
    if (language === null) {
      throw new LspError(
        'unsupported',
        `no language server for ${target.path}`,
      );
    }
    const match = await this.#repoMatch(language, target);
    if (!match || !this.#config) {
      throw new LspError(
        'bad_request',
        'only a repo file has per-project settings',
      );
    }
    let next: { root: string; options: Record<string, unknown> } | null = null;
    if (entry !== null) {
      const root = normalizeRoot(entry.root);
      if (root === null || !rootContains(root, match.rel)) {
        throw new LspError(
          'bad_request',
          `${entry.root || '.'} does not contain the file`,
        );
      }
      next = { root, options: entry.options };
    }
    const projects = await this.#config.read(match.path);
    await this.#config.write(
      match.path,
      withProject(projects, language, match.rel, next),
    );
  }

  /**
   * The settings file at `path` changed: every session built from it whose entry is no longer
   * what a fresh match gives one of its files is stopped, `exited` detail `settings changed`
   * (its pages attach again, and get a session from the new settings).
   */
  async settingsChanged(path: string): Promise<void> {
    if (!this.#config) return;
    const projects = await this.#config.read(path);
    const stale = [...this.#byKey.values()].filter((r) =>
      r.configPath === path &&
      [...r.files].some((rel) => {
        const fresh = matchProject(projects, r.language, rel);
        return (fresh?.root ?? null) !== (r.project?.root ?? null) ||
          canonicalJson(fresh?.options ?? null) !==
            canonicalJson(r.project?.options ?? null);
      })
    );
    await Promise.all(stale.map((r) => this.#stop(r, 'settings changed')));
  }

  // -------------------------------------------------------------------------------------------
  // Stopping
  // -------------------------------------------------------------------------------------------

  /** Container `id` stopped: its sessions end, `container stopped`. */
  containerGone(id: string): void {
    for (const record of [...this.#byKey.values()]) {
      if (record.containerId !== id) continue;
      this.#retire(record);
      record.session.markExited('container stopped');
      record.proc?.kill();
    }
  }

  /** Stops every session, gracefully: devc web's own shutdown. */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.#byKey.values()].map((r) => this.#stop(r, 'devc web stopped')),
    );
  }

  /** Stops a session gracefully and ends it with `reason`. */
  async #stop(record: Record_, reason: string): Promise<void> {
    if (record.ended) return;
    this.#retire(record);
    await this.#stopProcess(record);
    record.session.markExited(reason);
  }

  /** `shutdown`, `exit`, then the client closed (killed after a grace). */
  async #stopProcess(record: Record_): Promise<void> {
    record.watcher?.stop();
    record.watcher = null;
    const proc = record.proc;
    record.proc = null;
    await record.session.shutdown(SHUTDOWN_WAIT_MS);
    if (proc) await closeGracefully(proc, EXIT_GRACE_MS);
  }

  /** The session exited on its own (or failed to initialize): the next attach starts a new one. */
  #ended(record: Record_) {
    const proc = record.proc;
    this.#retire(record);
    if (proc) void closeGracefully(proc, EXIT_GRACE_MS);
  }

  /** No longer live: out of {@link #byKey}, and out of {@link #byId} once nobody names it. */
  #retire(record: Record_) {
    record.ended = true;
    record.watcher?.stop();
    record.watcher = null;
    if (this.#byKey.get(record.key) === record) this.#byKey.delete(record.key);
    if (record.session.peerCount === 0) this.#byId.delete(record.session.id);
  }
}

/** `text` as one JSON object (nothing else around it); null when it isn't one. */
function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}
