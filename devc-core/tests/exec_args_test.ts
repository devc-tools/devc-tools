import { assertEquals, assertThrows } from 'jsr:@std/assert@^1';
import {
  buildReadConfigArgs,
  type ContainerInfo,
  dockerExecArgv,
  loginShellArgv,
  parseReadConfiguration,
  resolveRemoteUserName,
} from '../container.ts';

const INFO: ContainerInfo = {
  containerId: 'cid',
  remoteUser: 'vscode',
  remoteWorkspaceFolder: '/workspaces/some-tool',
  remoteEnv: {},
};

/** The values of every `-e` flag, in order. */
function eFlags(args: string[]): string[] {
  return args.flatMap((a, i) => a === '-e' ? [args[i + 1]] : []);
}

Deno.test('dockerExecArgv: flag order, then the container id and cmd verbatim', () => {
  const cmd = ['bash', '-lc', "echo 'a b' && exit 3"];
  assertEquals(
    dockerExecArgv({ ...INFO, remoteEnv: { FOO: '1' } }, {
      interactive: true,
      cmd,
    }),
    [
      'exec',
      '-i',
      '-e',
      'FOO=1',
      '-u',
      'vscode',
      '-w',
      '/workspaces/some-tool',
      'cid',
      ...cmd,
    ],
  );
});

Deno.test('dockerExecArgv: -i/-t/-d only when asked', () => {
  const flags = (args: string[]) => args.slice(1, args.indexOf('-u'));
  assertEquals(flags(dockerExecArgv(INFO, { cmd: ['true'] })), []);
  assertEquals(
    flags(dockerExecArgv(INFO, { interactive: true, tty: true, cmd: [] })),
    ['-i', '-t'],
  );
  assertEquals(flags(dockerExecArgv(INFO, { detach: true, cmd: [] })), [
    '-d',
  ]);
});

Deno.test('dockerExecArgv: -w is cwd when given, the workspace folder otherwise', () => {
  const w = (args: string[]) => args[args.indexOf('-w') + 1];
  assertEquals(w(dockerExecArgv(INFO, { cmd: [] })), '/workspaces/some-tool');
  assertEquals(
    w(dockerExecArgv(INFO, { cwd: '/some/dir', cmd: [] })),
    '/some/dir',
  );
});

Deno.test('dockerExecArgv: envDefaults < remoteEnv < env, one -e per key', () => {
  const args = dockerExecArgv(
    { ...INFO, remoteEnv: { TERM: 'remote', PATH: '/usr/bin', KEEP: 'yes' } },
    {
      envDefaults: { TERM: 'host', ONLY_DEFAULT: 'd' },
      env: { PATH: '/override/bin' },
      cmd: ['true'],
    },
  );
  // Each key keeps the position of its first layer; the highest layer's value wins.
  assertEquals(eFlags(args), [
    'TERM=remote',
    'ONLY_DEFAULT=d',
    'PATH=/override/bin',
    'KEEP=yes',
  ]);
});

Deno.test('loginShellArgv: interactive, and script + args as $0/$@', () => {
  assertEquals(loginShellArgv(), ['/bin/bash', '-l']);
  assertEquals(loginShellArgv('exec "$0" "$@"', 'herdr', 'a b'), [
    '/bin/bash',
    '-lc',
    'exec "$0" "$@"',
    'herdr',
    'a b',
  ]);
});

Deno.test("buildReadConfigArgs: up's workspace and config flags, pointed at the container", () => {
  assertEquals(
    buildReadConfigArgs({
      localFolder: '/p',
      worktree: true,
      mergedConfigPath: '/c/devcontainer.json',
      mode: 'project',
      containerId: 'cid',
    }),
    [
      'read-configuration',
      '--workspace-folder',
      '/p',
      '--mount-git-worktree-common-dir',
      '--container-id',
      'cid',
      '--include-merged-configuration',
      '--override-config',
      '/c/devcontainer.json',
    ],
  );
  const zero = buildReadConfigArgs({
    localFolder: '/p',
    worktree: false,
    mergedConfigPath: '/c/devcontainer.json',
    mode: 'zero-config',
    containerId: 'cid',
  });
  assertEquals(zero.includes('--mount-git-worktree-common-dir'), false);
  assertEquals(zero.slice(-2), ['--config', '/c/devcontainer.json']);
  assertEquals(zero.includes('--no-lockfile'), false);
});

Deno.test('parseReadConfiguration: the workspace folder and merged remoteUser from the last line', () => {
  const out = 'noise\n' + JSON.stringify({
    configuration: {},
    workspace: { workspaceFolder: '/workspaces/app/sub' },
    mergedConfiguration: { remoteUser: 'node' },
  }) + '\n';
  assertEquals(parseReadConfiguration(out), {
    workspaceFolder: '/workspaces/app/sub',
    remoteUser: 'node',
  });
  assertEquals(
    parseReadConfiguration(
      JSON.stringify({ workspace: { workspaceFolder: '/w' } }),
    ),
    { workspaceFolder: '/w' },
  );
});

Deno.test('parseReadConfiguration: throws without a workspace folder or JSON', () => {
  assertThrows(() => parseReadConfiguration(''), Error, 'no configuration');
  assertThrows(
    () => parseReadConfiguration(JSON.stringify({ configuration: {} })),
    Error,
    'no workspace folder',
  );
});

Deno.test('resolveRemoteUserName: merged, then Config.User, then root; user part only', () => {
  assertEquals(resolveRemoteUserName('vscode', 'root'), 'vscode');
  assertEquals(resolveRemoteUserName(undefined, 'node'), 'node');
  assertEquals(resolveRemoteUserName(undefined, ''), 'root');
  assertEquals(resolveRemoteUserName('dev:staff', ''), 'dev');
  assertEquals(resolveRemoteUserName(undefined, '0:0'), 'root');
});
