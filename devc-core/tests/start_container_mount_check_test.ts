// `startContainer`'s mount checks end to end: the real merged config and the real pinned
// devcontainer CLI, with a stub `docker` on PATH that logs every invocation and answers the
// container lookup the CLI does before `initializeCommand`. Run in a child process, so the stub
// PATH and the temp HOME never reach the rest of the suite.

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1';
import { withTemp } from './helpers.ts';

/** Appends its argv to `$DOCKER_LOG`, one invocation per line; answers nothing. */
const DOCKER_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG"
`;

/**
 * `startContainer(proj, true)` with the project overlay's `mounts` set to `mounts`, in a child
 * process. Returns the rejection's message (or `''` if it resolved) and the docker log lines.
 */
async function start(
  dir: string,
  mounts: string[],
): Promise<{ message: string; log: string[] }> {
  const bin = `${dir}/bin`;
  const proj = `${dir}/proj`;
  const log = `${dir}/docker.log`;
  await Deno.mkdir(bin);
  await Deno.mkdir(`${proj}/.devcontainer`, { recursive: true });
  await Deno.mkdir(`${proj}/.devc`);
  await Deno.mkdir(`${dir}/home`);
  await Deno.writeTextFile(`${bin}/docker`, DOCKER_STUB, { mode: 0o755 });
  await Deno.writeTextFile(
    `${proj}/.devcontainer/devcontainer.json`,
    JSON.stringify({ image: 'x' }),
  );
  await Deno.writeTextFile(
    `${proj}/.devc/devc.json`,
    JSON.stringify({ mounts }),
  );
  await new Deno.Command('git', { args: ['-C', proj, 'init', '-q'] })
    .output();

  const module = JSON.stringify(
    new URL('../container.ts', import.meta.url).href,
  );
  const script = `
    import { startContainer } from ${module};
    let message = '';
    try {
      await startContainer(${JSON.stringify(proj)}, true);
    } catch (e) {
      message = e.message;
    }
    console.log(JSON.stringify({ message }));
  `;
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: [
      'eval',
      '--config',
      new URL('../deno.json', import.meta.url).pathname,
      script,
    ],
    env: {
      PATH: `${bin}:${Deno.env.get('PATH')}`,
      HOME: `${dir}/home`,
      DOCKER_LOG: log,
    },
  }).output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
  const lines = new TextDecoder().decode(stdout).trim().split('\n');
  const { message } = JSON.parse(lines[lines.length - 1]);
  let logText = '';
  try {
    logText = await Deno.readTextFile(log);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return { message, log: logText.split('\n').filter(Boolean) };
}

Deno.test('startContainer: a missing bind source stops up after initializeCommand, before any build', async () => {
  await withTemp(async (dir) => {
    const missing = `${dir}/nonexistent/devc-check`;
    const { message, log } = await start(dir, [
      `type=bind,source=${missing},target=/x`,
    ]);
    assertStringIncludes(message, 'bind mount source(s) missing on the host:');
    assertStringIncludes(message, `  ${missing} (target /x)`);
    // The CLI did run (its container lookup is logged), and stopped before touching anything.
    // `buildx version` is its capability probe, run before `initializeCommand`; not a build.
    assert(log.length > 0, 'want the CLI to have run');
    for (const line of log) {
      if (line === 'buildx version') continue;
      const verb = line.split(' ')[0];
      assert(
        !['build', 'buildx', 'rm', 'create', 'run'].includes(verb),
        `unexpected docker ${line}`,
      );
    }
  });
});

Deno.test('startContainer: a malformed mount is refused before the CLI runs', async () => {
  await withTemp(async (dir) => {
    const { message, log } = await start(dir, ['type=bind,target=/x']);
    assertStringIncludes(message, 'invalid mount(s) in the merged config');
    assertStringIncludes(
      message,
      '  type=bind,target=/x: bind mount has no source',
    );
    assertEquals(log, []);
  });
});
