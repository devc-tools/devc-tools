// A fake language server for `tests/web_lsp_manager_test.ts`: LSP over stdio, just enough to
// drive `devc web`'s session and manager without Docker or a real server.
//
//   deno run tests/fixtures/fake_lsp_server.ts [--caps <json>] [--pull] [--junk <text>]
//
// - `initialize` answers `--caps` (default: full sync, completion, hover); `--pull` adds a
//   `diagnosticProvider`. `initialize`'s params are kept, for `fake/state`.
// - `initialized` registers a file watcher for `**/*.ts` (`client/registerCapability`).
// - Every `didOpen` and `didChange` is echoed back as one diagnostic whose message is the
//   document's text: pushed (`publishDiagnostics`), or with `--pull`, answered to
//   `textDocument/diagnostic`.
// - `textDocument/completion` gives one item, `fakeCompletion`.
// - `fake/state` answers what it has seen: the initialize params, the notifications' methods,
//   the configuration it was sent, and the watched-file changes.
// - `fake/crash` prints `fatal: kaboom` on stderr and exits 3.
// - `shutdown` answers null; `exit` exits 0 after a shutdown, 1 without.
// - `--junk <text>` is printed on stdout before anything else, as a login shell's profile might.

const args = Deno.args;
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const pull = args.includes('--pull');
const caps: Record<string, unknown> = {
  ...(JSON.parse(flag('--caps') ?? 'null') ?? {
    textDocumentSync: 1,
    completionProvider: { triggerCharacters: ['.'] },
    hoverProvider: true,
  }),
  ...(pull
    ? {
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
    }
    : {}),
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const out = Deno.stdout;

function send(msg: Record<string, unknown>) {
  const body = enc.encode(JSON.stringify({ jsonrpc: '2.0', ...msg }));
  out.writeSync(enc.encode(`Content-Length: ${body.length}\r\n\r\n`));
  let n = 0;
  while (n < body.length) n += out.writeSync(body.subarray(n));
}

const junk = flag('--junk');
if (junk !== undefined) out.writeSync(enc.encode(junk));

const seen = {
  initialize: null as unknown,
  notifications: [] as string[],
  configuration: null as unknown,
  watched: [] as unknown[],
};
const texts = new Map<string, string>();
let shutDown = false;
let nextId = 1000;

function diagnostics(uri: string) {
  return [{
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    severity: 1,
    message: texts.get(uri) ?? '',
  }];
}

function handle(msg: Record<string, unknown>) {
  const method = msg.method as string | undefined;
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const id = msg.id as number | string | undefined;
  if (method === undefined) return; // an answer to our own request
  if (id === undefined) seen.notifications.push(method);
  switch (method) {
    case 'initialize':
      seen.initialize = params;
      send({
        id,
        result: {
          capabilities: caps,
          serverInfo: { name: 'fake', version: '1' },
        },
      });
      return;
    case 'initialized':
      send({
        id: nextId++,
        method: 'client/registerCapability',
        params: {
          registrations: [{
            id: 'watch-ts',
            method: 'workspace/didChangeWatchedFiles',
            registerOptions: { watchers: [{ globPattern: '**/*.ts' }] },
          }],
        },
      });
      return;
    case 'workspace/didChangeConfiguration':
      seen.configuration = params.settings;
      return;
    case 'workspace/didChangeWatchedFiles':
      seen.watched.push(...(params.changes as unknown[]));
      return;
    case 'textDocument/didOpen':
    case 'textDocument/didChange': {
      const td = params.textDocument as { uri: string; text?: string };
      const text = method === 'textDocument/didOpen'
        ? td.text ?? ''
        : ((params.contentChanges as { text: string }[]).at(-1)?.text ?? '');
      texts.set(td.uri, text);
      if (!pull) {
        send({
          method: 'textDocument/publishDiagnostics',
          params: { uri: td.uri, diagnostics: diagnostics(td.uri) },
        });
      }
      return;
    }
    case 'textDocument/didClose':
      texts.delete((params.textDocument as { uri: string }).uri);
      return;
    case 'textDocument/diagnostic': {
      const uri = (params.textDocument as { uri: string }).uri;
      send({ id, result: { kind: 'full', items: diagnostics(uri) } });
      return;
    }
    case 'textDocument/completion':
      send({
        id,
        result: { isIncomplete: false, items: [{ label: 'fakeCompletion' }] },
      });
      return;
    case 'fake/state':
      send({ id, result: seen });
      return;
    case 'fake/crash':
      console.error('starting up');
      console.error('fatal: kaboom');
      Deno.exit(3);
      return;
    case 'shutdown':
      shutDown = true;
      send({ id, result: null });
      return;
    case 'exit':
      Deno.exit(shutDown ? 0 : 1);
      return;
    default:
      if (id !== undefined) {
        send({
          id,
          error: { code: -32601, message: `unknown method ${method}` },
        });
      }
  }
}

// Framing, by hand: the fixture must not depend on the code it tests.
let buf = new Uint8Array(0);
for await (const chunk of Deno.stdin.readable) {
  const next = new Uint8Array(buf.length + chunk.length);
  next.set(buf);
  next.set(chunk, buf.length);
  buf = next;
  for (;;) {
    const text = dec.decode(buf.subarray(0, Math.min(buf.length, 256)));
    const end = text.indexOf('\r\n\r\n');
    if (end === -1) break;
    const m = /content-length:\s*(\d+)/i.exec(text.slice(0, end));
    if (!m) throw new Error('no Content-Length');
    const start = enc.encode(text.slice(0, end + 4)).length;
    const n = Number(m[1]);
    if (buf.length < start + n) break;
    handle(JSON.parse(dec.decode(buf.subarray(start, start + n))));
    buf = buf.slice(start + n);
  }
}
// stdin closed (the client went away): exit as a server does.
Deno.exit(shutDown ? 0 : 1);
