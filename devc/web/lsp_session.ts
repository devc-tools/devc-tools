// One language server session of `devc web`: the host is the only LSP client the server sees,
// and every attached browser connection is a client of the host. The session answers the
// pages' lifecycle messages itself (one `initialize` for the server, its result cached for every
// page), merges their documents (one open per URI, host-numbered versions), remaps request ids
// so two pages' ids never collide, answers the server's requests to the client, turns pulled
// diagnostics into pushed ones, and reports progress as `lsp_status`. Diff tiles open **view
// documents** (`devc/openView`, `devc/closeView`), which never replace an editor's text or close
// its document (see `.plans/devc-web-lsp-diff-hover.md`). Pure: the server process is
// a {@link ServerPort} and time is an injected {@link Clock}. See `.plans/devc-web-lsp-core.md`
// § Host session behavior.

/** The server process, as the session drives it: whole JSON-RPC messages, no framing. */
export interface ServerPort {
  send(msg: Record<string, unknown>): void;
  onMessage(fn: (msg: Record<string, unknown>) => void): void;
  /** `fn(reason)` once the server has exited, with the `exited` detail. */
  onExit(fn: (reason: string) => void): void;
}

/** An attached browser connection: the `lsp` and `lsp_status` messages go to it as text. */
export interface Peer {
  send(text: string): void;
}

/** Timers, injected so tests can run them by hand. */
export interface Clock {
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimeout(handle: Timer): void;
}

/** A {@link Clock}'s timer handle. */
export type Timer = unknown;

export const realClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type LspState = 'starting' | 'ready' | 'exited';

/** How long a session with no attached connection waits before it stops: 30 minutes. */
export const LSP_IDLE_MS = 30 * 60 * 1000;

/**
 * {@link LSP_IDLE_MS}, or `DEVC_WEB_LSP_IDLE_MS` (whole milliseconds) when it is set to one: read
 * once at startup, for testing.
 */
export function lspIdleMs(
  env: { get(key: string): string | undefined },
): number {
  const raw = env.get('DEVC_WEB_LSP_IDLE_MS');
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return LSP_IDLE_MS;
  return Number(raw.trim());
}

/** How long after a document's last change its diagnostics are pulled. */
export const PULL_DEBOUNCE_MS = 250;

/** A file-watcher registration's watchers: `DidChangeWatchedFilesRegistrationOptions.watchers`. */
export type FileWatcher = { globPattern: unknown; kind?: number };

export interface SessionOptions {
  /** The session id the pages address it by (`lsp_send`'s `session`). */
  id: string;
  /** The server's workspace folder, a container path: `describe`'s `root`. */
  root: string;
  /** `describe`'s `initializationOptions`, sent as they are. */
  initializationOptions: unknown;
  /** `describe`'s `settings`: `workspace/configuration`'s answers. */
  settings: Record<string, unknown>;
  /** How long it waits with no attached connection before {@link onIdle}. */
  idleMs: number;
  clock?: Clock;
  /** No connection has been attached for {@link idleMs}: the manager stops it. */
  onIdle?: () => void;
  /** The server's file-watcher registrations changed: all of their watchers, flattened. */
  onWatchers?: (watchers: FileWatcher[]) => void;
  /** The server exited on its own (not through {@link LspSession.shutdown}), with the reason. */
  onExited?: (reason: string) => void;
}

/** The capabilities the host adds to the first page's, for what it handles itself. */
const HOST_CAPABILITIES = {
  workspace: {
    configuration: true,
    workspaceFolders: true,
    didChangeWatchedFiles: { dynamicRegistration: true },
    diagnostics: { refreshSupport: true },
  },
  window: { workDoneProgress: true },
  textDocument: { diagnostic: { dynamicRegistration: false } },
};

type Msg = Record<string, unknown>;
type Id = number | string;

interface PeerState {
  /** The documents it has open as an editor. */
  uris: Set<string>;
  /** The documents it has open as a view (`devc/openView`). */
  views: Set<string>;
}

interface Doc {
  /** Editors: `didOpen`/`didClose`. Only they get diagnostics and pulls. */
  openers: Set<Peer>;
  /** Views: `devc/openView`/`devc/closeView`, each holding {@link text} as it opened it. */
  viewers: Set<Peer>;
  /** The host's own version counter: the pages' numbers are ignored. */
  version: number;
  /** The document's whole text, as the server has it (every change is a full text). */
  text: string;
}

/**
 * A plain object's deep merge: `add`'s values win, objects merge recursively, anything else
 * (arrays included) is replaced.
 */
export function deepMerge(base: unknown, add: unknown): unknown {
  if (!isObject(base) || !isObject(add)) return add === undefined ? base : add;
  const out: Msg = { ...base };
  for (const [k, v] of Object.entries(add)) out[k] = deepMerge(base[k], v);
  return out;
}

/** The value at a dot path (`python.analysis`) in `settings`, or null when there is none. */
export function settingAt(settings: unknown, section: string): unknown {
  let at: unknown = settings;
  for (const part of section.split('.')) {
    if (!isObject(at) || !Object.hasOwn(at, part)) return null;
    at = at[part];
  }
  return at ?? null;
}

function isObject(v: unknown): v is Msg {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The last path segment of `root`, for a workspace folder's `name`. */
function baseName(root: string): string {
  const parts = root.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '/';
}

/** `file://` and a container path, percent-encoded per segment. */
export function fileUri(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** The requests whose answer is a `Location`, `Location[]` or `LocationLink[]`. */
const LOCATION_METHODS = new Set([
  'textDocument/definition',
  'textDocument/declaration',
  'textDocument/typeDefinition',
  'textDocument/implementation',
]);

/**
 * A definition answer as `Location`s: lsp-client reads `uri` and `range` only, and some servers
 * (`deno lsp`) answer `LocationLink`s even to a client that never claimed `linkSupport`. A link
 * becomes its target, at its selection range.
 */
export function asLocations(result: unknown): unknown {
  const one = (v: unknown) => {
    if (!isObject(v) || typeof v.targetUri !== 'string') return v;
    return { uri: v.targetUri, range: v.targetSelectionRange ?? v.targetRange };
  };
  return Array.isArray(result) ? result.map(one) : one(result);
}

/** A `$/progress` value's text: `title message percentage%`, absent parts left out. */
function progressText(
  p: { title?: string; message?: string; percentage?: number },
) {
  return [
    p.title,
    p.message,
    typeof p.percentage === 'number' ? `${p.percentage}%` : undefined,
  ].filter((s) => typeof s === 'string' && s !== '').join(' ');
}

export class LspSession {
  readonly id: string;
  readonly root: string;
  readonly rootUri: string;
  #initOptions: unknown;
  #settings: Record<string, unknown>;
  #idleMs: number;
  #clock: Clock;
  #opts: SessionOptions;

  #port: ServerPort | null = null;
  #state: LspState = 'starting';
  #detail = '';
  /** The last status each peer was sent, so a repeat is not sent again. */
  #sentStatus = new Map<Peer, string>();
  /** A persistent notice, shown while ready and idle (`file changes … are not seen`). */
  #notice = '';
  #idleTimer: Timer | null = null;
  /** Set by {@link shutdown}: the exit that follows is not the server's own. */
  #stopping = false;

  #peers = new Map<Peer, PeerState>();
  #docs = new Map<string, Doc>();
  /** The last diagnostics per URI, without a version, for late openers. */
  #diagnostics = new Map<string, unknown[]>();
  /** Pull diagnostics: each URI's last `resultId`, and its debounce timer. */
  #resultIds = new Map<string, string>();
  #pullTimers = new Map<string, Timer>();

  #nextId = 0;
  /** The host's own requests (initialize, shutdown, pulls): id → its answer's handler. */
  #own = new Map<Id, (reply: Msg) => void>();
  /** Forwarded page requests: host id → the page, its id and the method, and back. */
  #forwarded = new Map<Id, { peer: Peer; pageId: Id; method: string }>();
  #byPage = new Map<Peer, Map<string, Id>>();

  /** Started: the host's `initialize` was sent. */
  #initializing = false;
  /** `initialize`'s result, with `textDocumentSync` rewritten; null until it came. */
  #initResult: Msg | null = null;
  /** Pages' `initialize` requests waiting on {@link #initResult}. */
  #initWaiting: { peer: Peer; pageId: Id }[] = [];
  /** Other page messages that arrived before ready, replayed once it is. */
  #early: { peer: Peer; msg: Msg }[] = [];

  /** `$/progress` tokens in flight: token → its text, and when it last changed. */
  #progress = new Map<Id, { text: string; title?: string; seq: number }>();
  #progressSeq = 0;
  /** `client/registerCapability` file-watcher registrations, by id. */
  #watchers = new Map<string, FileWatcher[]>();

  constructor(opts: SessionOptions) {
    this.id = opts.id;
    this.root = opts.root;
    this.rootUri = fileUri(opts.root);
    this.#initOptions = opts.initializationOptions;
    this.#settings = opts.settings;
    this.#idleMs = opts.idleMs;
    this.#clock = opts.clock ?? realClock;
    this.#opts = opts;
  }

  get state(): LspState {
    return this.#state;
  }

  get detail(): string {
    return this.#detail;
  }

  /** How many connections are attached. */
  get peerCount(): number {
    return this.#peers.size;
  }

  /** Whether `peer` is attached. */
  has(peer: Peer): boolean {
    return this.#peers.has(peer);
  }

  /** The server's `initialize` result as the pages get it; null until ready. */
  get capabilities(): Msg | null {
    return this.#initResult;
  }

  // -------------------------------------------------------------------------------------------
  // The server process
  // -------------------------------------------------------------------------------------------

  /**
   * Connects the session to a (new) server process: everything the last one knew is dropped,
   * and every attached connection is told `starting`, so each page reconnects its client (which
   * re-sends `initialize` and re-opens its documents).
   */
  connect(port: ServerPort): void {
    this.#resetServerState();
    this.#port = port;
    this.#stopping = false;
    port.onMessage((msg) => {
      if (this.#port === port) this.#fromServer(msg);
    });
    port.onExit((reason) => {
      if (this.#port !== port) return;
      this.#port = null;
      if (this.#stopping) return;
      this.markExited(reason);
      this.#opts.onExited?.(reason);
    });
    this.#setStatus('starting', '');
  }

  #resetServerState() {
    for (const t of this.#pullTimers.values()) this.#clock.clearTimeout(t);
    this.#pullTimers.clear();
    this.#resultIds.clear();
    this.#docs.clear();
    this.#diagnostics.clear();
    for (const s of this.#peers.values()) {
      s.uris.clear();
      s.views.clear();
    }
    // Page requests the old server will never answer.
    for (const [, { peer, pageId }] of this.#forwarded) {
      this.#toPeer(peer, {
        jsonrpc: '2.0',
        id: pageId,
        error: { code: -32800, message: 'the language server restarted' },
      });
    }
    this.#forwarded.clear();
    this.#byPage.clear();
    this.#own.clear();
    this.#initializing = false;
    this.#initResult = null;
    this.#early = [];
    this.#progress.clear();
    if (this.#watchers.size > 0) {
      this.#watchers.clear();
      this.#opts.onWatchers?.([]);
    }
  }

  /**
   * Stops the server the graceful way: `shutdown`, its answer awaited up to `timeoutMs`, then
   * `exit`. The caller then closes the process (`closeGracefully`). The exit that follows is not
   * reported as the server's own.
   */
  async shutdown(timeoutMs = 5000): Promise<void> {
    const port = this.#port;
    this.#stopping = true;
    if (!port) return;
    let timer: Timer | undefined;
    await new Promise<void>((resolve) => {
      const id = this.#hostRequest('shutdown', null, () => resolve());
      if (id === null) return resolve();
      timer = this.#clock.setTimeout(() => {
        this.#own.delete(id);
        resolve();
      }, timeoutMs);
    });
    if (timer !== undefined) this.#clock.clearTimeout(timer);
    try {
      port.send({ jsonrpc: '2.0', method: 'exit' });
    } catch { /* already gone */ }
  }

  /** The session has ended: every attached connection is told `exited` with `reason`. */
  markExited(reason: string): void {
    this.#cancelIdle();
    for (const t of this.#pullTimers.values()) this.#clock.clearTimeout(t);
    this.#pullTimers.clear();
    this.#setStatus('exited', reason);
  }

  /** Sets the persistent notice shown while ready and idle (empty: none). */
  setNotice(notice: string): void {
    this.#notice = notice;
    if (this.#state === 'ready' && this.#progress.size === 0) {
      this.#setStatus('ready', notice);
    }
  }

  /**
   * Sends the server a notification of the host's own (the watcher's), once it is ready. After
   * `workspace/didChangeWatchedFiles`, a pull server's open documents are pulled again: not every
   * one asks for that with `workspace/diagnostic/refresh` (`deno lsp` doesn't).
   */
  notifyServer(method: string, params: unknown): void {
    if (this.#state !== 'ready') return;
    this.#toServer({ jsonrpc: '2.0', method, params });
    if (method === 'workspace/didChangeWatchedFiles') {
      for (const uri of this.#docs.keys()) this.#schedulePull(uri);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------------------------

  /** Attaches a connection (again: a no-op). Cancels a pending idle stop. */
  attach(peer: Peer): void {
    this.#cancelIdle();
    if (!this.#peers.has(peer)) {
      this.#peers.set(peer, { uris: new Set(), views: new Set() });
    }
  }

  /**
   * Detaches a connection: its documents are closed as by `didClose`, its requests' answers
   * dropped. With no connection left, the idle stop starts.
   */
  detach(peer: Peer): void {
    const s = this.#peers.get(peer);
    if (!s) return;
    for (const uri of [...s.uris]) this.#close(peer, uri);
    for (const uri of [...s.views]) this.#closeView(peer, uri);
    this.#peers.delete(peer);
    this.#sentStatus.delete(peer);
    this.#byPage.delete(peer);
    for (const [hostId, f] of this.#forwarded) {
      if (f.peer === peer) this.#forwarded.delete(hostId);
    }
    this.#initWaiting = this.#initWaiting.filter((w) => w.peer !== peer);
    this.#early = this.#early.filter((e) => e.peer !== peer);
    if (this.#peers.size === 0 && this.#state !== 'exited') {
      this.#idleTimer = this.#clock.setTimeout(() => {
        this.#idleTimer = null;
        if (this.#peers.size === 0) this.#opts.onIdle?.();
      }, this.#idleMs);
    }
  }

  #cancelIdle() {
    if (this.#idleTimer !== null) this.#clock.clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  /** One message from an attached page (`lsp_send`'s `message`). */
  fromPeer(peer: Peer, msg: Msg): void {
    if (!this.#peers.has(peer) || this.#state === 'exited') return;
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    const hasId = 'id' in msg &&
      (typeof msg.id === 'number' || typeof msg.id === 'string');
    if (method === 'initialize' && hasId) {
      this.#pageInitialize(peer, msg);
      return;
    }
    if (method === 'initialized' || method === 'exit') return;
    if (method === 'shutdown' && hasId) {
      this.#toPeer(peer, { jsonrpc: '2.0', id: msg.id, result: null });
      return;
    }
    if (method === undefined) return; // a page answers no server requests: the host does
    if (this.#state !== 'ready') {
      this.#early.push({ peer, msg });
      return;
    }
    this.#pageMessage(peer, method, msg, hasId);
  }

  #pageInitialize(peer: Peer, msg: Msg) {
    const pageId = msg.id as Id;
    if (this.#initResult) {
      this.#toPeer(peer, {
        jsonrpc: '2.0',
        id: pageId,
        result: this.#initResult,
      });
      return;
    }
    this.#initWaiting.push({ peer, pageId });
    if (this.#initializing || !this.#port) return;
    this.#initializing = true;
    const params = isObject(msg.params) ? msg.params : {};
    this.#hostRequest('initialize', {
      processId: null,
      clientInfo: { name: 'devc web' },
      rootUri: this.rootUri,
      rootPath: this.root,
      workspaceFolders: [{ uri: this.rootUri, name: baseName(this.root) }],
      initializationOptions: this.#initOptions,
      capabilities: deepMerge(params.capabilities ?? {}, HOST_CAPABILITIES),
    }, (reply) => this.#initialized(reply));
  }

  #initialized(reply: Msg) {
    if (reply.error !== undefined || !isObject(reply.result)) {
      const err = reply.error as { message?: unknown } | undefined;
      const why = `initialize failed: ${
        typeof err?.message === 'string' ? err.message : 'no result'
      }`;
      for (const w of this.#initWaiting) {
        this.#toPeer(w.peer, {
          jsonrpc: '2.0',
          id: w.pageId,
          error: { code: -32603, message: why },
        });
      }
      this.#initWaiting = [];
      this.markExited(why);
      this.#opts.onExited?.(why);
      return;
    }
    this.#toServer({ jsonrpc: '2.0', method: 'initialized', params: {} });
    this.#toServer({
      jsonrpc: '2.0',
      method: 'workspace/didChangeConfiguration',
      params: { settings: this.#settings },
    });
    const result = reply.result;
    const caps = isObject(result.capabilities) ? result.capabilities : {};
    this.#initResult = {
      ...result,
      capabilities: {
        ...caps,
        // Pages always send whole documents: every server takes a full-text change.
        textDocumentSync: { openClose: true, change: 1 },
      },
    };
    this.#setStatus('ready', this.#progressDetail());
    for (const w of this.#initWaiting) {
      this.#toPeer(w.peer, {
        jsonrpc: '2.0',
        id: w.pageId,
        result: this.#initResult,
      });
    }
    this.#initWaiting = [];
    const early = this.#early;
    this.#early = [];
    for (const { peer, msg } of early) this.fromPeer(peer, msg);
  }

  #pageMessage(peer: Peer, method: string, msg: Msg, hasId: boolean) {
    const params = isObject(msg.params) ? msg.params : {};
    const td = isObject(params.textDocument) ? params.textDocument : {};
    const uri = typeof td.uri === 'string' ? td.uri : null;
    if (method === 'textDocument/didOpen' && uri) {
      this.#open(peer, uri, td);
      return;
    }
    if (method === 'devc/openView' && hasId && uri) {
      this.#openView(peer, msg.id as Id, uri, td);
      return;
    }
    if (method === 'devc/closeView' && uri) {
      this.#closeView(peer, uri);
      return;
    }
    if (method === 'textDocument/didChange' && uri) {
      const doc = this.#docs.get(uri);
      if (!doc) return;
      const changes = Array.isArray(params.contentChanges)
        ? params.contentChanges
        : [];
      const last = changes[changes.length - 1];
      if (isObject(last) && typeof last.text === 'string') {
        this.#setText(doc, uri, last.text);
      }
      doc.version++;
      this.#toServer({
        jsonrpc: '2.0',
        method,
        params: { ...params, textDocument: { uri, version: doc.version } },
      });
      this.#schedulePull(uri);
      return;
    }
    if (method === 'textDocument/didClose' && uri) {
      this.#close(peer, uri);
      return;
    }
    if (method === '$/cancelRequest') {
      const pageId = params.id;
      const hostId = this.#byPage.get(peer)?.get(String(pageId));
      if (hostId !== undefined) {
        this.#toServer({ jsonrpc: '2.0', method, params: { id: hostId } });
      }
      return;
    }
    if (!hasId) {
      this.#toServer(msg);
      return;
    }
    const hostId = ++this.#nextId;
    const pageId = msg.id as Id;
    this.#forwarded.set(hostId, { peer, pageId, method });
    let ids = this.#byPage.get(peer);
    if (!ids) this.#byPage.set(peer, ids = new Map());
    ids.set(String(pageId), hostId);
    this.#toServer({ ...msg, id: hostId });
  }

  #open(peer: Peer, uri: string, td: Msg) {
    this.#peers.get(peer)?.uris.add(uri);
    const text = typeof td.text === 'string' ? td.text : '';
    const doc = this.#docs.get(uri);
    if (!doc) {
      this.#docs.set(uri, {
        openers: new Set([peer]),
        viewers: new Set(),
        version: 1,
        text,
      });
      this.#toServer({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: { textDocument: { ...td, uri, version: 1 } },
      });
    } else {
      // An editor always wins: its text replaces whatever views hold.
      this.#setText(doc, uri, text);
      doc.openers.add(peer);
      doc.version++;
      this.#toServer({
        jsonrpc: '2.0',
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri, version: doc.version },
          contentChanges: [{ text }],
        },
      });
      const stored = this.#diagnostics.get(uri);
      if (stored) this.#sendDiagnostics(uri, stored, [peer]);
    }
    this.#schedulePull(uri);
  }

  #close(peer: Peer, uri: string) {
    this.#peers.get(peer)?.uris.delete(uri);
    const doc = this.#docs.get(uri);
    if (!doc || !doc.openers.delete(peer)) return;
    this.#closeIfUnheld(doc, uri);
  }

  /**
   * `devc/openView`: opens `uri` with a diff tile's text, answered here with `{ok}`. A document
   * with editors is never changed: unequal text is refused (`edited`) with the text the server
   * has, so the diff tile can map its lines onto it. One held only by views takes the new text,
   * and the other views are told `devc/viewStale`.
   */
  #openView(peer: Peer, pageId: Id, uri: string, td: Msg) {
    const text = typeof td.text === 'string' ? td.text : '';
    const answer = (result: Msg) =>
      this.#toPeer(peer, { jsonrpc: '2.0', id: pageId, result });
    const doc = this.#docs.get(uri);
    if (!doc) {
      this.#docs.set(uri, {
        openers: new Set(),
        viewers: new Set([peer]),
        version: 1,
        text,
      });
      this.#toServer({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri,
            languageId: typeof td.languageId === 'string' ? td.languageId : '',
            version: 1,
            text,
          },
        },
      });
    } else if (doc.text !== text) {
      if (doc.openers.size > 0) {
        answer({ ok: false, reason: 'edited', text: doc.text });
        return;
      }
      doc.viewers.delete(peer);
      this.#setText(doc, uri, text);
      doc.version++;
      this.#toServer({
        jsonrpc: '2.0',
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri, version: doc.version },
          contentChanges: [{ text }],
        },
      });
      doc.viewers.add(peer);
    } else {
      doc.viewers.add(peer);
    }
    this.#peers.get(peer)?.views.add(uri);
    answer({ ok: true });
  }

  /** `devc/closeView`: the server's `didClose` only once no editor or view holds `uri`. */
  #closeView(peer: Peer, uri: string) {
    this.#peers.get(peer)?.views.delete(uri);
    const doc = this.#docs.get(uri);
    if (!doc || !doc.viewers.delete(peer)) return;
    this.#closeIfUnheld(doc, uri);
  }

  /**
   * A document's text becomes `text`: if that changes it, every view holding the old text is
   * told `devc/viewStale` and let go.
   */
  #setText(doc: Doc, uri: string, text: string) {
    if (doc.text === text) return;
    doc.text = text;
    for (const viewer of doc.viewers) {
      this.#peers.get(viewer)?.views.delete(uri);
      this.#toPeer(viewer, {
        jsonrpc: '2.0',
        method: 'devc/viewStale',
        params: { textDocument: { uri } },
      });
    }
    doc.viewers.clear();
  }

  #closeIfUnheld(doc: Doc, uri: string) {
    if (doc.openers.size > 0 || doc.viewers.size > 0) return;
    this.#docs.delete(uri);
    this.#diagnostics.delete(uri);
    this.#resultIds.delete(uri);
    const t = this.#pullTimers.get(uri);
    if (t !== undefined) this.#clock.clearTimeout(t);
    this.#pullTimers.delete(uri);
    this.#toServer({
      jsonrpc: '2.0',
      method: 'textDocument/didClose',
      params: { textDocument: { uri } },
    });
  }

  // -------------------------------------------------------------------------------------------
  // From the server
  // -------------------------------------------------------------------------------------------

  #fromServer(msg: Msg) {
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    const hasId = 'id' in msg && msg.id !== null && msg.id !== undefined;
    if (method === undefined) {
      if (!hasId) return;
      const id = msg.id as Id;
      const own = this.#own.get(id);
      if (own) {
        this.#own.delete(id);
        own(msg);
        return;
      }
      const f = this.#forwarded.get(id);
      if (!f) return;
      this.#forwarded.delete(id);
      this.#byPage.get(f.peer)?.delete(String(f.pageId));
      if (!this.#peers.has(f.peer)) return;
      const { id: _, ...rest } = msg;
      if (LOCATION_METHODS.has(f.method) && 'result' in rest) {
        rest.result = asLocations(rest.result);
      }
      this.#toPeer(f.peer, { ...rest, id: f.pageId });
      return;
    }
    const params = msg.params;
    if (hasId) {
      this.#serverRequest(msg.id as Id, method, params);
      return;
    }
    this.#serverNotification(method, params);
  }

  #serverRequest(id: Id, method: string, params: unknown) {
    const p = isObject(params) ? params : {};
    const answer = (result: unknown) =>
      this.#toServer({ jsonrpc: '2.0', id, result });
    switch (method) {
      case 'workspace/configuration': {
        const items = Array.isArray(p.items) ? p.items : [];
        answer(items.map((item) => {
          const section = isObject(item) ? item.section : undefined;
          return typeof section === 'string' && section !== ''
            ? settingAt(this.#settings, section)
            : this.#settings;
        }));
        return;
      }
      case 'client/registerCapability': {
        let changed = false;
        for (const r of Array.isArray(p.registrations) ? p.registrations : []) {
          if (!isObject(r) || r.method !== 'workspace/didChangeWatchedFiles') {
            continue;
          }
          const opts = isObject(r.registerOptions) ? r.registerOptions : {};
          const watchers = Array.isArray(opts.watchers)
            ? opts.watchers.filter(isObject) as FileWatcher[]
            : [];
          this.#watchers.set(String(r.id), watchers);
          changed = true;
        }
        answer(null);
        if (changed) {
          this.#opts.onWatchers?.([...this.#watchers.values()].flat());
        }
        return;
      }
      case 'client/unregisterCapability': {
        let changed = false;
        // The protocol's own spelling.
        const list = Array.isArray(p.unregisterations)
          ? p.unregisterations
          : Array.isArray(p.unregistrations)
          ? p.unregistrations
          : [];
        for (const u of list) {
          if (isObject(u) && this.#watchers.delete(String(u.id))) {
            changed = true;
          }
        }
        answer(null);
        if (changed) {
          this.#opts.onWatchers?.([...this.#watchers.values()].flat());
        }
        return;
      }
      case 'window/workDoneProgress/create':
      case 'window/showMessageRequest':
        answer(null);
        return;
      case 'workspace/workspaceFolders':
        answer([{ uri: this.rootUri, name: baseName(this.root) }]);
        return;
      case 'workspace/applyEdit':
        answer({ applied: false });
        return;
      case 'workspace/diagnostic/refresh':
        answer(null);
        for (const uri of this.#docs.keys()) this.#pull(uri);
        return;
      default:
        this.#toServer({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
    }
  }

  #serverNotification(method: string, params: unknown) {
    const p = isObject(params) ? params : {};
    switch (method) {
      case 'textDocument/publishDiagnostics': {
        if (typeof p.uri !== 'string') return;
        // A report for a version since changed is stale: the host's versions are the server's.
        const doc = this.#docs.get(p.uri);
        if (doc && typeof p.version === 'number' && p.version !== doc.version) {
          return;
        }
        const diagnostics = Array.isArray(p.diagnostics) ? p.diagnostics : [];
        this.#diagnostics.set(p.uri, diagnostics);
        this.#sendDiagnostics(p.uri, diagnostics);
        return;
      }
      case '$/progress':
        this.#onProgress(p);
        return;
      case 'language/status':
        if (this.#state === 'starting' && typeof p.message === 'string') {
          this.#setStatus('starting', p.message);
        }
        return;
      case 'window/showMessage':
        if (p.type === 1 && typeof p.message === 'string') {
          this.#setStatus(this.#state, p.message);
        }
        return;
      default:
        return; // logMessage, telemetry, the rest
    }
  }

  #onProgress(p: Msg) {
    const token = p.token as Id;
    if (typeof token !== 'string' && typeof token !== 'number') return;
    const v = isObject(p.value) ? p.value : {};
    if (v.kind === 'begin' || v.kind === 'report') {
      const known = this.#progress.get(token);
      const title = v.kind === 'begin'
        ? (typeof v.title === 'string' ? v.title : undefined)
        : known?.title;
      const text = progressText({
        title,
        message: typeof v.message === 'string' ? v.message : undefined,
        percentage: typeof v.percentage === 'number' ? v.percentage : undefined,
      });
      this.#progress.set(token, { text, title, seq: ++this.#progressSeq });
      if (this.#state !== 'exited') this.#setStatus(this.#state, text);
      return;
    }
    if (v.kind === 'end') {
      if (!this.#progress.delete(token)) return;
      if (this.#state !== 'exited') {
        this.#setStatus(this.#state, this.#progressDetail());
      }
    }
  }

  /** The most recent progress still in flight, else (while ready) the notice. */
  #progressDetail(): string {
    let latest: { text: string; seq: number } | null = null;
    for (const p of this.#progress.values()) {
      if (!latest || p.seq > latest.seq) latest = p;
    }
    if (latest) return latest.text;
    return this.#state === 'ready' || this.#initResult ? this.#notice : '';
  }

  // -------------------------------------------------------------------------------------------
  // Pull diagnostics
  // -------------------------------------------------------------------------------------------

  #pulls(): boolean {
    const caps = this.#initResult?.capabilities as Msg | undefined;
    return Boolean(caps?.diagnosticProvider);
  }

  #schedulePull(uri: string) {
    if (!this.#pulls() || !this.#docs.get(uri)?.openers.size) return;
    const t = this.#pullTimers.get(uri);
    if (t !== undefined) this.#clock.clearTimeout(t);
    this.#pullTimers.set(
      uri,
      this.#clock.setTimeout(() => {
        this.#pullTimers.delete(uri);
        this.#pull(uri);
      }, PULL_DEBOUNCE_MS),
    );
  }

  #pull(uri: string) {
    const doc = this.#docs.get(uri);
    // A document only views hold is never pulled: its diagnostics go nowhere.
    if (!this.#pulls() || !doc || doc.openers.size === 0) return;
    const version = doc.version;
    const previousResultId = this.#resultIds.get(uri);
    this.#hostRequest('textDocument/diagnostic', {
      textDocument: { uri },
      ...(previousResultId !== undefined ? { previousResultId } : {}),
    }, (reply) => {
      // A failed pull is ignored; so is one for a version since changed (its pull is coming),
      // whose positions may be past the end of the page's document.
      if (this.#docs.get(uri) !== doc || doc.version !== version) return;
      if (!isObject(reply.result)) return;
      const r = reply.result;
      if (typeof r.resultId === 'string') this.#resultIds.set(uri, r.resultId);
      if (r.kind === 'unchanged') {
        const stored = this.#diagnostics.get(uri);
        if (stored) this.#sendDiagnostics(uri, stored);
        return;
      }
      const items = Array.isArray(r.items) ? r.items : [];
      this.#diagnostics.set(uri, items);
      this.#sendDiagnostics(uri, items);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------------------------

  /**
   * `publishDiagnostics` for `uri`, to `to` or every connection with it open. No `version`: the
   * host's numbers are not the page's, and lsp-client drops a report whose version isn't its own.
   */
  #sendDiagnostics(uri: string, diagnostics: unknown[], to?: Peer[]) {
    const msg = {
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics },
    };
    for (const peer of to ?? this.#docs.get(uri)?.openers ?? []) {
      this.#toPeer(peer, msg);
    }
  }

  /** Sends a request of the host's own; `onReply` gets the answer. Null when there's no server. */
  #hostRequest(
    method: string,
    params: unknown,
    onReply: (reply: Msg) => void,
  ): Id | null {
    if (!this.#port) return null;
    const id = ++this.#nextId;
    this.#own.set(id, onReply);
    this.#toServer({ jsonrpc: '2.0', id, method, params });
    return id;
  }

  #toServer(msg: Msg) {
    try {
      this.#port?.send(msg);
    } catch { /* the process is gone: its exit says so */ }
  }

  #toPeer(peer: Peer, message: Msg) {
    peer.send(JSON.stringify({ type: 'lsp', session: this.id, message }));
  }

  #setStatus(state: LspState, detail: string) {
    this.#state = state;
    this.#detail = detail;
    for (const peer of this.#peers.keys()) this.sendStatus(peer);
  }

  /** Sends `peer` the session's `lsp_status`, unless it was the last one it got. */
  sendStatus(peer: Peer): void {
    const msg = JSON.stringify({
      type: 'lsp_status',
      session: this.id,
      state: this.#state,
      ...(this.#detail !== '' ? { detail: this.#detail } : {}),
    });
    if (this.#sentStatus.get(peer) === msg) return;
    this.#sentStatus.set(peer, msg);
    peer.send(msg);
  }
}
