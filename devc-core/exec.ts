// The `child_process` adapter `container.ts` needs — a drop-in for the two subprocess shapes it
// used to reach for directly through the Deno runtime's own `Command` API: run to completion
// capturing output (`.output()`), and run with every stream inherited (`.spawn().status`).
// Nothing more; this is not a general subprocess library.

import { spawn } from 'node:child_process';
import { isNotFound } from './errors.ts';

/** Per-stream disposition, matching the vocabulary that old `Command` API used. */
export type Stdio = 'piped' | 'inherit' | 'null';

export interface CommandOptions {
  args?: string[];
  stdin?: Stdio;
  stdout?: Stdio;
  stderr?: Stdio;
  /**
   * Called with each stdout chunk as it arrives, *alongside* the collection {@link output}
   * already does — a tee, not a replacement, so `CommandOutput.stdout` is unaffected.
   *
   * Only meaningful for a `'piped'` stream: an `'inherit'`ed one never reaches this process, and
   * a `'null'`ed one is discarded by the OS. Exists so a caller that must not let a child write
   * to the terminal (a TUI) can pipe the stream and still see it live rather than only at exit.
   */
  onStdout?: (chunk: Uint8Array) => void;
  /** As {@link CommandOptions.onStdout}, for stderr. */
  onStderr?: (chunk: Uint8Array) => void;
}

export interface CommandOutput {
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

function toNodeStdio(mode: Stdio | undefined): 'pipe' | 'inherit' | 'ignore' {
  switch (mode) {
    case 'piped':
      return 'pipe';
    case 'inherit':
      return 'inherit';
    case 'null':
    case undefined:
      return 'ignore';
  }
}

/**
 * Maps a spawn failure to the error the caller should see. A missing binary arrives as an
 * `ENOENT` whose stock message (`spawn docker ENOENT`) reads as an internal fault; this states
 * the actual problem instead. Every other failure passes through untouched.
 */
function spawnFailure(cmd: string, err: unknown): unknown {
  return isNotFound(err)
    ? new Error(`${cmd} not found on PATH — install it and try again`)
    : err;
}

/**
 * Runs `cmd` to completion, mirroring the old `Command(cmd, opts).output()`: resolves with the
 * exit code and whichever of stdout/stderr were `'piped'` (empty otherwise).
 *
 * `opts.onStdout` / `opts.onStderr`, when given, additionally receive each piped chunk as it
 * arrives — see {@link CommandOptions.onStdout}.
 */
export function output(
  cmd: string,
  opts: CommandOptions = {},
): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, opts.args ?? [], {
      stdio: [
        toNodeStdio(opts.stdin),
        toNodeStdio(opts.stdout),
        toNodeStdio(opts.stderr),
      ],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    // The callbacks fire from inside the same `data` handler that collects, so a consumer sees
    // exactly the chunk boundaries the child produced and nothing is collected twice.
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      opts.onStdout?.(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      opts.onStderr?.(chunk);
    });
    child.on('error', (err) => reject(spawnFailure(cmd, err)));
    child.on('close', (code) => {
      resolve({
        code: code ?? -1,
        stdout: new Uint8Array(Buffer.concat(stdoutChunks)),
        stderr: new Uint8Array(Buffer.concat(stderrChunks)),
      });
    });
  });
}

/**
 * Runs `cmd` and resolves with just its exit code, mirroring the old
 * `Command(cmd, opts).spawn().status`. Used for the interactive case (`execInContainer`), where
 * every stream is inherited and nothing is captured — so the `onStdout`/`onStderr` half of
 * {@link CommandOptions} is inert here, and only {@link output} honours it.
 */
export function status(
  cmd: string,
  opts: CommandOptions = {},
): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, opts.args ?? [], {
      stdio: [
        toNodeStdio(opts.stdin),
        toNodeStdio(opts.stdout),
        toNodeStdio(opts.stderr),
      ],
    });
    child.on('error', (err) => reject(spawnFailure(cmd, err)));
    child.on('close', (code) => resolve({ code: code ?? -1 }));
  });
}
