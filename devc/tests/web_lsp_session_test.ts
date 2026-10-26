import { assert, assertEquals } from 'jsr:@std/assert';
import {
  asLocations,
  type Clock,
  deepMerge,
  fileUri,
  LSP_IDLE_MS,
  lspIdleMs,
  LspSession,
  type Peer,
  PULL_DEBOUNCE_MS,
  type ServerPort,
  settingAt,
} from '../web/lsp_session.ts';

type Msg = Record<string, unknown>;

/** A clock whose timers run when the test advances it. */
class FakeClock implements Clock {
  now = 0;
  #next = 1;
  #timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): number {
    const h = this.#next++;
    this.#timers.set(h, { at: this.now + ms, fn });
    return h;
  }
  clearTimeout(h: unknown) {
    this.#timers.delete(h as number);
  }
  advance(ms: number) {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = until;
  }
}

/** The server end: what the session sent, and a way to answer. */
class FakePort implements ServerPort {
  sent: Msg[] = [];
  #onMessage: (m: Msg) => void = () => {};
  #onExit: (r: string) => void = () => {};
  send(msg: Msg) {
    this.sent.push(msg);
  }
  onMessage(fn: (m: Msg) => void) {
    this.#onMessage = fn;
  }
  onExit(fn: (r: string) => void) {
    this.#onExit = fn;
  }
  emit(msg: Msg) {
    this.#onMessage({ jsonrpc: '2.0', ...msg });
  }
  exit(reason: string) {
    this.#onExit(reason);
  }
  take(): Msg[] {
    const out = this.sent;
    this.sent = [];
    return out;
  }
  last(): Msg {
    return this.sent[this.sent.length - 1];
  }
}

/** A browser connection: the `lsp` messages' payloads and the statuses it got. */
class FakePeer implements Peer {
  lsp: Msg[] = [];
  status: Msg[] = [];
  send(text: string) {
    const m = JSON.parse(text);
    if (m.type === 'lsp') this.lsp.push(m.message);
    else this.status.push(m);
  }
  take(): Msg[] {
    const out = this.lsp;
    this.lsp = [];
    return out;
  }
}

const ROOT = '/workspaces/my repo';
const URI = 'file:///workspaces/my%20repo/a.ts';

function setup(opts: {
  settings?: Record<string, unknown>;
  idleMs?: number;
} = {}) {
  const clock = new FakeClock();
  const port = new FakePort();
  const events = {
    idle: 0,
    watchers: [] as unknown[][],
    exited: [] as string[],
  };
  const session = new LspSession({
    id: 's1',
    root: ROOT,
    initializationOptions: { enable: true },
    settings: opts.settings ?? { deno: { enable: true, lint: false } },
    idleMs: opts.idleMs ?? LSP_IDLE_MS,
    clock,
    onIdle: () => events.idle++,
    onWatchers: (w) => events.watchers.push(w),
    onExited: (r) => events.exited.push(r),
  });
  session.connect(port);
  return { clock, port, session, events };
}

const PAGE_CAPS = {
  textDocument: { hover: { contentFormat: ['markdown'] }, diagnostic: {} },
  general: { markdown: { parser: 'marked' } },
};

/** Attaches `peer`, sends its `initialize` (id `pageId`), and answers it when it's the first. */
function init(
  t: ReturnType<typeof setup>,
  peer: FakePeer,
  pageId: number | string = 1,
  serverCaps: Msg = { textDocumentSync: 2, hoverProvider: true },
) {
  t.session.attach(peer);
  t.session.fromPeer(peer, {
    jsonrpc: '2.0',
    id: pageId,
    method: 'initialize',
    params: { processId: null, capabilities: PAGE_CAPS, rootUri: null },
  });
  const req = t.port.sent.find((m) => m.method === 'initialize');
  if (req && t.session.state === 'starting') {
    t.port.emit({
      id: req.id,
      result: { capabilities: serverCaps, serverInfo: { name: 'x' } },
    });
  }
}

function open(
  t: ReturnType<typeof setup>,
  peer: FakePeer,
  text: string,
  uri = URI,
) {
  t.session.fromPeer(peer, {
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: {
      textDocument: { uri, languageId: 'typescript', version: 0, text },
    },
  });
}

Deno.test('lspIdleMs: 30 minutes, or DEVC_WEB_LSP_IDLE_MS when it is a whole number', () => {
  const env = (v?: string) => ({ get: () => v });
  assertEquals(lspIdleMs(env()), 30 * 60 * 1000);
  assertEquals(lspIdleMs(env('10000')), 10000);
  assertEquals(lspIdleMs(env('soon')), LSP_IDLE_MS);
  assertEquals(lspIdleMs(env('-5')), LSP_IDLE_MS);
});

Deno.test('helpers: deepMerge, settingAt, fileUri', () => {
  assertEquals(
    deepMerge({ a: { b: 1, c: [1] }, d: 1 }, { a: { c: [2], e: 3 } }),
    { a: { b: 1, c: [2], e: 3 }, d: 1 },
  );
  assertEquals(settingAt({ a: { b: { c: 1 } } }, 'a.b'), { c: 1 });
  assertEquals(settingAt({ a: { b: 1 } }, 'a.x'), null);
  assertEquals(fileUri('/w/my repo/é#.ts'), 'file:///w/my%20repo/%C3%A9%23.ts');
});

Deno.test('initialize: the host sends its own, then caches the result with textDocumentSync rewritten', () => {
  const t = setup();
  const peer = new FakePeer();
  t.session.attach(peer);
  assertEquals(t.session.state, 'starting');
  assertEquals(t.port.sent, [], 'nothing is sent before a page initializes');
  t.session.fromPeer(peer, {
    jsonrpc: '2.0',
    id: 7,
    method: 'initialize',
    params: { processId: 42, capabilities: PAGE_CAPS, rootUri: null },
  });
  const [req] = t.port.take();
  assertEquals(req.method, 'initialize');
  const params = req.params as Msg;
  assertEquals(params.processId, null);
  assertEquals(params.rootUri, 'file:///workspaces/my%20repo');
  assertEquals(params.rootPath, ROOT);
  assertEquals(params.workspaceFolders, [{
    uri: 'file:///workspaces/my%20repo',
    name: 'my repo',
  }]);
  assertEquals(params.initializationOptions, { enable: true });
  assertEquals(params.clientInfo, { name: 'devc web' });
  assertEquals(params.capabilities, {
    textDocument: {
      hover: { contentFormat: ['markdown'] },
      diagnostic: { dynamicRegistration: false },
    },
    general: { markdown: { parser: 'marked' } },
    workspace: {
      configuration: true,
      workspaceFolders: true,
      didChangeWatchedFiles: { dynamicRegistration: true },
      diagnostics: { refreshSupport: true },
    },
    window: { workDoneProgress: true },
  });
  assertEquals(peer.lsp, [], 'the page waits for the result');
  t.port.emit({
    id: req.id,
    result: {
      capabilities: { textDocumentSync: 2, hoverProvider: true },
      serverInfo: { name: 'x' },
    },
  });
  assertEquals(t.port.take(), [
    { jsonrpc: '2.0', method: 'initialized', params: {} },
    {
      jsonrpc: '2.0',
      method: 'workspace/didChangeConfiguration',
      params: { settings: { deno: { enable: true, lint: false } } },
    },
  ]);
  assertEquals(t.session.state, 'ready');
  assertEquals(peer.take(), [{
    jsonrpc: '2.0',
    id: 7,
    result: {
      capabilities: {
        textDocumentSync: { openClose: true, change: 1 },
        hoverProvider: true,
      },
      serverInfo: { name: 'x' },
    },
  }]);
  assertEquals(peer.status.map((s) => s.state), ['ready']);
});

Deno.test("initialize: a second page's initialize is not forwarded; it gets the cached result", () => {
  const t = setup();
  const a = new FakePeer();
  const b = new FakePeer();
  init(t, a);
  t.port.take();
  a.take();
  t.session.attach(b);
  t.session.fromPeer(b, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {},
  });
  t.session.fromPeer(b, { jsonrpc: '2.0', method: 'initialized', params: {} });
  assertEquals(t.port.take(), []);
  const [reply] = b.take();
  assertEquals(reply.id, 1);
  assertEquals(
    ((reply.result as Msg).capabilities as Msg).textDocumentSync,
    { openClose: true, change: 1 },
  );
  // A page's shutdown is answered by the host, exit dropped.
  t.session.fromPeer(b, { jsonrpc: '2.0', id: 2, method: 'shutdown' });
  t.session.fromPeer(b, { jsonrpc: '2.0', method: 'exit' });
  assertEquals(t.port.take(), []);
  assertEquals(b.take(), [{ jsonrpc: '2.0', id: 2, result: null }]);
});

Deno.test('initialize: two pages before the result share the one server initialize', () => {
  const t = setup();
  const a = new FakePeer();
  const b = new FakePeer();
  t.session.attach(a);
  t.session.attach(b);
  t.session.fromPeer(a, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {},
  });
  t.session.fromPeer(b, {
    jsonrpc: '2.0',
    id: 9,
    method: 'initialize',
    params: {},
  });
  const reqs = t.port.take();
  assertEquals(reqs.filter((m) => m.method === 'initialize').length, 1);
  t.port.emit({ id: reqs[0].id, result: { capabilities: {} } });
  assertEquals(a.take().map((m) => m.id), [1]);
  assertEquals(b.take().map((m) => m.id), [9]);
});

Deno.test('requests: ids remapped across two connections with colliding ids', () => {
  const t = setup();
  const a = new FakePeer();
  const b = new FakePeer();
  init(t, a);
  init(t, b);
  t.port.take();
  a.take();
  b.take();
  const hover = (id: number) => ({
    jsonrpc: '2.0',
    id,
    method: 'textDocument/hover',
    params: { textDocument: { uri: URI }, position: { line: 0, character: 1 } },
  });
  t.session.fromPeer(a, hover(5));
  t.session.fromPeer(b, hover(5));
  const [ra, rb] = t.port.take();
  assert(ra.id !== rb.id, 'host ids differ');
  assertEquals(ra.method, 'textDocument/hover');
  // Answered in the other order.
  t.port.emit({ id: rb.id, result: { contents: 'for b' } });
  t.port.emit({ id: ra.id, result: { contents: 'for a' } });
  assertEquals(a.take(), [{
    jsonrpc: '2.0',
    id: 5,
    result: { contents: 'for a' },
  }]);
  assertEquals(b.take(), [{
    jsonrpc: '2.0',
    id: 5,
    result: { contents: 'for b' },
  }]);
  // An error answer is routed the same way.
  t.session.fromPeer(a, hover(6));
  const [rc] = t.port.take();
  t.port.emit({ id: rc.id, error: { code: -32603, message: 'boom' } });
  assertEquals(a.take(), [{
    jsonrpc: '2.0',
    id: 6,
    error: { code: -32603, message: 'boom' },
  }]);
  // A response for a connection that has gone is dropped.
  t.session.fromPeer(b, hover(7));
  const [rd] = t.port.take();
  t.session.detach(b);
  t.port.emit({ id: rd.id, result: null });
  assertEquals(b.take(), []);
});

Deno.test('requests: $/cancelRequest is mapped to the host id', () => {
  const t = setup();
  const a = new FakePeer();
  init(t, a);
  t.port.take();
  t.session.fromPeer(a, {
    jsonrpc: '2.0',
    id: 3,
    method: 'textDocument/completion',
    params: {},
  });
  const [req] = t.port.take();
  t.session.fromPeer(a, {
    jsonrpc: '2.0',
    method: '$/cancelRequest',
    params: { id: 3 },
  });
  assertEquals(t.port.take(), [
    { jsonrpc: '2.0', method: '$/cancelRequest', params: { id: req.id } },
  ]);
  // An unknown page id is dropped.
  t.session.fromPeer(a, {
    jsonrpc: '2.0',
    method: '$/cancelRequest',
    params: { id: 99 },
  });
  assertEquals(t.port.take(), []);
});

Deno.test("documents: didOpen, then a second opener is a full-text didChange; versions are the host's", () => {
  const t = setup();
  const a = new FakePeer();
  const b = new FakePeer();
  init(t, a);
  init(t, b);
  t.port.take();
  open(t, a, 'const x = 1;');
  assertEquals(t.port.take(), [{
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: {
      textDocument: {
        uri: URI,
        languageId: 'typescript',
        version: 1,
        text: 'const x = 1;',
      },
    },
  }]);
  t.session.fromPeer(a, {
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri: URI, version: 17 },
      contentChanges: [{ text: 'const x = 2;' }],
    },
  });
  assertEquals(t.port.take(), [{
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri: URI, version: 2 },
      contentChanges: [{ text: 'const x = 2;' }],
    },
  }]);
  open(t, b, 'const x = 3;');
  assertEquals(t.port.take(), [{
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri: URI, version: 3 },
      contentChanges: [{ text: 'const x = 3;' }],
    },
  }]);
});

Deno.test('documents: didClose is forwarded only after the last opener; a detach closes too', () => {
  const t = setup();
  const a = new FakePeer();
  const b = new FakePeer();
  init(t, a);
  init(t, b);
  open(t, a, 'x');
  open(t, b, 'x');
  t.port.take();
  t.session.fromPeer(a, {
    jsonrpc: '2.0',
    method: 'textDocument/didClose',
    params: { textDocument: { uri: URI } },
  });
  assertEquals(t.port.take(), []);
  t.session.detach(b);
  assertEquals(t.port.take(), [{
    jsonrpc: '2.0',
    method: 'textDocument/didClose',
    params: { textDocument: { uri: URI } },
  }]);
  // Re-opened afterwards: a fresh didOpen at version 1.
  open(t, a, 'y');
  const [m] = t.port.take();
  assertEquals(m.method, 'textDocument/didOpen');
  assertEquals(((m.params as Msg).textDocument as Msg).version, 1);
});

Deno.test('diagnostics: routed to openers without a version; a late opener gets the stored ones', () => {
  const t = setup();
  const a = new FakePeer();
  const b = new FakePeer();
  const c = new FakePeer();
  init(t, a);
  init(t, b);
  init(t, c);
  a.take();
  b.take();
  c.take();
  open(t, a, 'x');
  const diags = [{
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    message: 'bad',
  }];
  t.port.emit({
    method: 'textDocument/publishDiagnostics',
    params: { uri: URI, version: 1, diagnostics: diags },
  });
  const expected = {
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: { uri: URI, diagnostics: diags },
  };
  assertEquals(a.take(), [expected]);
  assertEquals(b.take(), [], 'b does not have the file open');
  open(t, b, 'x');
  assertEquals(b.take(), [expected]);
  assertEquals(c.take(), []);
});

Deno.test('server requests: each one in the table answered as specified, never forwarded', () => {
  const t = setup({
    settings: { python: { analysis: { typeCheckingMode: 'strict' } } },
  });
  const a = new FakePeer();
  init(t, a);
  open(t, a, 'x');
  t.port.take();
  a.take();
  const ask = (id: number, method: string, params?: unknown) => {
    t.port.emit({ id, method, params });
    return t.port.take();
  };
  assertEquals(
    ask(1, 'workspace/configuration', {
      items: [{ section: 'python.analysis' }, { section: 'nope.x' }, {}],
    }),
    [{
      jsonrpc: '2.0',
      id: 1,
      result: [
        { typeCheckingMode: 'strict' },
        null,
        { python: { analysis: { typeCheckingMode: 'strict' } } },
      ],
    }],
  );
  assertEquals(
    ask(2, 'client/registerCapability', {
      registrations: [
        {
          id: 'w1',
          method: 'workspace/didChangeWatchedFiles',
          registerOptions: { watchers: [{ globPattern: '**/*.ts' }] },
        },
        { id: 'f1', method: 'textDocument/formatting' },
      ],
    }),
    [{ jsonrpc: '2.0', id: 2, result: null }],
  );
  assertEquals(t.events.watchers, [[{ globPattern: '**/*.ts' }]]);
  assertEquals(
    ask(3, 'client/unregisterCapability', {
      unregisterations: [{
        id: 'w1',
        method: 'workspace/didChangeWatchedFiles',
      }],
    }),
    [{ jsonrpc: '2.0', id: 3, result: null }],
  );
  assertEquals(t.events.watchers, [[{ globPattern: '**/*.ts' }], []]);
  assertEquals(ask(4, 'window/workDoneProgress/create', { token: 't' }), [
    { jsonrpc: '2.0', id: 4, result: null },
  ]);
  assertEquals(ask(5, 'workspace/workspaceFolders'), [
    {
      jsonrpc: '2.0',
      id: 5,
      result: [{ uri: 'file:///workspaces/my%20repo', name: 'my repo' }],
    },
  ]);
  assertEquals(
    ask(6, 'window/showMessageRequest', { type: 1, message: 'm', actions: [] }),
    [
      { jsonrpc: '2.0', id: 6, result: null },
    ],
  );
  assertEquals(ask(7, 'workspace/applyEdit', { edit: {} }), [
    { jsonrpc: '2.0', id: 7, result: { applied: false } },
  ]);
  assertEquals(ask(8, 'workspace/diagnostic/refresh'), [
    { jsonrpc: '2.0', id: 8, result: null },
  ], 'no re-pull: this server pushes');
  const [unknown] = ask(9, 'workspace/codeLens/refresh');
  assertEquals(unknown.id, 9);
  assertEquals((unknown.error as Msg).code, -32601);
  assertEquals(a.take(), [], 'no server request reaches a page');
});

Deno.test('pull diagnostics: debounced after didOpen/didChange, converted, unchanged re-sent, refresh re-pulls', () => {
  const t = setup();
  const a = new FakePeer();
  init(t, a, 1, {
    diagnosticProvider: { interFileDependencies: true },
    textDocumentSync: 1,
  });
  t.port.take();
  a.take();
  open(t, a, 'x');
  t.session.fromPeer(a, {
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri: URI, version: 2 },
      contentChanges: [{ text: 'xy' }],
    },
  });
  t.port.take();
  t.clock.advance(PULL_DEBOUNCE_MS - 1);
  assertEquals(t.port.take(), []);
  t.clock.advance(1);
  const [pull] = t.port.take();
  assertEquals(pull.method, 'textDocument/diagnostic');
  assertEquals(pull.params, { textDocument: { uri: URI } });
  const items = [{ range: {}, message: 'e1' }];
  t.port.emit({ id: pull.id, result: { kind: 'full', resultId: 'r1', items } });
  assertEquals(a.take(), [{
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: { uri: URI, diagnostics: items },
  }]);
  // The next pull carries the resultId; `unchanged` re-sends the stored list.
  t.session.fromPeer(a, {
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri: URI, version: 3 },
      contentChanges: [{ text: 'xyz' }],
    },
  });
  t.port.take();
  t.clock.advance(PULL_DEBOUNCE_MS);
  const [pull2] = t.port.take();
  assertEquals(pull2.params, {
    textDocument: { uri: URI },
    previousResultId: 'r1',
  });
  t.port.emit({ id: pull2.id, result: { kind: 'unchanged', resultId: 'r1' } });
  assertEquals(a.take().map((m) => (m.params as Msg).diagnostics), [items]);
  // A failed pull is ignored.
  t.port.emit({ id: 1000, method: 'workspace/diagnostic/refresh' });
  const [ok, pull3] = t.port.take();
  assertEquals(ok, { jsonrpc: '2.0', id: 1000, result: null });
  assertEquals(pull3.method, 'textDocument/diagnostic');
  t.port.emit({ id: pull3.id, error: { code: -32603, message: 'nope' } });
  assertEquals(a.take(), []);
});

Deno.test('$/progress while ready: lsp_status ready with the detail; end of the last token clears it', () => {
  const t = setup();
  const a = new FakePeer();
  init(t, a);
  a.status = [];
  t.port.emit({
    method: '$/progress',
    params: {
      token: 'b',
      value: { kind: 'begin', title: 'Building', percentage: 0 },
    },
  });
  t.port.emit({
    method: '$/progress',
    params: {
      token: 'b',
      value: { kind: 'report', message: 'compileJava', percentage: 40 },
    },
  });
  t.port.emit({
    method: '$/progress',
    params: { token: 'b', value: { kind: 'end' } },
  });
  assertEquals(a.status, [
    {
      type: 'lsp_status',
      session: 's1',
      state: 'ready',
      detail: 'Building 0%',
    },
    {
      type: 'lsp_status',
      session: 's1',
      state: 'ready',
      detail: 'Building compileJava 40%',
    },
    { type: 'lsp_status', session: 's1', state: 'ready' },
  ]);
  // With a persistent notice, the end goes back to it.
  t.session.setNotice('file changes outside the editor are not seen');
  t.port.emit({
    method: '$/progress',
    params: { token: 1, value: { kind: 'begin', title: 'Indexing' } },
  });
  t.port.emit({
    method: '$/progress',
    params: { token: 1, value: { kind: 'end' } },
  });
  assertEquals(a.status.slice(-3).map((s) => s.detail), [
    'file changes outside the editor are not seen',
    'Indexing',
    'file changes outside the editor are not seen',
  ]);
});

Deno.test('$/progress: two overlapping tokens; the latest wins, and it clears when the last ends', () => {
  const t = setup();
  const a = new FakePeer();
  t.session.attach(a);
  // While starting: the state stays starting.
  t.port.emit({
    method: '$/progress',
    params: {
      token: 'x',
      value: {
        kind: 'begin',
        title: 'Importing',
        message: 'projects',
        percentage: 70,
      },
    },
  });
  assertEquals(a.status.at(-1), {
    type: 'lsp_status',
    session: 's1',
    state: 'starting',
    detail: 'Importing projects 70%',
  });
  init(t, a);
  assertEquals(a.status.at(-1)?.state, 'ready');
  assertEquals(a.status.at(-1)?.detail, 'Importing projects 70%');
  t.port.emit({
    method: '$/progress',
    params: { token: 'y', value: { kind: 'begin', title: 'Indexing' } },
  });
  assertEquals(a.status.at(-1)?.detail, 'Indexing');
  t.port.emit({
    method: '$/progress',
    params: { token: 'x', value: { kind: 'report', percentage: 90 } },
  });
  assertEquals(a.status.at(-1)?.detail, 'Importing 90%');
  t.port.emit({
    method: '$/progress',
    params: { token: 'x', value: { kind: 'end' } },
  });
  assertEquals(
    a.status.at(-1)?.detail,
    'Indexing',
    'the remaining token shows',
  );
  t.port.emit({
    method: '$/progress',
    params: { token: 'y', value: { kind: 'end' } },
  });
  assertEquals(a.status.at(-1), {
    type: 'lsp_status',
    session: 's1',
    state: 'ready',
  });
});

Deno.test('language/status and showMessage errors set the detail; log messages are dropped', () => {
  const t = setup();
  const a = new FakePeer();
  t.session.attach(a);
  t.port.emit({
    method: 'language/status',
    params: { type: 'Starting', message: 'Init... 10%' },
  });
  assertEquals(a.status.at(-1)?.detail, 'Init... 10%');
  init(t, a);
  t.port.emit({
    method: 'language/status',
    params: { type: 'Started', message: 'Ready' },
  });
  assertEquals(a.status.at(-1)?.state, 'ready');
  assertEquals(
    a.status.at(-1)?.detail,
    undefined,
    'language/status only while starting',
  );
  t.port.emit({
    method: 'window/showMessage',
    params: { type: 2, message: 'warn' },
  });
  t.port.emit({
    method: 'window/logMessage',
    params: { type: 1, message: 'log' },
  });
  t.port.emit({ method: 'telemetry/event', params: {} });
  assertEquals(a.status.at(-1)?.detail, undefined);
  t.port.emit({
    method: 'window/showMessage',
    params: { type: 1, message: 'Project broken' },
  });
  assertEquals(a.status.at(-1), {
    type: 'lsp_status',
    session: 's1',
    state: 'ready',
    detail: 'Project broken',
  });
  assertEquals(a.take().filter((m) => 'method' in m), []);
});

Deno.test('idle: stops after DEVC_WEB_LSP_IDLE_MS with no connection; an attach cancels it', () => {
  const idleMs = lspIdleMs({ get: () => '10000' });
  const t = setup({ idleMs });
  const a = new FakePeer();
  init(t, a);
  t.session.detach(a);
  t.clock.advance(idleMs - 1);
  assertEquals(t.events.idle, 0);
  t.session.attach(a);
  t.clock.advance(idleMs * 2);
  assertEquals(t.events.idle, 0, 'the attach cancelled the stop');
  t.session.detach(a);
  t.clock.advance(idleMs);
  assertEquals(t.events.idle, 1);
});

Deno.test('detach: cancels nothing while another connection is attached', () => {
  const t = setup({ idleMs: 1000 });
  const a = new FakePeer();
  const b = new FakePeer();
  init(t, a);
  init(t, b);
  open(t, a, 'x');
  open(t, b, 'x');
  t.port.take();
  b.take();
  t.session.fromPeer(b, {
    jsonrpc: '2.0',
    id: 4,
    method: 'textDocument/hover',
    params: {},
  });
  const [req] = t.port.take();
  t.session.detach(a);
  assertEquals(t.port.take(), [], 'b still has the file open: no didClose');
  t.clock.advance(5000);
  assertEquals(t.events.idle, 0, 'no idle stop while b is attached');
  t.port.emit({ id: req.id, result: 'still routed' });
  assertEquals(b.take(), [{ jsonrpc: '2.0', id: 4, result: 'still routed' }]);
  t.session.fromPeer(b, {
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: { textDocument: { uri: URI }, contentChanges: [{ text: 'y' }] },
  });
  assertEquals(t.port.take().map((m) => m.method), ['textDocument/didChange']);
});

Deno.test('exit: the server exiting on its own marks the session exited with the reason', () => {
  const t = setup();
  const a = new FakePeer();
  init(t, a);
  t.port.exit('exit code 1: boom');
  assertEquals(t.session.state, 'exited');
  assertEquals(t.events.exited, ['exit code 1: boom']);
  assertEquals(a.status.at(-1), {
    type: 'lsp_status',
    session: 's1',
    state: 'exited',
    detail: 'exit code 1: boom',
  });
  // Nothing more is forwarded.
  t.session.fromPeer(a, {
    jsonrpc: '2.0',
    id: 9,
    method: 'textDocument/hover',
    params: {},
  });
  assertEquals(
    t.port.take().filter((m) => m.method === 'textDocument/hover'),
    [],
  );
});

Deno.test('shutdown: shutdown then exit, and the exit that follows is not reported', async () => {
  const t = setup();
  const a = new FakePeer();
  init(t, a);
  t.port.take();
  const done = t.session.shutdown(5000);
  const [req] = t.port.take();
  assertEquals(req.method, 'shutdown');
  t.port.emit({ id: req.id, result: null });
  await done;
  assertEquals(t.port.take(), [{ jsonrpc: '2.0', method: 'exit' }]);
  t.port.exit('exit code 0');
  assertEquals(t.events.exited, []);
  // With no answer, it gives up after the timeout.
  const u = setup();
  const p = new FakePeer();
  init(u, p);
  u.port.take();
  const gone = u.session.shutdown(5000);
  u.clock.advance(5000);
  await gone;
  assertEquals(u.port.take().map((m) => m.method), ['shutdown', 'exit']);
});

Deno.test('connect again (restart): every connection is told starting and re-initializes', () => {
  const t = setup();
  const a = new FakePeer();
  init(t, a);
  open(t, a, 'x');
  t.session.fromPeer(a, {
    jsonrpc: '2.0',
    id: 3,
    method: 'textDocument/hover',
    params: {},
  });
  a.take();
  const port2 = new FakePort();
  t.session.connect(port2);
  assertEquals(a.status.at(-1)?.state, 'starting');
  assertEquals(a.take(), [{
    jsonrpc: '2.0',
    id: 3,
    error: { code: -32800, message: 'the language server restarted' },
  }]);
  // The old process's messages are ignored.
  t.port.emit({
    method: 'textDocument/publishDiagnostics',
    params: { uri: URI, diagnostics: [] },
  });
  assertEquals(a.take(), []);
  t.session.fromPeer(a, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {},
  });
  const [req] = port2.take();
  assertEquals(req.method, 'initialize');
  port2.emit({ id: req.id, result: { capabilities: {} } });
  assertEquals(t.session.state, 'ready');
  open(t, a, 'x');
  assertEquals(port2.last().method, 'textDocument/didOpen');
});

Deno.test('requests: LocationLink answers to definition requests become Locations', () => {
  const t = setup();
  const a = new FakePeer();
  init(t, a);
  t.port.take();
  a.take();
  const range = {
    start: { line: 1, character: 0 },
    end: { line: 3, character: 1 },
  };
  const sel = {
    start: { line: 1, character: 9 },
    end: { line: 1, character: 16 },
  };
  t.session.fromPeer(a, {
    jsonrpc: '2.0',
    id: 4,
    method: 'textDocument/definition',
    params: {},
  });
  const [req] = t.port.take();
  t.port.emit({
    id: req.id,
    result: [{
      targetUri: 'file:///w/b.ts',
      targetRange: range,
      targetSelectionRange: sel,
    }],
  });
  assertEquals(a.take(), [{
    jsonrpc: '2.0',
    id: 4,
    result: [{ uri: 'file:///w/b.ts', range: sel }],
  }]);
  // Locations, null, and other methods' answers are left alone.
  assertEquals(asLocations(null), null);
  assertEquals(asLocations({ uri: 'file:///x', range }), {
    uri: 'file:///x',
    range,
  });
  assertEquals(asLocations({ targetUri: 'file:///y', targetRange: range }), {
    uri: 'file:///y',
    range,
  });
  t.session.fromPeer(a, {
    jsonrpc: '2.0',
    id: 5,
    method: 'textDocument/references',
    params: {},
  });
  const [refs] = t.port.take();
  const links = [{ targetUri: 'file:///w/b.ts', targetRange: range }];
  t.port.emit({ id: refs.id, result: links });
  assertEquals(a.take(), [{ jsonrpc: '2.0', id: 5, result: links }]);
});

Deno.test('pull diagnostics: watched-file changes re-pull the open documents', () => {
  const t = setup();
  const a = new FakePeer();
  init(t, a, 1, { diagnosticProvider: {}, textDocumentSync: 1 });
  open(t, a, 'x');
  t.clock.advance(PULL_DEBOUNCE_MS);
  t.port.take();
  t.session.notifyServer('workspace/didChangeWatchedFiles', {
    changes: [{ uri: 'file:///workspaces/my%20repo/b.ts', type: 2 }],
  });
  assertEquals(t.port.take().map((m) => m.method), [
    'workspace/didChangeWatchedFiles',
  ]);
  t.clock.advance(PULL_DEBOUNCE_MS);
  const [pull] = t.port.take();
  assertEquals(pull.method, 'textDocument/diagnostic');
  assertEquals((pull.params as Msg).textDocument, { uri: URI });
  // A push server is not pulled.
  const u = setup();
  const b = new FakePeer();
  init(u, b);
  open(u, b, 'x');
  u.port.take();
  u.session.notifyServer('workspace/didChangeWatchedFiles', { changes: [] });
  u.clock.advance(PULL_DEBOUNCE_MS);
  assertEquals(u.port.take().map((m) => m.method), [
    'workspace/didChangeWatchedFiles',
  ]);
});

Deno.test('diagnostics: a report for a version since changed is dropped, pushed or pulled', () => {
  const t = setup();
  const a = new FakePeer();
  init(t, a);
  open(t, a, 'x');
  a.take();
  const change = (text: string) =>
    t.session.fromPeer(a, {
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: { textDocument: { uri: URI }, contentChanges: [{ text }] },
    });
  change('xy'); // version 2
  t.port.emit({
    method: 'textDocument/publishDiagnostics',
    params: { uri: URI, version: 1, diagnostics: [{ message: 'stale' }] },
  });
  assertEquals(a.take(), []);
  t.port.emit({
    method: 'textDocument/publishDiagnostics',
    params: { uri: URI, version: 2, diagnostics: [{ message: 'fresh' }] },
  });
  assertEquals(
    a.take().map((m) => ((m.params as Msg).diagnostics as Msg[])[0].message),
    ['fresh'],
  );
  // Pulled: the answer to a pull sent before a change is dropped; the next pull's lands.
  const p = setup();
  const b = new FakePeer();
  init(p, b, 1, { diagnosticProvider: {}, textDocumentSync: 1 });
  open(p, b, 'x');
  p.clock.advance(PULL_DEBOUNCE_MS);
  const [stalePull] = p.port.take().filter((m) =>
    m.method === 'textDocument/diagnostic'
  );
  b.take();
  p.session.fromPeer(b, {
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri: URI },
      contentChanges: [{ text: 'shorter' }],
    },
  });
  p.port.emit({
    id: stalePull.id,
    result: { kind: 'full', items: [{ message: 'old' }] },
  });
  assertEquals(b.take(), []);
  p.clock.advance(PULL_DEBOUNCE_MS);
  const [freshPull] = p.port.take().filter((m) =>
    m.method === 'textDocument/diagnostic'
  );
  p.port.emit({
    id: freshPull.id,
    result: { kind: 'full', items: [{ message: 'new' }] },
  });
  assertEquals(
    b.take().map((m) => ((m.params as Msg).diagnostics as Msg[])[0].message),
    ['new'],
  );
});

// ---------------------------------------------------------------------------------------------
// View documents (diff tiles): devc/openView, devc/closeView, devc/viewStale
// ---------------------------------------------------------------------------------------------

function openView(
  t: ReturnType<typeof setup>,
  peer: FakePeer,
  id: number,
  text: string,
  uri = URI,
) {
  t.session.fromPeer(peer, {
    jsonrpc: '2.0',
    id,
    method: 'devc/openView',
    params: { textDocument: { uri, languageId: 'typescript', text } },
  });
}

function closeView(t: ReturnType<typeof setup>, peer: FakePeer, uri = URI) {
  t.session.fromPeer(peer, {
    jsonrpc: '2.0',
    method: 'devc/closeView',
    params: { textDocument: { uri } },
  });
}

function change(t: ReturnType<typeof setup>, peer: FakePeer, text: string) {
  t.session.fromPeer(peer, {
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: { textDocument: { uri: URI }, contentChanges: [{ text }] },
  });
}

const stale = (m: Msg) => m.method === 'devc/viewStale';

Deno.test('view: openView on a closed URI opens it with the view text, answered by the host', () => {
  const t = setup();
  const peer = new FakePeer();
  init(t, peer);
  t.port.take();
  peer.take();
  openView(t, peer, 5, 'head');
  const sent = t.port.take();
  assertEquals(sent.length, 1);
  assertEquals(sent[0].method, 'textDocument/didOpen');
  assertEquals((sent[0].params as Msg).textDocument, {
    uri: URI,
    languageId: 'typescript',
    version: 1,
    text: 'head',
  });
  assert(!sent.some((m) => m.method === 'devc/openView'));
  assertEquals(peer.take(), [{ jsonrpc: '2.0', id: 5, result: { ok: true } }]);
});

Deno.test('view: editor open with equal text → ok, nothing to the server', () => {
  const t = setup();
  const peer = new FakePeer();
  init(t, peer);
  open(t, peer, 'same');
  t.port.take();
  peer.take();
  openView(t, peer, 2, 'same');
  assertEquals(t.port.take(), []);
  assertEquals(peer.take(), [{ jsonrpc: '2.0', id: 2, result: { ok: true } }]);
});

Deno.test('view: editor open with different text → edited, nothing to the server', () => {
  const t = setup();
  const editor = new FakePeer();
  const viewer = new FakePeer();
  init(t, editor);
  init(t, viewer, 9);
  open(t, editor, 'local edits');
  t.port.take();
  viewer.take();
  openView(t, viewer, 3, 'head');
  assertEquals(t.port.take(), []);
  assertEquals(viewer.take(), [{
    jsonrpc: '2.0',
    id: 3,
    result: { ok: false, reason: 'edited' },
  }]);
});

Deno.test('view: an editor didOpen with different text wins, and the view is told it is stale', () => {
  const t = setup();
  const viewer = new FakePeer();
  const editor = new FakePeer();
  init(t, viewer);
  init(t, editor, 4);
  openView(t, viewer, 2, 'head');
  t.port.take();
  viewer.take();
  open(t, editor, 'disk');
  const [ch] = t.port.take().filter((m) =>
    m.method === 'textDocument/didChange'
  );
  assertEquals((ch.params as Msg).contentChanges, [{ text: 'disk' }]);
  assertEquals(viewer.take().filter(stale), [{
    jsonrpc: '2.0',
    method: 'devc/viewStale',
    params: { textDocument: { uri: URI } },
  }]);
});

Deno.test('view: an editor didChange makes the view stale', () => {
  const t = setup();
  const peer = new FakePeer();
  init(t, peer);
  open(t, peer, 'same');
  openView(t, peer, 2, 'same');
  peer.take();
  change(t, peer, 'typed');
  assertEquals(peer.take().filter(stale).length, 1);
  // Stale views are let go: a second change tells nobody again.
  change(t, peer, 'typed more');
  assertEquals(peer.take().filter(stale), []);
});

Deno.test('view: one peer as editor and view; closeView keeps it open, the editor close closes it', () => {
  const t = setup();
  const peer = new FakePeer();
  init(t, peer);
  open(t, peer, 'same');
  openView(t, peer, 2, 'same');
  t.port.take();
  closeView(t, peer);
  assertEquals(t.port.take(), []);
  t.session.fromPeer(peer, {
    jsonrpc: '2.0',
    method: 'textDocument/didClose',
    params: { textDocument: { uri: URI } },
  });
  assertEquals(t.port.take().map((m) => m.method), ['textDocument/didClose']);
});

Deno.test('view: one peer, editor closes first, then closeView closes it', () => {
  const t = setup();
  const peer = new FakePeer();
  init(t, peer);
  open(t, peer, 'same');
  openView(t, peer, 2, 'same');
  t.port.take();
  t.session.fromPeer(peer, {
    jsonrpc: '2.0',
    method: 'textDocument/didClose',
    params: { textDocument: { uri: URI } },
  });
  assertEquals(t.port.take(), []);
  closeView(t, peer);
  assertEquals(t.port.take().map((m) => m.method), ['textDocument/didClose']);
});

Deno.test('view: a second view with new text and no editors replaces it; the first is stale', () => {
  const t = setup();
  const a = new FakePeer();
  const b = new FakePeer();
  init(t, a);
  init(t, b, 3);
  openView(t, a, 2, 'old head');
  t.port.take();
  a.take();
  b.take();
  openView(t, b, 4, 'new head');
  const sent = t.port.take();
  assertEquals(sent.map((m) => m.method), ['textDocument/didChange']);
  assertEquals((sent[0].params as Msg).contentChanges, [{ text: 'new head' }]);
  assertEquals(a.take().filter(stale).length, 1);
  assertEquals(b.take(), [{ jsonrpc: '2.0', id: 4, result: { ok: true } }]);
});

Deno.test('view: a view-only document gets no diagnostics and no pulls', () => {
  const t = setup();
  const peer = new FakePeer();
  init(t, peer, 1, {
    textDocumentSync: 1,
    diagnosticProvider: { interFileDependencies: true },
  });
  openView(t, peer, 2, 'head');
  t.port.take();
  peer.take();
  t.clock.advance(PULL_DEBOUNCE_MS * 4);
  assertEquals(
    t.port.take().filter((m) => m.method === 'textDocument/diagnostic'),
    [],
  );
  t.port.emit({
    method: 'textDocument/publishDiagnostics',
    params: { uri: URI, diagnostics: [{ message: 'x' }] },
  });
  assertEquals(peer.take(), []);
  // workspace/diagnostic/refresh does not pull it either.
  t.port.emit({ id: 99, method: 'workspace/diagnostic/refresh' });
  assertEquals(
    t.port.take().filter((m) => m.method === 'textDocument/diagnostic'),
    [],
  );
});

Deno.test('view: detaching the last holder of a view closes it', () => {
  const t = setup();
  const peer = new FakePeer();
  const other = new FakePeer();
  init(t, peer);
  init(t, other, 2);
  openView(t, peer, 3, 'head');
  t.port.take();
  t.session.detach(peer);
  assertEquals(t.port.take().map((m) => m.method), ['textDocument/didClose']);
});
