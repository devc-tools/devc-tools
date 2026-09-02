import { assertEquals } from 'jsr:@std/assert@^1';
import type { ContainerMount } from '../container.ts';
import {
  containerToHostPath,
  findMountForContainerPath,
  findMountForHostPath,
  hostToContainerPath,
} from '../mount_paths.ts';

function bind(source: string, destination: string): ContainerMount {
  return { type: 'bind', source, destination, rw: true };
}

function volume(source: string, destination: string): ContainerMount {
  return { type: 'volume', source, destination, rw: true };
}

// The shape of this workspace's own container: the two tool checkouts, the `.worktrees`
// sibling that makes dynamic worktrees visible, and a `node_modules` volume.
const workspace: ContainerMount[] = [
  bind('/Users/me/code/tools/devc-dev', '/workspaces/devc-dev'),
  bind('/Users/me/code/tools/devc-tools', '/workspaces/tools/devc-tools'),
  bind(
    '/Users/me/code/tools/devc-tools.worktrees',
    '/workspaces/tools/devc-tools.worktrees',
  ),
  volume(
    '/var/lib/docker/volumes/node-modules-abc/_data',
    '/workspaces/devc-dev/node_modules',
  ),
];

Deno.test('hostToContainerPath translates a path inside a bind mount', () => {
  assertEquals(
    hostToContainerPath('/Users/me/code/tools/devc-tools/devc-core', workspace),
    '/workspaces/tools/devc-tools/devc-core',
  );
});

Deno.test('containerToHostPath translates the other direction', () => {
  assertEquals(
    containerToHostPath('/workspaces/tools/devc-tools/devc-core', workspace),
    '/Users/me/code/tools/devc-tools/devc-core',
  );
});

Deno.test('a worktree under the .worktrees sibling translates', () => {
  assertEquals(
    hostToContainerPath(
      '/Users/me/code/tools/devc-tools.worktrees/feature-x',
      workspace,
    ),
    '/workspaces/tools/devc-tools.worktrees/feature-x',
  );
});

Deno.test('a covered path round-trips through both directions', () => {
  const hostPath = '/Users/me/code/tools/devc-tools.worktrees/feature-x/devc';
  const containerPath = hostToContainerPath(hostPath, workspace);
  assertEquals(
    containerPath,
    '/workspaces/tools/devc-tools.worktrees/feature-x/devc',
  );
  assertEquals(containerToHostPath(containerPath!, workspace), hostPath);
});

// Rule 1 — volumes are skipped in both directions.
Deno.test('a path under a volume destination does not translate', () => {
  assertEquals(
    containerToHostPath('/workspaces/devc-dev/node_modules/foo', workspace),
    // Falls back to the enclosing *bind* mount rather than the volume, because that is
    // the only mount that has a host path at all.
    '/Users/me/code/tools/devc-dev/node_modules/foo',
  );
});

Deno.test('a volume-only path translates in neither direction', () => {
  const mounts = [volume('/var/lib/docker/volumes/v/_data', '/data')];
  assertEquals(containerToHostPath('/data/thing', mounts), null);
  assertEquals(
    hostToContainerPath('/var/lib/docker/volumes/v/_data/thing', mounts),
    null,
  );
  assertEquals(findMountForContainerPath('/data', mounts), null);
});

// Rule 2 — longest match wins.
Deno.test('nested mounts resolve to the longer one', () => {
  const mounts = [
    bind('/host/workspaces', '/workspaces'),
    bind('/elsewhere/tools/x', '/workspaces/tools/x'),
  ];
  assertEquals(
    hostToContainerPath('/elsewhere/tools/x/src', mounts),
    '/workspaces/tools/x/src',
  );
  assertEquals(
    containerToHostPath('/workspaces/tools/x/src', mounts),
    '/elsewhere/tools/x/src',
  );
  // A sibling not covered by the deeper mount still resolves through the outer one.
  assertEquals(
    containerToHostPath('/workspaces/tools/y', mounts),
    '/host/workspaces/tools/y',
  );
});

Deno.test('nesting order in the table does not change the result', () => {
  const mounts = [
    bind('/elsewhere/tools/x', '/workspaces/tools/x'),
    bind('/host/workspaces', '/workspaces'),
  ];
  assertEquals(
    containerToHostPath('/workspaces/tools/x/src', mounts),
    '/elsewhere/tools/x/src',
  );
});

// Rule 3 — segment-aware matching, never a bare `startsWith`.
Deno.test('/a/bc does not match a mount at /a/b', () => {
  const mounts = [bind('/a/b', '/mnt/b')];
  assertEquals(hostToContainerPath('/a/bc', mounts), null);
  assertEquals(findMountForHostPath('/a/bc', mounts), null);
  assertEquals(containerToHostPath('/mnt/bc', mounts), null);
});

// Rule 4 — an exact match is valid and yields `relative: ''`.
Deno.test('the mount root itself matches, in both directions', () => {
  const mounts = [bind('/a/b', '/mnt/b')];
  assertEquals(findMountForHostPath('/a/b', mounts), {
    mount: mounts[0],
    relative: '',
  });
  assertEquals(hostToContainerPath('/a/b', mounts), '/mnt/b');
  assertEquals(findMountForContainerPath('/mnt/b', mounts), {
    mount: mounts[0],
    relative: '',
  });
  assertEquals(containerToHostPath('/mnt/b', mounts), '/a/b');
});

Deno.test('a trailing slash on the input still matches the mount root', () => {
  const mounts = [bind('/a/b', '/mnt/b')];
  assertEquals(hostToContainerPath('/a/b/', mounts), '/mnt/b');
});

Deno.test('a mount at the filesystem root resolves without a doubled slash', () => {
  const mounts = [bind('/', '/host')];
  assertEquals(hostToContainerPath('/etc/hosts', mounts), '/host/etc/hosts');
  assertEquals(containerToHostPath('/host/etc/hosts', mounts), '/etc/hosts');
  assertEquals(containerToHostPath('/host', mounts), '/');
});

// Rule 5 — inputs are normalized and `.`/`..` collapsed before matching.
Deno.test('dot segments are collapsed rather than matched literally', () => {
  assertEquals(
    hostToContainerPath(
      '/Users/me/code/tools/devc-tools/./devc-core/../devc',
      workspace,
    ),
    '/workspaces/tools/devc-tools/devc',
  );
});

Deno.test('.. cannot escape a mount by string trickery', () => {
  assertEquals(
    hostToContainerPath(
      '/Users/me/code/tools/devc-tools/../../../etc/passwd',
      workspace,
    ),
    null,
  );
});

Deno.test('backslashes are normalized to forward slashes', () => {
  const mounts = [bind('/a/b', '/mnt/b')];
  assertEquals(hostToContainerPath('\\a\\b\\c', mounts), '/mnt/b/c');
});

// Rule 6 — a non-absolute input returns null; there is no cwd to resolve against.
Deno.test('a relative input translates to null', () => {
  assertEquals(hostToContainerPath('devc-core/mod.ts', workspace), null);
  assertEquals(containerToHostPath('workspaces/tools', workspace), null);
  assertEquals(findMountForHostPath('.', workspace), null);
  assertEquals(hostToContainerPath('', workspace), null);
});

// Rule 7 — case is preserved and compared case-sensitively.
Deno.test('matching is case-sensitive and case is preserved', () => {
  const mounts = [bind('/Users/Me/Code', '/workspaces/Code')];
  assertEquals(hostToContainerPath('/users/me/code', mounts), null);
  assertEquals(
    hostToContainerPath('/Users/Me/Code/Thing', mounts),
    '/workspaces/Code/Thing',
  );
});

// Rule 8 — the table is taken as given; an empty one simply matches nothing.
Deno.test('an empty mount table matches nothing', () => {
  assertEquals(hostToContainerPath('/anywhere', []), null);
  assertEquals(findMountForContainerPath('/anywhere', []), null);
});

Deno.test('the match names the mount it resolved through', () => {
  const match = findMountForHostPath(
    '/Users/me/code/tools/devc-tools/devc-core/mod.ts',
    workspace,
  );
  assertEquals(match?.mount.destination, '/workspaces/tools/devc-tools');
  assertEquals(match?.relative, 'devc-core/mod.ts');
});
