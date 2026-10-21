// The risky part: editing JSONC files devc does not own. Every case here asserts both
// that our fence changed and that the user's bytes did not.

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from 'jsr:@std/assert@^1';
import {
  ensureArray,
  findArraySpan,
  findFence,
  normalizeArrayCommas,
  parseFenceEntries,
  parseJsonc,
  splitElements,
  stripComments,
  UnterminatedFenceError,
  writeBlocks,
} from '../jsonc_edit.ts';
import { fixture } from './helpers.ts';

function mountsOf(src: string): string[] {
  const parsed = parseJsonc(src) as { mounts: unknown[] };
  return parsed.mounts.map((
    m,
  ) => (typeof m === 'string' ? m : JSON.stringify(m)));
}

Deno.test('no-fence insert: both fences are appended, user elements untouched', async () => {
  const src = await fixture('mounts_two_objects.jsonc');
  const out = writeBlocks(src, 'mounts', [
    { id: 'projects', lines: [] },
    { id: 'skills', lines: [] },
  ]);

  // The two original elements survive byte-for-byte, comments and all.
  assertStringIncludes(
    out,
    '  // Hand-written mounts, as objects spanning several lines each.\n',
  );
  for (const n of ['one', 'two']) {
    assertStringIncludes(
      out,
      `    {\n      "type": "bind",\n      "source": "/host/${n}",\n      "target": "/container/${n}"\n    }`,
    );
  }
  assertStringIncludes(out, '  // >>> devc:projects (managed - do not edit)');
  assertStringIncludes(out, '  // <<< devc:skills');

  // Fences land in projects-then-skills order, inside the array.
  const span = findArraySpan(out, 'mounts')!;
  assert(out.indexOf('devc:projects') < out.indexOf('devc:skills'));
  assert(out.indexOf('devc:skills') < span.close);

  // Still strict JSON once comments are stripped, and no elements were added.
  const parsed = parseJsonc(out) as { mounts: unknown[]; remoteUser: string };
  assertEquals(parsed.mounts.length, 2);
  assertEquals(parsed.remoteUser, 'vscode');

  // Indentation is copied from the first existing element (4 spaces here).
  const withEntry = writeBlocks(src, 'mounts', [
    {
      id: 'projects',
      lines: ['"type=bind,source=/host/a,target=/workspaces/a"'],
    },
    { id: 'skills', lines: [] },
  ]);
  assertStringIncludes(
    withEntry,
    '\n    "type=bind,source=/host/a,target=/workspaces/a"\n',
  );
  assertEquals(mountsOf(withEntry).length, 3);
});

Deno.test('each open fence is preceded by a blank line, and re-writing keeps just one', async () => {
  const src = await fixture('mounts_two_objects.jsonc');
  const blocks = [
    {
      id: 'projects',
      lines: ['"type=bind,source=/host/a,target=/workspaces/a"'],
    },
    { id: 'skills', lines: [] },
  ];
  const out = writeBlocks(src, 'mounts', blocks);

  // One blank line above each open fence — the last user element, then a gap, then the fence;
  // and a gap between the two adjacent fences.
  assertStringIncludes(
    out,
    '\n\n    // >>> devc:projects (managed - do not edit)\n',
  );
  assertStringIncludes(
    out,
    '    // <<< devc:projects\n\n    // >>> devc:skills (managed - do not edit)\n',
  );
  assert(!out.includes('\n\n\n'));

  // Idempotent: the second write neither drops nor duplicates the blank lines.
  assertEquals(writeBlocks(out, 'mounts', blocks), out);

  // A fence that is the first thing in the array is not padded away from the `[`.
  const bare = writeBlocks('{\n  "mounts": []\n}\n', 'mounts', blocks);
  assertStringIncludes(
    bare,
    '"mounts": [\n    // >>> devc:projects (managed - do not edit)\n',
  );
  assertEquals(writeBlocks(bare, 'mounts', blocks), bare);
});

Deno.test('in-place rewrite: a fence between two user elements stays put', async () => {
  const src = await fixture('mounts_fence_between.jsonc');
  const out = writeBlocks(src, 'mounts', [{
    id: 'projects',
    lines: [
      '"type=bind,source=/root/projectb,target=/workspaces/projectb"',
      '"type=bind,source=/root/projectb.worktrees/x,target=/workspaces/projectb.worktrees/x"',
    ],
  }]);

  // User elements and their attached comments survive byte-for-byte.
  assertStringIncludes(
    out,
    '    // keep my ssh agent socket\n    "type=bind,source=/run/host-services/ssh-auth.sock,target=/ssh-agent",\n',
  );
  assertStringIncludes(
    out,
    '    // and my dotfiles\n    "type=bind,source=/home/me/.dotfiles,target=/home/vscode/.dotfiles"\n',
  );
  // The stale entry is gone and the new ones sit where the fence was.
  assert(!out.includes('/old/projecta'));

  const mounts = mountsOf(out);
  assertEquals(mounts, [
    'type=bind,source=/run/host-services/ssh-auth.sock,target=/ssh-agent',
    'type=bind,source=/root/projectb,target=/workspaces/projectb',
    'type=bind,source=/root/projectb.worktrees/x,target=/workspaces/projectb.worktrees/x',
    'type=bind,source=/home/me/.dotfiles,target=/home/vscode/.dotfiles',
  ]);

  // Rewriting the same content again is a no-op (idempotence).
  assertEquals(
    writeBlocks(out, 'mounts', [{
      id: 'projects',
      lines: [
        '"type=bind,source=/root/projectb,target=/workspaces/projectb"',
        '"type=bind,source=/root/projectb.worktrees/x,target=/workspaces/projectb.worktrees/x"',
      ],
    }]),
    out,
  );
});

Deno.test('empty fence: the preceding element loses its now-trailing comma', async () => {
  const src = await fixture('mounts_fence_last.jsonc');
  const out = writeBlocks(src, 'mounts', [{ id: 'projects', lines: [] }]);
  assertEquals(mountsOf(out), [
    'type=bind,source=/host/keep,target=/container/keep',
  ]);
  assertStringIncludes(
    out,
    '    "type=bind,source=/host/keep,target=/container/keep"\n',
  );
  assert(!out.includes('/container/keep",'));

  const span = findArraySpan(out, 'mounts')!;
  assertEquals(parseFenceEntries(out, span, 'projects'), []);
});

Deno.test('comma-hostile input round-trips: trailing comma, block comment, ] and // in a string', async () => {
  const src = await fixture('mounts_comma_hostile.jsonc');

  // The scanner is not fooled by `],` or `//` inside a string literal.
  const span = findArraySpan(src, 'mounts')!;
  assertEquals(splitElements(src, span).length, 2);

  const out = writeBlocks(src, 'mounts', [
    {
      id: 'projects',
      lines: ['"type=bind,source=/root/p,target=/workspaces/p"'],
    },
    { id: 'skills', lines: [] },
  ]);
  // Strict JSON once comments are gone: the trailing comma was normalized away, not tolerated.
  const parsed = JSON.parse(stripComments(out)) as {
    mounts: string[];
    runArgs: string[];
    name: string;
  };
  assertEquals(parsed.mounts, [
    'type=bind,source=/host/a],target=/x//y',
    'type=bind,source=/host/b,target=/y',
    'type=bind,source=/root/p,target=/workspaces/p',
  ]);
  assertEquals(parsed.runArgs, ['--rm', '--name=mounts']);
  assertEquals(parsed.name, 'hostile');
  assertStringIncludes(
    out,
    '    /* a block comment, with a comma and a ] in it */\n',
  );
});

Deno.test('normalizeArrayCommas only moves commas', () => {
  const src = '{\n  "a": [\n    1\n    2,\n    3,\n  ]\n}\n';
  const span = findArraySpan(src, 'a')!;
  const out = normalizeArrayCommas(src, span);
  assertEquals(out, '{\n  "a": [\n    1,\n    2,\n    3\n  ]\n}\n');
  assertEquals((JSON.parse(out) as { a: number[] }).a, [1, 2, 3]);
});

Deno.test('missing array: ensureArray inserts the key with the right comma', () => {
  const withMembers = '{\n  "name": "x"\n}\n';
  const a = ensureArray(withMembers, 'mounts');
  assertStringIncludes(a, '"mounts": [');
  assertStringIncludes(a, '],');
  assertEquals(
    (parseJsonc(a) as { mounts: unknown[]; name: string }).mounts,
    [],
  );
  assertEquals((parseJsonc(a) as { name: string }).name, 'x');

  const empty = ensureArray('{}\n', 'folders');
  assert(!empty.includes('],'), `unexpected comma in ${JSON.stringify(empty)}`);
  assertEquals((parseJsonc(empty) as { folders: unknown[] }).folders, []);

  // Already present ⇒ untouched.
  assertEquals(ensureArray(a, 'mounts'), a);

  // And a fence can be written into the array we just created.
  const out = writeBlocks(empty, 'folders', [{
    id: 'folders',
    lines: ['{ "path": "/workspaces/p", "name": "p" }'],
  }]);
  assertEquals((parseJsonc(out) as { folders: unknown[] }).folders, [
    { path: '/workspaces/p', name: 'p' },
  ]);
});

Deno.test('unterminated fence throws and nothing is written', async () => {
  const src = await fixture('mounts_unterminated.jsonc');
  const span = findArraySpan(src, 'mounts')!;
  assertThrows(() => findFence(src, span, 'projects'), UnterminatedFenceError);
  assertThrows(
    () => writeBlocks(src, 'mounts', [{ id: 'projects', lines: [] }]),
    UnterminatedFenceError,
  );
});

Deno.test('findArraySpan only matches a top-level array key', () => {
  const src = '{\n  "customizations": { "mounts": [1] },\n  "mounts": [2]\n}\n';
  const span = findArraySpan(src, 'mounts')!;
  assertEquals(src.slice(span.open, span.close + 1), '[2]');
  assertEquals(findArraySpan('{ "mounts": {} }', 'mounts'), null);
  assertEquals(findArraySpan('{ "name": "mounts" }', 'mounts'), null);
});

Deno.test('parseJsonc: comments and trailing commas, never inside a string', () => {
  assertEquals(
    parseJsonc(
      '{\n  // c\n  "a": [1, 2,], /* x\n y */ "b": {"c": "d",},\n}\n',
    ),
    { a: [1, 2], b: { c: 'd' } },
  );
  // Comment markers and `,]` inside strings are text.
  assertEquals(
    parseJsonc('{"u": "https://x//y", "s": "/* no */", "t": ",]"}'),
    {
      u: 'https://x//y',
      s: '/* no */',
      t: ',]',
    },
  );
  assertEquals(parseJsonc('{"q": "a\\",]", }'), { q: 'a",]' });
  assertThrows(() => parseJsonc('{"a": [1,,]}'), SyntaxError);
  assertThrows(() => parseJsonc('{"a" 1}'), SyntaxError);
});

Deno.test('parseJsonc: the cases shared with devc-desktop', async () => {
  // devc-desktop's copy of this parser runs the same file (devc-desktop/tests/launch.test.ts).
  const cases = JSON.parse(await fixture('jsonc_parse_cases.json')) as Array<
    { name: string; src: string; value?: unknown; throws?: boolean }
  >;
  for (const c of cases) {
    if (c.throws) assertThrows(() => parseJsonc(c.src), SyntaxError);
    else assertEquals(parseJsonc(c.src), c.value, c.name);
  }
});
