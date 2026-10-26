// The Language Server Protocol's base framing for `devc web`'s language servers: each message is
// `Content-Length: <n>\r\n\r\n` and then `n` bytes of UTF-8 JSON. Pure. See
// `.plans/devc-web-lsp-core.md` § Process.
//
// `n` counts UTF-8 *bytes*, not string length, so bodies are cut from bytes and decoded only once
// whole. A launcher runs in a login shell, whose profile scripts may print to stdout before the
// server starts (and JDT LS prints "An error has occurred. See the log file" on a bad start), so
// the reader skips whatever comes before a `Content-Length:` line, keeping the start of it for
// the session's `exited` detail.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** How much skipped text {@link FrameReader.discarded} keeps. */
export const MAX_DISCARDED = 4 * 1024;
/** A header line longer than this is skipped as junk rather than buffered without end. */
const MAX_HEADER_LINE = 64 * 1024;

/** `msg` framed: `Content-Length: <UTF-8 byte length>\r\n\r\n<json>`. */
export function encodeMessage(msg: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(msg));
  const head = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

const CONTENT_LENGTH = /^content-length:\s*(\d+)\s*$/i;
const CONTENT_TYPE = /^content-type:/i;

/** Reads framed messages out of a byte stream that arrives in chunks of any size. */
export class FrameReader {
  #buf: Uint8Array = new Uint8Array(0);
  /** The body's length once its `Content-Length` is read; null before. */
  #length: number | null = null;
  /** A header line was read: the lines up to a blank one are headers, not junk. */
  #inHeaders = false;
  /** The blank line after the headers was read: the body comes next. */
  #inBody = false;
  #discarded = '';

  /**
   * Text skipped before a `Content-Length:` line (profile output, a server's crash message), its
   * first {@link MAX_DISCARDED} characters, including a line still being read.
   */
  get discarded(): string {
    const partial = this.#inHeaders ? '' : decoder.decode(this.#buf);
    return (this.#discarded + partial).slice(0, MAX_DISCARDED);
  }

  /** Adds `chunk` and returns every message it completes, parsed, in order. */
  push(chunk: Uint8Array): unknown[] {
    this.#buf = concat(this.#buf, chunk);
    const out: unknown[] = [];
    for (;;) {
      if (this.#inBody) {
        const n = this.#length as number;
        if (this.#buf.length < n) break;
        const body = this.#buf.subarray(0, n);
        this.#buf = this.#buf.slice(n);
        this.#inBody = false;
        this.#inHeaders = false;
        this.#length = null;
        try {
          out.push(JSON.parse(decoder.decode(body)));
        } catch {
          /* not JSON: dropped, as a server's garbage would be anywhere */
        }
        continue;
      }
      const nl = this.#buf.indexOf(0x0a);
      if (nl === -1) {
        if (this.#buf.length > MAX_HEADER_LINE) this.#skip(this.#buf.length);
        break;
      }
      const line = decoder.decode(this.#buf.subarray(0, nl)).replace(/\r$/, '');
      const m = CONTENT_LENGTH.exec(line);
      if (!this.#inHeaders) {
        // Before a message's headers: junk unless it is `Content-Length:` (or `Content-Type:`).
        if (m || CONTENT_TYPE.test(line)) {
          this.#inHeaders = true;
          if (m) this.#length = Number(m[1]);
          this.#buf = this.#buf.slice(nl + 1);
        } else this.#skip(nl + 1);
        continue;
      }
      this.#buf = this.#buf.slice(nl + 1);
      if (line === '') {
        // Headers with no length frame nothing: wait for the next header.
        if (this.#length === null) this.#inHeaders = false;
        else this.#inBody = true;
      } else if (m) this.#length = Number(m[1]);
      // Any other header (`Content-Type`) is ignored.
    }
    return out;
  }

  #skip(n: number) {
    if (this.#discarded.length < MAX_DISCARDED) {
      this.#discarded += decoder.decode(this.#buf.subarray(0, n));
      this.#discarded = this.#discarded.slice(0, MAX_DISCARDED);
    }
    this.#buf = this.#buf.slice(n);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice();
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
