import { assertEquals } from 'jsr:@std/assert@^1';
import { hostSourceFromMount, parseMounts } from '../container.ts';

Deno.test('parseMounts maps a bind mount to the ContainerMount shape', () => {
  const json = JSON.stringify([
    {
      Type: 'bind',
      Source: '/host/workspaces/some-tool',
      Destination: '/workspaces/some-tool',
      Mode: '',
      RW: true,
      Propagation: 'rprivate',
    },
  ]);
  assertEquals(parseMounts(json), [
    {
      type: 'bind',
      source: '/host/workspaces/some-tool',
      destination: '/workspaces/some-tool',
      rw: true,
    },
  ]);
});

Deno.test('parseMounts maps a volume mount and preserves rw=false', () => {
  const json = JSON.stringify([
    {
      Type: 'volume',
      Name: 'my-vol',
      Source: '/var/lib/docker/volumes/my-vol/_data',
      Destination: '/data',
      Driver: 'local',
      Mode: 'z',
      RW: false,
      Propagation: '',
    },
  ]);
  assertEquals(parseMounts(json), [
    {
      type: 'volume',
      source: '/var/lib/docker/volumes/my-vol/_data',
      destination: '/data',
      rw: false,
    },
  ]);
});

Deno.test('parseMounts handles a mix of bind and volume mounts', () => {
  const json = JSON.stringify([
    { Type: 'bind', Source: '/a', Destination: '/x', RW: true },
    {
      Type: 'volume',
      Source: '/var/lib/docker/volumes/v/_data',
      Destination: '/y',
      RW: true,
    },
  ]);
  assertEquals(parseMounts(json), [
    { type: 'bind', source: '/a', destination: '/x', rw: true },
    {
      type: 'volume',
      source: '/var/lib/docker/volumes/v/_data',
      destination: '/y',
      rw: true,
    },
  ]);
});

Deno.test('parseMounts returns [] for null input', () => {
  assertEquals(parseMounts(null), []);
});

Deno.test('parseMounts returns [] for empty-string input', () => {
  assertEquals(parseMounts(''), []);
});

Deno.test('parseMounts returns [] for the JSON literal null', () => {
  assertEquals(parseMounts('null'), []);
});

Deno.test('parseMounts returns [] for unparseable input', () => {
  assertEquals(parseMounts('not json'), []);
});

// Docker Desktop runs the daemon in a Linux VM and reports bind sources as paths in *that*
// VM, grafted under `/host_mnt`. Measured on Docker Desktop for macOS, 2026-09-02.

Deno.test('hostSourceFromMount strips the /host_mnt graft point', () => {
  assertEquals(
    hostSourceFromMount('/host_mnt/Users/me/code/tools/devc-tools'),
    '/Users/me/code/tools/devc-tools',
  );
});

Deno.test('hostSourceFromMount leaves an already host-real source alone', () => {
  // The workspace folder mount comes back unprefixed, so both forms appear in one table.
  assertEquals(
    hostSourceFromMount('/Users/me/code/tools/devc-dev'),
    '/Users/me/code/tools/devc-dev',
  );
  assertEquals(
    hostSourceFromMount('/var/lib/docker/volumes/node-modules/_data'),
    '/var/lib/docker/volumes/node-modules/_data',
  );
});

Deno.test('hostSourceFromMount only strips at a segment boundary', () => {
  // A directory that merely starts with the same letters is not the graft point.
  assertEquals(hostSourceFromMount('/host_mnted/thing'), '/host_mnted/thing');
  assertEquals(hostSourceFromMount('/host_mnt2'), '/host_mnt2');
  // Nor is it stripped mid-path.
  assertEquals(
    hostSourceFromMount('/Users/me/host_mnt/x'),
    '/Users/me/host_mnt/x',
  );
});

Deno.test('hostSourceFromMount maps the bare graft point to the root', () => {
  assertEquals(hostSourceFromMount('/host_mnt'), '/');
  assertEquals(hostSourceFromMount('/host_mnt/'), '/');
});

Deno.test('parseMounts normalizes /host_mnt sources', () => {
  const json = JSON.stringify([
    {
      Type: 'bind',
      Source: '/host_mnt/Users/me/code/tools/devc-tools',
      Destination: '/workspaces/tools/devc-tools',
      RW: true,
    },
  ]);
  assertEquals(parseMounts(json), [
    {
      type: 'bind',
      source: '/Users/me/code/tools/devc-tools',
      destination: '/workspaces/tools/devc-tools',
      rw: true,
    },
  ]);
});

Deno.test('parseMounts handles a real Docker Desktop table carrying both forms', () => {
  // Trimmed from an actual `docker inspect` on Docker Desktop for macOS: the
  // devcontainer.json `mounts` entries are prefixed, the workspace folder mount is not,
  // and volumes are untouched either way.
  const json = JSON.stringify([
    {
      Type: 'bind',
      Source: '/host_mnt/Users/bingles/code/tools/devc-tools',
      Destination: '/workspaces/tools/devc-tools',
      RW: true,
    },
    {
      Type: 'bind',
      Source: '/host_mnt/Users/bingles/code/tools/devc-tools.worktrees',
      Destination: '/workspaces/tools/devc-tools.worktrees',
      RW: true,
    },
    {
      Type: 'bind',
      Source: '/Users/bingles/code/tools/devc-dev',
      Destination: '/workspaces/devc-dev',
      RW: true,
    },
    {
      Type: 'volume',
      Source: '/var/lib/docker/volumes/node-modules-devc-dev/_data',
      Destination: '/workspaces/devc-dev/node_modules',
      RW: true,
    },
  ]);
  assertEquals(parseMounts(json).map((m) => m.source), [
    '/Users/bingles/code/tools/devc-tools',
    '/Users/bingles/code/tools/devc-tools.worktrees',
    '/Users/bingles/code/tools/devc-dev',
    '/var/lib/docker/volumes/node-modules-devc-dev/_data',
  ]);
});
