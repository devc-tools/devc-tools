// Starting and stopping a project's container from `devc web`. A start runs the CLI's own
// `startContainer` in-process — the same start hooks as `devc attach` or `devc herdr`: the
// ancestor-repo guard, and a devc-bridge policy *refresh* (never the revoke a bare `devc up`
// would do) — with two differences that come from not having the user's terminal: the
// devcontainer CLI's progress log (its stderr) goes line by line to `onLine` instead of
// `devc web`'s own terminal, and the ancestor-repo guard's question is answered "no", so such a
// start fails with the guard's warning in its output rather than waiting on a prompt nobody
// sees.

import type { DevcontainerRunner } from '@devc-tools/core/devcontainer.ts';
import { startContainer, stopContainer } from '../container.ts';
import { currentRuntime, devcontainerArgv } from '../devcontainer_selfexec.ts';
import { splitLines } from './proc.ts';

/** How many trailing output lines a failed start's error message carries. */
const ERROR_TAIL_LINES = 5;

/** The CLI's self-exec runner, with its stderr sent to `onLine` instead of inherited. */
export function streamingRunner(
  onLine: (line: string) => void,
): DevcontainerRunner {
  return {
    async run(args) {
      const runtime = currentRuntime();
      const child = new Deno.Command(runtime.execPath, {
        args: devcontainerArgv(args, runtime),
        stdin: 'null',
        stdout: 'piped',
        stderr: 'piped',
      }).spawn();
      const stdout = new Response(child.stdout).text();
      for await (
        const line of splitLines(
          child.stderr.pipeThrough(new TextDecoderStream()),
        )
      ) {
        onLine(line);
      }
      const { code } = await child.status;
      return { code, stdout: await stdout };
    },
  };
}

/**
 * Starts (or creates) the container for `localFolder`. Rejects with the start's error plus the
 * last few output lines.
 */
export async function startProject(
  localFolder: string,
  onLine: (line: string) => void,
): Promise<void> {
  const tail: string[] = [];
  const emit = (text: string) => {
    for (const line of text.split('\n')) {
      tail.push(line);
      if (tail.length > ERROR_TAIL_LINES) tail.shift();
      onLine(line);
    }
  };
  try {
    await startContainer(localFolder, false, {
      devcontainer: streamingRunner(emit),
      guard: { confirm: () => Promise.resolve(false), warn: emit },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const lines = tail.filter((l) => l.trim() !== '' && l !== message);
    throw new Error([message, ...lines].join('\n'));
  }
}

/** Stops the project's container; `false` when none was running. */
export function stopProject(localFolder: string): Promise<boolean> {
  return stopContainer(localFolder);
}
