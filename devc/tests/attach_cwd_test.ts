import { assertEquals } from 'jsr:@std/assert@^1';
import { attachExecArgs, resolveAttachCwd } from '../attach.ts';
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
};

Deno.test('attachExecArgs defaults -w to the container workspace folder', () => {
  assertEquals(
    attachExecArgs(info, ['-e', 'TERM=xterm'], ['/bin/bash', '-l']),
    [
      'exec',
      '-it',
      '-e',
      'TERM=xterm',
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

Deno.test('attachExecArgs uses cwd for -w when given', () => {
  const args = attachExecArgs(
    info,
    [],
    ['/bin/bash', '-lc', 'exec claude'],
    '/workspaces/tools/devc-tools.worktrees/feature-x',
  );
  assertEquals(
    args.slice(args.indexOf('-w'), args.indexOf('-w') + 2),
    ['-w', '/workspaces/tools/devc-tools.worktrees/feature-x'],
  );
  // The shell args stay last, after the container id.
  assertEquals(args.slice(-4), [
    'abc123',
    '/bin/bash',
    '-lc',
    'exec claude',
  ]);
});
