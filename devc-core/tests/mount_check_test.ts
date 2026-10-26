import { assertEquals } from 'jsr:@std/assert@^1';
import {
  checkableBindMounts,
  missingMountSources,
  mountSpecProblems,
  withMountSourceCheck,
} from '../mount_check.ts';
import { withTemp } from './helpers.ts';

const FOLDER = '/home/me/src/proj';

function problems(mounts: unknown[], extra: Record<string, unknown> = {}) {
  return mountSpecProblems({ mounts, ...extra }, FOLDER);
}

// ── spec problems ───────────────────────────────────────────────────────────────────────────

Deno.test('each spec problem has its exact reason', () => {
  assertEquals(
    problems([
      42,
      ['type=bind'],
      'type=bind,source=/a',
      { type: 'bind', source: '/a', target: '' },
      'type=bind,source=/a,target=rel',
      'type=npipe,source=/a,target=/n',
      'type=bind,target=/b',
      'type=bind,source=,target=/b2',
      'type=bind,source=rel/a,target=/c',
      'type=tmpfs,source=/a,target=/t',
      'type=bind,source=/a,target=/d',
      'type=volume,source=v,target=/d/',
    ]),
    [
      { entry: '42', reason: 'not a mount spec' },
      { entry: '["type=bind"]', reason: 'not a mount spec' },
      { entry: 'type=bind,source=/a', reason: 'no target' },
      {
        entry: '{"type":"bind","source":"/a","target":""}',
        reason: 'no target',
      },
      {
        entry: 'type=bind,source=/a,target=rel',
        reason: 'target is not an absolute path',
      },
      {
        entry: 'type=npipe,source=/a,target=/n',
        reason: 'unsupported type "npipe"',
      },
      { entry: 'type=bind,target=/b', reason: 'bind mount has no source' },
      {
        entry: 'type=bind,source=,target=/b2',
        reason: 'bind mount has no source',
      },
      {
        entry: 'type=bind,source=rel/a,target=/c',
        reason: 'bind source is not an absolute path',
      },
      {
        entry: 'type=tmpfs,source=/a,target=/t',
        reason: 'tmpfs mount takes no source',
      },
      {
        entry: 'type=volume,source=v,target=/d/',
        reason: 'duplicate target /d/',
      },
    ],
  );
});

Deno.test('an entry reports only its first reason', () => {
  // Relative target, unsupported type, no source: only the target is named.
  assertEquals(problems(['type=weird,target=rel']), [
    {
      entry: 'type=weird,target=rel',
      reason: 'target is not an absolute path',
    },
  ]);
});

Deno.test('type defaults to bind, in both forms', () => {
  assertEquals(problems(['target=/x', { target: '/y' }]), [
    { entry: 'target=/x', reason: 'bind mount has no source' },
    { entry: '{"target":"/y"}', reason: 'bind mount has no source' },
  ]);
});

Deno.test('src= is a source; destination= and dst= are targets; keys are trimmed', () => {
  assertEquals(
    problems([
      'type=bind,src=/a,destination=/x',
      'type=bind, source=/b,dst=/y,readonly,consistency=cached,unknown=1',
    ]),
    [],
  );
  assertEquals(
    checkableBindMounts({
      mounts: ['type=bind,src=/a,destination=/x', 'type=bind,source=/b,dst=/y'],
    }, FOLDER),
    [{ source: '/a', target: '/x' }, { source: '/b', target: '/y' }],
  );
});

Deno.test('variables are substituted; one devc cannot resolve is skipped', () => {
  const home = Deno.env.get('HOME');
  Deno.env.set('HOME', '/home/tester');
  try {
    const config = {
      mounts: [
        'type=bind,source=${localEnv:HOME}/.config/x,target=/x',
        'type=bind,source=${localWorkspaceFolder}/y,target=${containerWorkspaceFolder}/y',
        'type=bind,source=${devcontainerId}-cache,target=/z',
        'type=bind,source=/a,target=${devcontainerId}',
      ],
    };
    assertEquals(mountSpecProblems(config, FOLDER), []);
    assertEquals(checkableBindMounts(config, FOLDER), [
      { source: '/home/tester/.config/x', target: '/x' },
      { source: `${FOLDER}/y`, target: '/workspaces/proj/y' },
      { source: '/a', target: '${devcontainerId}' },
    ]);
  } finally {
    if (home === undefined) Deno.env.delete('HOME');
    else Deno.env.set('HOME', home);
  }
});

Deno.test('a volume with no source and a tmpfs with a target are valid', () => {
  assertEquals(problems(['type=volume,target=/v', 'type=tmpfs,target=/t']), []);
  assertEquals(
    checkableBindMounts({
      mounts: ['type=volume,target=/v', 'type=tmpfs,target=/t'],
    }, FOLDER),
    [],
  );
});

Deno.test('workspaceMount is checked after mounts; an empty one is not', () => {
  assertEquals(
    problems(['type=bind,source=/a,target=/w'], {
      workspaceMount: 'type=bind,source=/b,target=/w',
    }),
    [{
      entry: 'type=bind,source=/b,target=/w',
      reason: 'duplicate target /w',
    }],
  );
  assertEquals(problems([], { workspaceMount: '' }), []);
});

// ── missing sources ─────────────────────────────────────────────────────────────────────────

Deno.test('missing sources: dirs and files exist, a missing path and a dangling link do not', async () => {
  await withTemp(async (dir) => {
    await Deno.mkdir(`${dir}/d`);
    await Deno.writeTextFile(`${dir}/f`, '');
    await Deno.symlink(`${dir}/nowhere`, `${dir}/link`);
    const config = {
      mounts: [
        `type=bind,source=${dir}/d,target=/d`,
        `type=bind,source=${dir}/f,target=/f`,
        `type=bind,source=${dir}/missing,target=/m`,
        `type=bind,source=${dir}/link,target=/l`,
        // Malformed, so never checked for existence.
        `type=bind,source=${dir}/missing2`,
      ],
    };
    assertEquals(missingMountSources(config, FOLDER), [
      { source: `${dir}/missing`, target: '/m' },
      { source: `${dir}/link`, target: '/l' },
    ]);
  });
});

// ── the initializeCommand rewrite ───────────────────────────────────────────────────────────

const BINDS = [{ source: '/src/a', target: '/a' }];
const CHECK = [
  'devc_missing=0',
  "[ -e '/src/a' ] || { printf 'devc: bind mount source does not exist: %s (target %s)\\n' '/src/a' '/a' >&2; devc_missing=1; }",
  `[ "$devc_missing" -eq 0 ] || { printf '%s\\n' 'devc: stopping before the image build - create the missing path(s) or fix the mount, then run devc again' >&2; exit 1; }`,
].join('\n');

Deno.test('rewrite: absent, null, empty string and empty array get the check alone', () => {
  for (const original of [undefined, null, '', []]) {
    assertEquals(withMountSourceCheck(original, BINDS, 'linux'), CHECK);
  }
});

Deno.test('rewrite: a string runs first, in a subshell', () => {
  assertEquals(
    withMountSourceCheck(
      'bash "${localWorkspaceFolder}/init.sh"',
      BINDS,
      'linux',
    ),
    `(\nbash "\${localWorkspaceFolder}/init.sh"\n) || exit $?\n${CHECK}`,
  );
});

Deno.test('rewrite: an array is shell-quoted', () => {
  assertEquals(
    withMountSourceCheck(['bash', '-c', "echo 'hi'"], BINDS, 'linux'),
    `'bash' '-c' 'echo '\\''hi'\\''' || exit $?\n${CHECK}`,
  );
});

Deno.test('rewrite: object form, no binds and win32 are left unchanged', () => {
  const object = { a: 'one', b: 'two' };
  assertEquals(withMountSourceCheck(object, BINDS, 'linux'), object);
  assertEquals(withMountSourceCheck('setup.sh', [], 'linux'), 'setup.sh');
  assertEquals(withMountSourceCheck(undefined, [], 'linux'), undefined);
  assertEquals(withMountSourceCheck('setup.sh', BINDS, 'win32'), 'setup.sh');
});

Deno.test("rewrite: a source containing ' is quoted", () => {
  assertEquals(
    withMountSourceCheck(
      undefined,
      [{ source: "/it's", target: '/t' }],
      'linux',
    ),
    [
      'devc_missing=0',
      "[ -e '/it'\\''s' ] || { printf 'devc: bind mount source does not exist: %s (target %s)\\n' '/it'\\''s' '/t' >&2; devc_missing=1; }",
      CHECK.split('\n')[2],
    ].join('\n'),
  );
});

// ── the rewrite, run ────────────────────────────────────────────────────────────────────────

async function sh(command: string, cwd: string) {
  const { code, stderr } = await new Deno.Command('/bin/sh', {
    args: ['-c', command],
    cwd,
  }).output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

const STOPPING =
  'devc: stopping before the image build - create the missing path(s) or fix the mount, then run devc again\n';

Deno.test('run: every source present exits 0, silently', async () => {
  await withTemp(async (dir) => {
    await Deno.mkdir(`${dir}/a`);
    await Deno.writeTextFile(`${dir}/it's`, '');
    const cmd = withMountSourceCheck('true', [
      { source: `${dir}/a`, target: '/a' },
      { source: `${dir}/it's`, target: '/b' },
    ], 'linux') as string;
    assertEquals(await sh(cmd, dir), { code: 0, stderr: '' });
  });
});

Deno.test('run: a missing source exits 1, naming it', async () => {
  await withTemp(async (dir) => {
    await Deno.mkdir(`${dir}/a`);
    const cmd = withMountSourceCheck(undefined, [
      { source: `${dir}/a`, target: '/a' },
      { source: `${dir}/gone`, target: '/g' },
    ], 'linux') as string;
    assertEquals(await sh(cmd, dir), {
      code: 1,
      stderr:
        `devc: bind mount source does not exist: ${dir}/gone (target /g)\n${STOPPING}`,
    });
  });
});

Deno.test('run: exit 0 in the original cannot skip the check', async () => {
  await withTemp(async (dir) => {
    const cmd = withMountSourceCheck('exit 0', [
      { source: `${dir}/gone`, target: '/g' },
    ], 'linux') as string;
    assertEquals((await sh(cmd, dir)).code, 1);
  });
});

Deno.test("run: the original's failure stops with its own status, before the check", async () => {
  await withTemp(async (dir) => {
    const cmd = withMountSourceCheck('exit 7', [
      { source: `${dir}/gone`, target: '/g' },
    ], 'linux') as string;
    assertEquals(await sh(cmd, dir), { code: 7, stderr: '' });
  });
});

Deno.test('run: an original that creates the source passes', async () => {
  await withTemp(async (dir) => {
    const cmd = withMountSourceCheck(`mkdir -p '${dir}/made'`, [
      { source: `${dir}/made`, target: '/m' },
    ], 'linux') as string;
    assertEquals(await sh(cmd, dir), { code: 0, stderr: '' });
  });
});
