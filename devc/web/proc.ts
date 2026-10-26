import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

// Child processes for `devc web`: every long-lived `docker` process the server starts goes
// through `spawnLines` (read as JSON lines) or `spawnBytes` (a language server's raw stdio), so
// each is tracked for shutdown the same way.
//
// Lines are split by hand rather than with `@std/streams`' `TextLineStream` only to avoid a new
// dependency; a `terminal.frame` line can be hundreds of KB, so the splitter keeps a running
// buffer instead of assuming a chunk holds a line.

/** A spawned child tracked for shutdown, whatever its stdout is read as. */
export interface TrackedProc {
  /** Closes stdin, which is how a bridge or controller is told to exit. Idempotent. */
  closeStdin(): Promise<void>;
  /** SIGKILLs the host-side client. Idempotent. */
  kill(): void;
  /** Resolves when the child has exited. */
  status: Promise<{ code: number | null }>;
  /** Everything the child wrote to stderr (capped), resolved after it exits. */
  stderr: Promise<string>;
}

/** A spawned child whose stdout is read as lines. */
export interface LineProc extends TrackedProc {
  /** stdout, one line per item, without the trailing newline. Ends when stdout closes. */
  lines: AsyncIterableIterator<string>;
  /** Writes `line` plus a newline to stdin. Never throws: a write to a dead child is dropped. */
  write(line: string): Promise<void>;
}

/** A spawned child whose stdio are bytes: a language server's, framed by `lsp_framing.ts`. */
export interface ByteProc extends TrackedProc {
  /** stdout's chunks as they come. Ends when stdout closes. */
  stdout: AsyncIterable<Uint8Array>;
  /** Writes `bytes` to stdin. Never throws: a write to a dead child is dropped. */
  write(bytes: Uint8Array): Promise<void>;
}

const live = new Set<TrackedProc>();

/** Splits a text stream into lines. Exported for tests. */
export async function* splitLines(
  chunks: AsyncIterable<string>,
): AsyncGenerator<string> {
  let buf = '';
  for await (const chunk of chunks) {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
    }
  }
  if (buf !== '') yield buf;
}

/**
 * `stdout`'s chunks, for a reader that may stop early (`bridgeRequest` returns on its answer,
 * a controller breaks on `terminal.closed`). By default, leaving a stream's async iterator
 * early destroys the stream with an `AbortError`, which on macOS Deno surfaces as an uncaught
 * rejection that kills `devc web`. Here the stream is left alone and drained instead, so the
 * child can still exit and `status` still resolves.
 */
async function* readToEnd<T = string>(stdout: Readable): AsyncGenerator<T> {
  try {
    yield* stdout.iterator({ destroyOnReturn: false }) as AsyncIterable<T>;
  } finally {
    stdout.resume();
  }
}

const STDERR_CAP = 16 * 1024;

/**
 * Spawns `cmd args…` with piped stdin/stdout/stderr, in its own process group (`detached`), so
 * the Ctrl-C a terminal sends to `devc web`'s group does not kill the `docker exec` clients
 * before shutdown has released their terminals. A spawn failure (`docker` missing, say) shows
 * up as an immediate exit with the error on `stderr`.
 */
export function spawnLines(cmd: string, args: string[]): LineProc {
  const child = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  let stdinClosed = false;
  let exited = false;
  let stderrText = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    if (stderrText.length < STDERR_CAP) stderrText += chunk;
  });
  // A write to a child that already exited raises EPIPE on the stream; it is expected here.
  child.stdin!.on('error', () => {});
  const status = new Promise<{ code: number | null }>((resolve) => {
    child.on('error', (err) => {
      stderrText += String(err);
      resolve({ code: null });
    });
    child.on('close', (code) => resolve({ code }));
  });
  const proc: LineProc = {
    lines: splitLines(readToEnd(child.stdout!)),
    write(line) {
      if (stdinClosed || exited) return Promise.resolve();
      return new Promise((resolve) => {
        child.stdin!.write(line + '\n', () => resolve());
      });
    },
    closeStdin() {
      if (stdinClosed) return Promise.resolve();
      stdinClosed = true;
      return new Promise((resolve) => child.stdin!.end(() => resolve()));
    },
    kill() {
      if (exited) return;
      try {
        child.kill('SIGKILL');
      } catch { /* already exited */ }
    },
    status,
    stderr: status.then(() => stderrText.slice(0, STDERR_CAP)),
  };
  live.add(proc);
  status.then(() => {
    exited = true;
    stdinClosed = true;
    live.delete(proc);
  });
  return proc;
}

/**
 * {@link spawnLines} with stdout as raw chunks and `write` taking bytes: a language server's
 * `docker exec -i` client. The same process group, tracking, `kill`, `closeStdin`, `status` and
 * capped `stderr`.
 */
export function spawnBytes(cmd: string, args: string[]): ByteProc {
  const child = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  let stdinClosed = false;
  let exited = false;
  let stderrText = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    if (stderrText.length < STDERR_CAP) stderrText += chunk;
  });
  child.stdin!.on('error', () => {});
  const status = new Promise<{ code: number | null }>((resolve) => {
    child.on('error', (err) => {
      stderrText += String(err);
      resolve({ code: null });
    });
    child.on('close', (code) => resolve({ code }));
  });
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for await (const b of readToEnd<Uint8Array>(child.stdout!)) {
      yield new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    }
  }
  const proc: ByteProc = {
    stdout: chunks(),
    write(bytes) {
      if (stdinClosed || exited) return Promise.resolve();
      return new Promise((resolve) => {
        child.stdin!.write(bytes, () => resolve());
      });
    },
    closeStdin() {
      if (stdinClosed) return Promise.resolve();
      stdinClosed = true;
      return new Promise((resolve) => child.stdin!.end(() => resolve()));
    },
    kill() {
      if (exited) return;
      try {
        child.kill('SIGKILL');
      } catch { /* already exited */ }
    },
    status,
    stderr: status.then(() => stderrText.slice(0, STDERR_CAP)),
  };
  live.add(proc);
  status.then(() => {
    exited = true;
    stdinClosed = true;
    live.delete(proc);
  });
  return proc;
}

/**
 * Closes stdin and waits up to `graceMs` for the child to exit on its own, then kills it. A
 * `docker exec` client that is killed leaves its process running inside the container, so the
 * graceful close always comes first.
 */
export async function closeGracefully(
  proc: TrackedProc,
  graceMs = 2000,
): Promise<void> {
  await proc.closeStdin();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    proc.status,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, graceMs);
    }),
  ]);
  clearTimeout(timer);
  proc.kill();
}

/** Every child still running, for shutdown. */
export function liveProcs(): TrackedProc[] {
  return [...live];
}

/** Runs `cmd args…` to completion and returns its exit code, stdout and stderr as text. */
export async function runText(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command(cmd, {
    args,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
}
