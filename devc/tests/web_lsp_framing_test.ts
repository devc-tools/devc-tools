import { assertEquals } from 'jsr:@std/assert';
import {
  encodeMessage,
  FrameReader,
  MAX_DISCARDED,
} from '../web/lsp_framing.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

Deno.test('encodeMessage: Content-Length counts UTF-8 bytes, not characters', () => {
  const msg = {
    jsonrpc: '2.0',
    method: 'x',
    params: { text: 'héllo → 世界 🎉' },
  };
  const bytes = encodeMessage(msg);
  const text = dec.decode(bytes);
  const [head, body] = text.split('\r\n\r\n');
  const n = Number(head.replace('Content-Length: ', ''));
  assertEquals(n, enc.encode(body).length);
  assertEquals(n > body.length, true);
  assertEquals(JSON.parse(body), msg);
  assertEquals(new FrameReader().push(bytes), [msg]);
});

Deno.test('FrameReader: a multi-byte message split across chunks at every byte', () => {
  const msg = { id: 1, result: { contents: 'λ → 世界 🎉 ü' } };
  const bytes = encodeMessage(msg);
  for (let cut = 1; cut < bytes.length; cut++) {
    const r = new FrameReader();
    assertEquals(r.push(bytes.subarray(0, cut)), [], `cut ${cut}`);
    assertEquals(r.push(bytes.subarray(cut)), [msg], `cut ${cut}`);
  }
  // And one byte at a time.
  const r = new FrameReader();
  const got: unknown[] = [];
  for (const b of bytes) got.push(...r.push(new Uint8Array([b])));
  assertEquals(got, [msg]);
});

Deno.test('FrameReader: two messages in one chunk', () => {
  const a = { id: 1, result: null };
  const b = {
    method: 'textDocument/publishDiagnostics',
    params: { uri: 'file:///é' },
  };
  const ea = encodeMessage(a);
  const eb = encodeMessage(b);
  const both = new Uint8Array(ea.length + eb.length);
  both.set(ea);
  both.set(eb, ea.length);
  assertEquals(new FrameReader().push(both), [a, b]);
});

Deno.test('FrameReader: a Content-Type header is ignored, either order, any case', () => {
  const body = JSON.stringify({ id: 2, result: 'ok' });
  const n = enc.encode(body).length;
  const r = new FrameReader();
  assertEquals(
    r.push(enc.encode(
      `Content-Length: ${n}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n${body}`,
    )),
    [{ id: 2, result: 'ok' }],
  );
  assertEquals(
    r.push(enc.encode(
      `content-type: application/vscode-jsonrpc\r\ncontent-length: ${n}\r\n\r\n${body}`,
    )),
    [{ id: 2, result: 'ok' }],
  );
  assertEquals(
    new FrameReader().push(enc.encode(`CONTENT-LENGTH:${n}\r\n\r\n${body}`)),
    [{ id: 2, result: 'ok' }],
  );
});

Deno.test('FrameReader: junk lines before the first header are skipped and kept', () => {
  const msg = { id: 1, result: {} };
  const junk = 'Welcome to bash!\nnvm: using node 20\r\n';
  const r = new FrameReader();
  const bytes = enc.encode(junk);
  assertEquals(r.push(bytes), []);
  assertEquals(r.push(encodeMessage(msg)), [msg]);
  assertEquals(r.discarded, junk);
  // A crash message with no line break is in the discard text too.
  const crashed = new FrameReader();
  crashed.push(enc.encode('An error has occurred. See the log file'));
  assertEquals(crashed.discarded, 'An error has occurred. See the log file');
});

Deno.test('FrameReader: the discard text is capped', () => {
  const r = new FrameReader();
  for (let i = 0; i < 100; i++) r.push(enc.encode('x'.repeat(99) + '\n'));
  assertEquals(r.discarded.length, MAX_DISCARDED);
  assertEquals(r.push(encodeMessage({ id: 3 })), [{ id: 3 }]);
});
