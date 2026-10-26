// The page's language server sessions (`devc web`'s editor intelligence): which file tiles are
// attached to which host session (`lsp_attach`), one `@codemirror/lsp-client` client per session
// (`viewer.js`'s `createLanguageClient`) over a transport on the page's socket (`lsp_send` out,
// `lsp` in), each session's `lsp_status`, and the client's jumps to other files (`displayFile`),
// which open file tiles. `tiles.js` decides when a tile wants a server and shows the status line;
// this module keeps the rest. See `.plans/devc-web-lsp-core.md` § Browser side. Diff tiles use the
// same sessions for hover and go to definition through **views** (`devc/openView`: the file opened
// with the PR head's text), never an editor; see `.plans/devc-web-lsp-diff-hover.md`.

import { createLanguageClient } from './viewer.js';
import { LSP_LANGUAGE_NAMES, lspLanguageFor } from './lib/languages.js';
import { childPath } from './lib/files.js';
import { call, onServerMessage, send } from './client.js';

/** @typedef {import('./lib/layout_state.js').FileRef} FileRef */
/** @typedef {import('./viewer.js').Viewer} Viewer */

/**
 * A file tile that wants a language server: its file, its container, its viewer, and what its
 * attach gave. `error` is a failed attach's status-line text (`describe_failed`,
 * `start_failed`); `attached`, whether its viewer has the session's features (a second tile on
 * the same file on this page stays a plain editor).
 *
 * @typedef {object} LspTile
 * @property {string} key       the tile's id
 * @property {FileRef} file
 * @property {string} container the container's id
 * @property {Viewer} viewer
 * @property {string | null} session
 * @property {string} uri
 * @property {string} languageId
 * @property {boolean} attached
 * @property {string} error
 * @property {number} seq       numbers the attaches, so only the latest one's answer lands
 */

/**
 * One session as this page holds it: its client and transport, its state, and the tiles on it.
 *
 * @typedef {object} LspRecord
 * @property {string} session
 * @property {string} container
 * @property {string} localFolder
 * @property {string} language  `java`, `typescript` or `python`
 * @property {string} server    `describe`'s name and version
 * @property {string} root      `describe`'s root: the server's workspace folder, a container path
 * @property {ReturnType<typeof createLanguageClient>} lc
 * @property {Set<(message: string) => void>} subscribers
 * @property {'starting' | 'ready' | 'exited'} state
 * @property {string} detail
 * @property {Set<string>} keys the tiles on it
 */

/** @type {Map<string, LspTile>} by tile id */
const tiles = new Map();
/**
 * A diff tile on a session: its file, what its attach gave, and the text the host holds for its
 * view (`opened`, null until `devc/openView` succeeded, and again after a restart or a
 * `devc/viewStale`). Its key is in its record's `keys`, like a tile's.
 *
 * @typedef {object} LspView
 * @property {string} key
 * @property {FileRef} file
 * @property {string} container
 * @property {string | null} session
 * @property {string} uri
 * @property {string} languageId
 * @property {string | null} opened
 * @property {Promise<{ok: boolean, error: string}> | null} attaching
 */
/** @type {Map<string, LspView>} by diff tile id */
const views = new Map();
/** @type {Map<string, LspRecord>} by session id */
const records = new Map();
/** `displayFile`'s waits for a tile on a URI to attach. @type {Map<string, Set<(v: any) => void>>} */
const waiters = new Map();
/** Other URI schemes' `displayFile`s. @type {Map<string, (uri: string) => Promise<any>>} */
const schemes = new Map();

/** How long `displayFile` waits for the opened tile's viewer to attach. */
const DISPLAY_WAIT_MS = 10_000;

/**
 * What the tiling area does for this module: open a file in a tile (as a click in the tree
 * does), and redraw a tile's status line and menu after a change.
 */
let hooks = {
  /** @param {FileRef} _file */
  openFile: (_file) => {},
  /** @param {string} _key */
  changed: (_key) => {},
};

/** @param {typeof hooks} h */
export function setLspHooks(h) {
  hooks = h;
}

/**
 * Registers what `displayFile` does for URIs of `scheme` (without the colon): `fn(uri)` resolves
 * with an `EditorView` showing it, or null. A language plan adds these (`jdt:`, say).
 *
 * @param {string} scheme @param {(uri: string) => Promise<any>} fn
 */
export function registerUriScheme(scheme, fn) {
  schemes.set(scheme, fn);
}

// ---------------------------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------------------------

/**
 * Attaches a file tile to its file's language server: `lsp_attach`, then a client for a new
 * session, then the viewer. Again for a tile already attached: nothing, unless `fresh` (the tile
 * has just become editable again: its container came back), which attaches it anew.
 *
 * @param {string} key @param {FileRef} file @param {{id: string, localFolder: string}} container
 * @param {Viewer} viewer @param {boolean} [fresh]
 */
export function attachTile(key, file, container, viewer, fresh = false) {
  const known = tiles.get(key);
  if (known && !fresh && known.viewer === viewer && known.file === file) {
    return;
  }
  if (known) detachTile(key);
  /** @type {LspTile} */
  const t = {
    key,
    file,
    container: container.id,
    viewer,
    session: null,
    uri: '',
    languageId: '',
    attached: false,
    error: '',
    seq: 0,
  };
  tiles.set(key, t);
  void attach(t, container.localFolder);
}

/** Detaches a tile: its viewer loses the features, and its session goes when no tile is on it. */
export function detachTile(/** @type {string} */ key) {
  const t = tiles.get(key);
  if (!t) return;
  tiles.delete(key);
  t.seq++;
  t.viewer.detachLanguage();
  release(t);
  hooks.changed(key);
}

/** Whether tile `key` is attached (or asking to be). */
export function tileAttached(/** @type {string} */ key) {
  return tiles.has(key);
}

/** Whether tile `key`'s session has exited: its status line says so until it is restarted. */
export function tileExited(/** @type {string} */ key) {
  const t = tiles.get(key);
  return Boolean(t?.session && records.get(t.session)?.state === 'exited');
}

/**
 * A tile's status line: `<Language>: starting…`, `<Language>: <detail>`, `<Language> language
 * server stopped: <detail>`, a failed attach's message, or '' (hidden). With a `title`, what it
 * names (the server and its root).
 *
 * @param {string} key @returns {{text: string, title: string}}
 */
export function tileStatus(key) {
  const t = tiles.get(key);
  const none = { text: '', title: '' };
  if (!t) return none;
  const name = languageName(t.file.path);
  if (t.error) return { text: t.error, title: '' };
  const r = t.session ? records.get(t.session) : undefined;
  if (!r) return none;
  const title = [r.server, r.root].filter(Boolean).join(' — ');
  if (r.state === 'exited') {
    return {
      text: `${name} language server stopped${r.detail ? `: ${r.detail}` : ''}`,
      title,
    };
  }
  if (!t.attached) return none;
  if (r.state === 'starting') {
    return {
      text: r.detail ? `${name}: ${r.detail}` : `${name}: starting…`,
      title,
    };
  }
  return { text: r.detail ? `${name}: ${r.detail}` : '', title };
}

/**
 * Whether tile `key`'s menu offers **Restart language server**: while it is attached, or its
 * session has exited.
 */
export function tileRestartable(/** @type {string} */ key) {
  const t = tiles.get(key);
  const r = t?.session ? records.get(t.session) : undefined;
  return Boolean(t && r && (t.attached || r.state === 'exited'));
}

/** **Restart language server**: `lsp_restart` for tile `key`'s session. */
export async function restartTile(/** @type {string} */ key) {
  const t = tiles.get(key);
  if (!t?.session) return;
  await call({ type: 'lsp_restart', session: t.session });
}

/** The language name a path's server goes by in the status line: `TypeScript`. */
function languageName(/** @type {string} */ path) {
  const l = lspLanguageFor(path);
  return l ? LSP_LANGUAGE_NAMES[l] : 'Language';
}

/**
 * `lsp_attach` for a tile, then its client (a new session's) and its viewer.
 *
 * @param {LspTile} t @param {string} localFolder
 */
async function attach(t, localFolder) {
  const seq = ++t.seq;
  t.error = '';
  const file = t.file;
  let result;
  try {
    result = await call({
      type: 'lsp_attach',
      container: t.container,
      ...(file.container
        ? { path: childPath('/', file.path) }
        : { root: file.root, path: file.path }),
    });
  } catch (e) {
    if (tiles.get(t.key) !== t || seq !== t.seq) return;
    // A file no server takes, or a container with no launcher: a plain editor, nothing shown.
    const quiet = ['unsupported', 'no_language_server', 'not_connected'];
    t.error = quiet.includes(e?.code) ? '' : String(e?.message ?? e);
    hooks.changed(t.key);
    return;
  }
  const session = String(result?.session ?? '');
  let r = records.get(session);
  if (!r) {
    r = newRecord(session, t.container, localFolder, file.path, result);
    records.set(session, r);
  } else {
    r.state = result.state;
    r.detail = typeof result.detail === 'string' ? result.detail : '';
  }
  r.keys.add(t.key);
  if (tiles.get(t.key) !== t || seq !== t.seq) {
    // Detached meanwhile: this attach is let go again.
    r.keys.delete(t.key);
    if (r.keys.size === 0) dropRecord(r);
    return;
  }
  t.session = session;
  t.uri = String(result.uri ?? '');
  t.languageId = String(result.languageId ?? '');
  bindViewer(t, r);
  hooks.changed(t.key);
}

/** Gives a tile's viewer its session's features, unless its session has exited. */
function bindViewer(/** @type {LspTile} */ t, /** @type {LspRecord} */ r) {
  t.attached = r.state !== 'exited' &&
    r.lc.attach(t.viewer, t.uri, t.languageId);
  if (!t.attached) return;
  const waiting = waiters.get(t.uri);
  if (waiting) {
    waiters.delete(t.uri);
    for (const resolve of waiting) resolve(t.viewer.view);
  }
}

/**
 * A new session's record: its transport (`lsp_send` out; `lsp` messages in, through
 * {@link onLspMessage}) and its client, connected.
 */
function newRecord(session, container, localFolder, path, result) {
  /** @type {Set<(message: string) => void>} */
  const subscribers = new Set();
  const transport = {
    /** @param {string} message */
    send: (message) =>
      send({ type: 'lsp_send', session, message: JSON.parse(message) }),
    /** @param {(message: string) => void} fn */
    subscribe: (fn) => subscribers.add(fn),
    /** @param {(message: string) => void} fn */
    unsubscribe: (fn) => subscribers.delete(fn),
  };
  /** @type {LspRecord & {transport: typeof transport}} */
  const r = {
    session,
    container,
    localFolder,
    language: lspLanguageFor(path) ?? '',
    server: typeof result.server === 'string' ? result.server : '',
    root: typeof result.root === 'string' ? result.root : '',
    subscribers,
    transport,
    state: result.state ?? 'starting',
    detail: typeof result.detail === 'string' ? result.detail : '',
    keys: new Set(),
    lc: /** @type {any} */ (null),
  };
  r.lc = createLanguageClient(transport, {
    displayFile: (uri) => displayFile(r, uri),
  });
  return r;
}

/** A tile stops using its session: the session is let go once no tile is on it. */
function release(/** @type {LspTile} */ t) {
  const r = t.session ? records.get(t.session) : undefined;
  t.session = null;
  t.attached = false;
  if (!r) return;
  r.keys.delete(t.key);
  if (r.keys.size === 0) dropRecord(r);
}

/** Lets a session go: `lsp_detach`, and its client disconnected. */
function dropRecord(/** @type {LspRecord} */ r) {
  records.delete(r.session);
  send({ type: 'lsp_detach', session: r.session });
  r.lc.client.disconnect();
}

// ---------------------------------------------------------------------------------------------
// Diff tiles' views
// ---------------------------------------------------------------------------------------------

/**
 * Puts diff tile `key` on its file's session (`lsp_attach`, as a file tile of the file would),
 * once: a repeat while attached, or while attaching, resolves as that one did. `error` is '' for
 * a file no server takes, a container with no launcher or not connected (nothing is shown), else
 * the failed attach's message.
 *
 * @param {string} key @param {FileRef} file @param {{id: string, localFolder: string}} container
 * @returns {Promise<{ok: boolean, error: string}>}
 */
export function attachView(key, file, container) {
  let v = views.get(key);
  if (v && v.session && records.has(v.session)) {
    return Promise.resolve({ ok: true, error: '' });
  }
  if (v?.attaching) return v.attaching;
  if (!v) {
    v = {
      key,
      file,
      container: container.id,
      session: null,
      uri: '',
      languageId: '',
      opened: null,
      attaching: null,
    };
    views.set(key, v);
  }
  const view = v;
  view.attaching = (async () => {
    let result;
    try {
      result = await call({
        type: 'lsp_attach',
        container: view.container,
        root: file.root,
        path: file.path,
      });
    } catch (e) {
      const quiet = ['unsupported', 'no_language_server', 'not_connected'];
      return {
        ok: false,
        error: quiet.includes(e?.code) ? '' : String(e?.message ?? e),
      };
    } finally {
      view.attaching = null;
    }
    if (views.get(key) !== view) return { ok: false, error: '' };
    const session = String(result?.session ?? '');
    let r = records.get(session);
    if (!r) {
      r = newRecord(
        session,
        view.container,
        container.localFolder,
        file.path,
        result,
      );
      records.set(session, r);
    } else {
      r.state = result.state;
      r.detail = typeof result.detail === 'string' ? result.detail : '';
    }
    r.keys.add(key);
    view.session = session;
    view.uri = String(result.uri ?? '');
    view.languageId = String(result.languageId ?? '');
    return { ok: true, error: '' };
  })();
  return view.attaching;
}

/**
 * Diff tile `key`'s session as its hover shows it: the language's name, and the session's state
 * and detail. Null when it isn't on one.
 *
 * @param {string} key
 * @returns {{name: string, state: 'starting' | 'ready' | 'exited', detail: string} | null}
 */
export function viewStatus(key) {
  const v = views.get(key);
  const r = v?.session ? records.get(v.session) : undefined;
  if (!v || !r) return null;
  return { name: languageName(v.file.path), state: r.state, detail: r.detail };
}

/**
 * Makes sure the host holds `text` (the PR head's) for diff tile `key`'s view: `devc/openView`,
 * unless it already does. `{ok: false, reason: 'edited', text}` while an editor holds other text:
 * `text` is the editor's, which requests then work against.
 *
 * @param {string} key @param {string} text
 * @returns {Promise<{ok: boolean, reason?: string, text?: string}>}
 */
export async function openView(key, text) {
  const v = views.get(key);
  const r = v?.session ? records.get(v.session) : undefined;
  if (!v || !r) return { ok: false, reason: 'detached' };
  if (v.opened === text) return { ok: true };
  const session = v.session;
  /** @type {any} */
  const answer = await r.lc.client.request('devc/openView', {
    textDocument: { uri: v.uri, languageId: v.languageId, text },
  });
  if (views.get(key) !== v || v.session !== session) {
    return { ok: false, reason: 'detached' };
  }
  if (answer?.ok === true) {
    v.opened = text;
    return { ok: true };
  }
  return {
    ok: false,
    reason: String(answer?.reason ?? 'refused'),
    ...(typeof answer?.text === 'string' ? { text: answer.text } : {}),
  };
}

/**
 * A request about diff tile `key`'s view at `position` (`textDocument/hover`,
 * `textDocument/definition`): its result.
 *
 * @param {string} key @param {string} method @param {{line: number, character: number}} position
 */
export function viewRequest(key, method, position) {
  const v = views.get(key);
  const r = v?.session ? records.get(v.session) : undefined;
  if (!v || !r) return Promise.resolve(null);
  return r.lc.client.request(method, {
    textDocument: { uri: v.uri },
    position,
  });
}

/**
 * Opens a definition found from diff tile `key` the way a file tile's F12 does: its file in a
 * tile, the cursor at `location.range.start`.
 *
 * @param {string} key @param {{uri: string, range: {start: {line: number, character: number}}}} location
 */
export async function showViewLocation(key, location) {
  const v = views.get(key);
  const r = v?.session ? records.get(v.session) : undefined;
  if (!v || !r) return;
  const ev = /** @type {any} */ (await displayFile(r, location.uri));
  if (!ev) return;
  const doc = ev.state.doc;
  const start = location.range?.start ?? { line: 0, character: 0 };
  const line = doc.line(Math.min(Math.max(start.line + 1, 1), doc.lines));
  const anchor = Math.min(line.from + Math.max(start.character, 0), line.to);
  ev.dispatch({ selection: { anchor }, scrollIntoView: true });
  ev.focus();
}

/** Diff tile `key` lets its session go: `devc/closeView` if its view is open. */
export function detachView(/** @type {string} */ key) {
  const v = views.get(key);
  if (!v) return;
  views.delete(key);
  releaseView(v);
}

/**
 * A view stops using its session. The last user's `lsp_detach` closes its view on the host, so
 * `devc/closeView` is only sent while the record stays (the client's queued send would otherwise
 * find it disconnected).
 */
function releaseView(/** @type {LspView} */ v) {
  const r = v.session ? records.get(v.session) : undefined;
  const opened = v.opened !== null;
  v.session = null;
  v.opened = null;
  if (!r) return;
  r.keys.delete(v.key);
  if (r.keys.size === 0) dropRecord(r);
  else if (opened) {
    r.lc.client.notification('devc/closeView', {
      textDocument: { uri: v.uri },
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Server messages
// ---------------------------------------------------------------------------------------------

/** One `lsp` message: to its session's client. */
function onLspMessage(msg) {
  const r = records.get(msg.session);
  if (!r || typeof msg.message !== 'object' || msg.message === null) return;
  if (msg.message.method === 'devc/viewStale') {
    const uri = msg.message.params?.textDocument?.uri;
    for (const v of views.values()) {
      if (v.session === msg.session && v.uri === uri) v.opened = null;
    }
    return;
  }
  const text = JSON.stringify(msg.message);
  for (const fn of [...r.subscribers]) fn(text);
}

/**
 * One `lsp_status`. `exited` takes the features from its tiles' viewers (a `settings changed`
 * one attaches them again, to a session built from the new settings); `starting` after `ready`
 * or `exited` (a restart) reconnects the client, which initializes again and re-opens its files.
 */
function onLspStatus(msg) {
  const r = records.get(msg.session);
  if (!r) return;
  const prev = r.state;
  r.state = msg.state;
  r.detail = typeof msg.detail === 'string' ? msg.detail : '';
  const keys = [...r.keys];
  if (r.state === 'exited' || (r.state === 'starting' && prev !== 'starting')) {
    // The server's documents are gone: views open again on their next use.
    for (const key of keys) {
      const v = views.get(key);
      if (v) v.opened = null;
    }
  }
  if (r.state === 'exited' && r.detail === 'settings changed') {
    for (const key of keys) {
      const v = views.get(key);
      if (v) releaseView(v);
    }
  }
  if (r.state === 'exited') {
    for (const key of keys) {
      const t = tiles.get(key);
      if (!t) continue;
      t.viewer.detachLanguage();
      t.attached = false;
    }
    if (r.detail === 'settings changed') {
      for (const key of keys) {
        const t = tiles.get(key);
        if (!t) continue;
        release(t);
        void attach(t, r.localFolder);
      }
    }
  } else if (r.state === 'starting' && prev !== 'starting') {
    r.lc.client.disconnect();
    r.lc.client.connect(/** @type {any} */ (r).transport);
    for (const key of keys) {
      const t = tiles.get(key);
      if (t && !t.attached) bindViewer(t, r);
    }
  }
  for (const key of keys) hooks.changed(key);
}

/**
 * A (re)connect: the server let this connection's sessions go when the old one closed, so every
 * tile attaches again. Sessions outlive a reload for their idle window, so they are usually the
 * same ones.
 */
function onHello() {
  for (const r of records.values()) r.lc.client.disconnect();
  records.clear();
  for (const v of views.values()) {
    v.session = null;
    v.opened = null;
    v.attaching = null;
  }
  for (const t of tiles.values()) {
    t.viewer.detachLanguage();
    t.session = null;
    t.attached = false;
    void attach(t, t.file.localFolder);
  }
}

onServerMessage((msg) => {
  if (msg.type === 'lsp') onLspMessage(msg);
  else if (msg.type === 'lsp_status') onLspStatus(msg);
  else if (msg.type === 'hello' && (tiles.size > 0 || views.size > 0)) {
    onHello();
  }
});

// ---------------------------------------------------------------------------------------------
// The client's jumps
// ---------------------------------------------------------------------------------------------

/** A `file:` URI's path, decoded; null for another scheme. */
function uriPath(/** @type {string} */ uri) {
  if (!uri.startsWith('file://')) return null;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return null;
  }
}

/**
 * Puts the file at `uri` in front of the user and resolves with its `EditorView` once its tile's
 * viewer has attached (null after {@link DISPLAY_WAIT_MS}, or when it can't be opened). A `file:`
 * URI is a repo file when `locate_file` finds it in one of the container's repos, else a
 * container file; other schemes go to {@link registerUriScheme}'s hooks.
 *
 * @param {LspRecord} r @param {string} uri
 */
async function displayFile(r, uri) {
  const path = uriPath(uri);
  if (path === null) {
    const scheme = uri.slice(0, Math.max(uri.indexOf(':'), 0));
    const fn = schemes.get(scheme);
    return fn ? fn(uri) : null;
  }
  for (const t of tiles.values()) {
    if (t.uri === uri && t.attached) {
      hooks.openFile(t.file);
      return t.viewer.view;
    }
  }
  /** @type {FileRef} */
  let file;
  try {
    const found = await call({
      type: 'locate_file',
      container: r.container,
      path,
    });
    file = {
      localFolder: found.localFolder,
      root: found.root,
      path: found.path,
    };
  } catch (e) {
    if (e?.code !== 'forbidden' && e?.code !== 'not_mounted') return null;
    file = {
      localFolder: r.localFolder,
      root: '/',
      path: path.slice(1),
      container: true,
    };
  }
  const shown = new Promise((resolve) => {
    let set = waiters.get(uri);
    if (!set) waiters.set(uri, set = new Set());
    set.add(resolve);
    setTimeout(() => {
      if (set.delete(resolve)) resolve(null);
      if (set.size === 0 && waiters.get(uri) === set) waiters.delete(uri);
    }, DISPLAY_WAIT_MS);
  });
  hooks.openFile(file);
  return shown;
}
