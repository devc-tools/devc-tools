import { spawn } from 'node:child_process';

// Child processes for `devc web`: every `docker` process the server starts goes through
// `spawnLines`, so each is tracked for shutdown and read as JSON lines the same way.
//
// Lines are split by hand rather than with `@std/streams`' `TextLineStream` only to avoid a new
// dependency; a `terminal.frame` line can be hundreds of KB, so the splitter keeps a running
// buffer instead of assuming a chunk holds a line.

/** A spawned child whose stdout is read as lines. */
export interface LineProc {
  /** stdout, one line per item, without the trailing newline. Ends when stdout closes. */
  lines: AsyncIterableIterator<string>;
  /** Writes `line` plus a newline to stdin. Never throws: a write to a dead child is dropped. */
  write(line: string): Promise<void>;
  /** Closes stdin, which is how a bridge or controller is told to exit. Idempotent. */
  closeStdin(): Promise<void>;
  /** SIGKILLs the host-side client. Idempotent. */
  kill(): void;
  /** Resolves when the child has exited. */
  status: Promise<{ code: number | null }>;
  /** Everything the child wrote to stderr (capped), resolved after it exits. */
  stderr: Promise<string>;
}

const live = new Set<LineProc>();

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
    lines: splitLines(child.stdout! as AsyncIterable<string>),
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
 * Closes stdin and waits up to `graceMs` for the child to exit on its own, then kills it. A
 * `docker exec` client that is killed leaves its process running inside the container, so the
 * graceful close always comes first.
 */
export async function closeGracefully(
  proc: LineProc,
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
export function liveProcs(): LineProc[] {
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
