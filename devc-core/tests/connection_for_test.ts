// `connectionFor` end to end: the real merged config and the real pinned devcontainer CLI
// (`read-configuration --container-id`), with a stub `docker` on PATH standing in for one running
// container. Run in a child process, so the stub PATH and the temp HOME (where
// `ensureMergedConfig` writes its cache) never reach the rest of the suite.

import { assertEquals } from 'jsr:@std/assert@^1';
import { withTemp } from './helpers.ts';

const CONTAINER_JSON = JSON.stringify([{
  Id: 'abc123',
  Created: '2026-01-01T00:00:00Z',
  Name: '/x',
  Image: 'img',
  State: { Status: 'running', StartedAt: '2026-01-01T00:00:00Z' },
  Config: {
    User: 'root',
    Env: ['PATH=/usr/bin', 'FOO=bar'],
    Labels: {
      'devcontainer.metadata': JSON.stringify([{ remoteUser: 'vscode' }]),
    },
  },
  Mounts: [],
  NetworkSettings: { Ports: {} },
  HostConfig: {},
}]);

// `inspect --format` answers devc's own two inspects; a bare `inspect` is the CLI's.
const DOCKER_STUB = `#!/bin/sh
case "$1 $3" in
  "inspect {{.Config.User}}") echo root ;;
  "inspect {{json .Config.Env}}") echo '["PATH=/usr/bin","FOO=bar"]' ;;
  inspect*) cat <<'J'
${CONTAINER_JSON}
J
  ;;
esac
`;

Deno.test('connectionFor: workspace folder and user from read-configuration, remoteEnv resolved', async () => {
  await withTemp(async (dir) => {
    const bin = `${dir}/bin`;
    const proj = `${dir}/proj`;
    await Deno.mkdir(bin);
    await Deno.mkdir(`${proj}/.devcontainer`, { recursive: true });
    await Deno.mkdir(`${dir}/home`);
    await Deno.writeTextFile(`${bin}/docker`, DOCKER_STUB, { mode: 0o755 });
    await Deno.writeTextFile(
      `${proj}/.devcontainer/devcontainer.json`,
      JSON.stringify({
        image: 'x',
        workspaceFolder: '/workspaces/proj/sub',
        remoteEnv: {
          TZ: '${localEnv:CONN_TEST_TZ:America/New_York}',
          PROJECT_PATH: '${containerWorkspaceFolder}',
          FROM_CONTAINER: '${containerEnv:FOO}',
        },
      }),
    );
    await new Deno.Command('git', { args: ['-C', proj, 'init', '-q'] })
      .output();

    const module = JSON.stringify(
      new URL('../container.ts', import.meta.url).href,
    );
    const folder = JSON.stringify(proj);
    const script = `
      import { connectionFor } from ${module};
      console.log(JSON.stringify(await connectionFor(${folder}, 'abc123')));
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
        CONN_TEST_TZ: 'Europe/Paris',
      },
    }).output();
    assertEquals(code, 0, new TextDecoder().decode(stderr));
    const lines = new TextDecoder().decode(stdout).trim().split('\n');
    assertEquals(JSON.parse(lines[lines.length - 1]), {
      containerId: 'abc123',
      // The container's metadata, not its Config.User.
      remoteUser: 'vscode',
      remoteWorkspaceFolder: '/workspaces/proj/sub',
      remoteEnv: {
        TZ: 'Europe/Paris',
        PROJECT_PATH: '/workspaces/proj/sub',
        FROM_CONTAINER: 'bar',
      },
    });
  });
});
