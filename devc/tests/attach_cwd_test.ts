import { assertEquals } from 'jsr:@std/assert@^1';
import {
  attachExecArgs,
  describeBindMounts,
  resolveAttachCwd,
} from '../attach.ts';
import type { ContainerMount } from '@devc-tools/core/container.ts';

const mounts: ContainerMount[] = [
  {
    type: 'bind',
    source: '/Users/me/code/tools/devc-tools',
    destination: '/workspaces/tools/devc-tools',
    rw: true,
  },
  {
    type: 'bind',
    source: '/Users/me/code/tools/devc-tools.worktrees',
    destination: '/workspaces/tools/devc-tools.worktrees',
    rw: true,
  },
];

const never = () => false;
const always = () => true;

Deno.test('resolveAttachCwd translates a host path through the mount table', () => {
  assertEquals(
    resolveAttachCwd(
      '/Users/me/code/tools/devc-tools.worktrees/feature-x',
      mounts,
      always,
    ),
    {
      kind: 'container',
      containerPath: '/workspaces/tools/devc-tools.worktrees/feature-x',
    },
  );
});

Deno.test('resolveAttachCwd passes a container path through unchanged', () => {
  assertEquals(
    resolveAttachCwd('/workspaces/tools/devc-tools/devc', mounts, never),
    { kind: 'container', containerPath: '/workspaces/tools/devc-tools/devc' },
  );
});

Deno.test('resolveAttachCwd refuses a host path no mount covers', () => {
  assertEquals(
    resolveAttachCwd('/Users/me/elsewhere', mounts, always),
    { kind: 'unmounted', hostPath: '/Users/me/elsewhere' },
  );
});

Deno.test('resolveAttachCwd: the host reading wins when a path could be either', () => {
  // The value is a valid *container* path and also exists on the host — the documented
  // precedence refuses it rather than attaching to the similar-looking container path.
  assertEquals(
    resolveAttachCwd('/workspaces/tools/devc-tools', mounts, always),
    { kind: 'unmounted', hostPath: '/workspaces/tools/devc-tools' },
  );
});

Deno.test('resolveAttachCwd does not consult the host when a mount already matched', () => {
  let asked = 0;
  const result = resolveAttachCwd(
    '/Users/me/code/tools/devc-tools',
    mounts,
    () => {
      asked++;
      return true;
    },
  );
  assertEquals(result, {
    kind: 'container',
    containerPath: '/workspaces/tools/devc-tools',
  });
  assertEquals(asked, 0);
});

Deno.test('resolveAttachCwd with no mount table passes the value through', () => {
  assertEquals(resolveAttachCwd('/workspaces/x', null, never), {
    kind: 'container',
    containerPath: '/workspaces/x',
  });
});

const info = {
  containerId: 'abc123',
  remoteUser: 'vscode',
  remoteWorkspaceFolder: '/workspaces/devc-dev',
  remoteEnv: { TZ: 'Europe/Paris', TERM: 'from-remote-env' },
};

const hostEnv = (env: Record<string, string>) => (k: string) => env[k];

Deno.test('attachExecArgs: a plain attach is an interactive login shell in the workspace folder', () => {
  assertEquals(
    attachExecArgs(
      { ...info, remoteEnv: { TZ: 'Europe/Paris' } },
      {},
      hostEnv({ TERM: 'xterm' }),
    ),
    [
      'exec',
      '-i',
      '-t',
      '-e',
      'TERM=xterm',
      '-e',
      'TZ=Europe/Paris',
      '-e',
      'DEVC_ATTACH=1',
      '-u',
      'vscode',
      '-w',
      '/workspaces/devc-dev',
      'abc123',
      '/bin/bash',
      '-l',
    ],
  );
});

Deno.test('attachExecArgs: remoteEnv beats the host TERM; TMUX and the watch id ride above it', () => {
  const args = attachExecArgs(
    info,
    { herdr: { mode: 'watch', watchId: 'w1' } },
    hostEnv({ TERM: 'tmux-256color', TMUX: '/tmp/tmux-1/default,1,0' }),
  );
  const e = args.flatMap((a, i) => a === '-e' ? [args[i + 1]] : []);
  assertEquals(e.includes('TERM=from-remote-env'), true);
  assertEquals(e.includes('TERM=tmux-256color'), false);
  assertEquals(e.includes('TMUX=/tmp/tmux-1/default,1,0'), true);
  assertEquals(e.some((v) => v.endsWith('=w1')), true);
});

Deno.test('attachExecArgs uses cwd for -w, and a command runs in a login shell', () => {
  const args = attachExecArgs(
    info,
    {
      command: 'claude',
      commandArgs: ['--resume'],
      noClear: true,
      cwd: '/workspaces/tools/devc-tools.worktrees/feature-x',
    },
    hostEnv({}),
  );
  assertEquals(
    args.slice(args.indexOf('-w'), args.indexOf('-w') + 2),
    ['-w', '/workspaces/tools/devc-tools.worktrees/feature-x'],
  );
  // A command gets no DEVC_ATTACH, and the shell args stay last, after the container id.
  assertEquals(args.includes('DEVC_ATTACH=1'), false);
  assertEquals(args.slice(-6), [
    'abc123',
    '/bin/bash',
    '-lc',
    'exec "$0" "$@"',
    'claude',
    '--resume',
  ]);
});

// ---- describeBindMounts ------------------------------------------------------
// The first real failure of `--cwd` was caused by the mount sources themselves being
// surprising (Docker Desktop reported `/host_mnt/...` VM paths), and the error named only
// the rejected path — so there was no way to see that from the message. These lines are
// the diagnosis, which is why they are in the error rather than behind `devc mounts`.

Deno.test('describeBindMounts lists source -> destination, one per line', () => {
  assertEquals(
    describeBindMounts(mounts),
    '  /Users/me/code/tools/devc-tools -> /workspaces/tools/devc-tools\n' +
      '  /Users/me/code/tools/devc-tools.worktrees -> /workspaces/tools/devc-tools.worktrees',
  );
});

Deno.test('describeBindMounts omits volumes', () => {
  const withVolume: ContainerMount[] = [
    ...mounts,
    {
      type: 'volume',
      source: '/var/lib/docker/volumes/node-modules/_data',
      destination: '/workspaces/x/node_modules',
      rw: true,
    },
  ];
  const described = describeBindMounts(withVolume);
  assertEquals(described.includes('/var/lib/docker'), false);
  assertEquals(described.split('\n').length, 2);
});

Deno.test('describeBindMounts is empty when there is nothing to list', () => {
  assertEquals(describeBindMounts([]), '');
  assertEquals(
    describeBindMounts([{
      type: 'volume',
      source: '/var/lib/docker/volumes/v/_data',
      destination: '/data',
      rw: true,
    }]),
    '',
  );
});
