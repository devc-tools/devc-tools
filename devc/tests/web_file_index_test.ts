import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { join } from 'jsr:@std/path';
import { FilesError } from '../web/files.ts';
import {
  isIgnored,
  listRepoFiles,
  parseIgnore,
  parseIgnoreLine,
} from '../web/file_index.ts';

// The ignore table of `.plans/devc-web-file-palette.md`: [root lines, sub/ lines, path, dir,
// ignored].
const IGNORE_TABLE: [string[], string[], string, boolean, boolean][] = [
  [['node_modules/'], [], 'node_modules', true, true],
  [['node_modules/'], [], 'a/node_modules', true, true],
  [['node_modules/'], [], 'node_modules', false, false],
  [['/build'], [], 'build', true, true],
  [['/build'], [], 'a/build', true, false],
  [['*.log'], [], 'a/b/x.log', false, true],
  [['*.log', '!keep.log'], [], 'keep.log', false, false],
  [['docs/*.md'], [], 'docs/a.md', false, true],
  [['docs/*.md'], [], 'docs/x/a.md', false, false],
  [['**/tmp'], [], 'a/b/tmp', true, true],
  [['a/**/z'], [], 'a/z', false, true],
  [['a/**/z'], [], 'a/b/c/z', false, true],
  [['logs/**'], [], 'logs/x/y.txt', false, true],
  [['[ab].txt'], [], 'a.txt', false, true],
  [['[ab].txt'], [], 'c.txt', false, false],
  [['\\#notes'], [], '#notes', false, true],
  [['# notes'], [], '# notes', false, false],
  [['foo   '], [], 'foo', false, true],
  [[], ['*.gen.ts'], 'sub/x.gen.ts', false, true],
  [[], ['*.gen.ts'], 'x.gen.ts', false, false],
  [[], ['/out'], 'sub/out', true, true],
  [[], ['/out'], 'sub/a/out', true, false],
  [['*.md'], ['!a.md'], 'sub/a.md', false, false],
];

Deno.test('isIgnored follows every row of the ignore table', () => {
  for (const [rootLines, subLines, path, dir, ignored] of IGNORE_TABLE) {
    const rules = [
      ...parseIgnore(rootLines.join('\n'), ''),
      ...parseIgnore(subLines.join('\n'), 'sub'),
    ];
    assertEquals(
      isIgnored(rules, path, dir),
      ignored,
      `${JSON.stringify({ rootLines, subLines })} ${path} dir=${dir}`,
    );
  }
});

Deno.test('parseIgnoreLine: blanks, comments and unclosed classes hold no rule', () => {
  assertEquals(parseIgnoreLine('', ''), null);
  assertEquals(parseIgnoreLine('   ', ''), null);
  assertEquals(parseIgnoreLine('# x', ''), null);
  assertEquals(parseIgnoreLine('[ab', ''), null);
  assertEquals(parseIgnoreLine('x\\', ''), null);
});

Deno.test('parseIgnore: CRLF lines, escaped ! and spaces, classes', () => {
  const rules = parseIgnore('*.tmp\r\n\\!bang\nsp\\ \n[!a]x\n?y', '');
  assertEquals(isIgnored(rules, 'a.tmp', false), true);
  assertEquals(isIgnored(rules, '!bang', false), true);
  assertEquals(isIgnored(rules, 'sp ', false), true);
  assertEquals(isIgnored(rules, 'sp', false), false);
  assertEquals(isIgnored(rules, 'bx', false), true);
  assertEquals(isIgnored(rules, 'ax', false), false);
  assertEquals(isIgnored(rules, 'zy', false), true);
  assertEquals(isIgnored(rules, 'zzy', false), false);
});

/** A temp dir; `files` maps relative paths to contents (parent folders made). */
async function tree(files: Record<string, string>): Promise<string> {
  const root = await Deno.realPath(await Deno.makeTempDir());
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await Deno.mkdir(join(path, '..'), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
  return root;
}

Deno.test('listRepoFiles leaves out .git and folders holding a .git', async () => {
  const root = await tree({
    '.git/HEAD': 'ref',
    'a.ts': '',
    'sub/.git': 'gitdir: elsewhere',
    'sub/b.ts': '',
    'deep/x/.git': 'gitdir: elsewhere',
    'deep/y.ts': '',
  });
  try {
    assertEquals(await listRepoFiles(root), {
      files: ['a.ts', 'deep/y.ts'],
      truncated: false,
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('listRepoFiles lists a symlink to a file, not to a directory', async () => {
  const root = await tree({ 'src/a.ts': '' });
  try {
    await Deno.symlink('src/a.ts', join(root, 'link.ts'));
    await Deno.symlink('src', join(root, 'linkdir'));
    await Deno.symlink('missing', join(root, 'broken'));
    assertEquals((await listRepoFiles(root)).files, ['link.ts', 'src/a.ts']);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('listRepoFiles: an ignored directory stays out, re-included files and all', async () => {
  const root = await tree({
    '.gitignore': 'build/\n!build/keep.txt\n*.log\n',
    'build/keep.txt': '',
    'build/out.js': '',
    'x.log': '',
    'src/.gitignore': '*.gen.ts\n',
    'src/a.gen.ts': '',
    'src/a.ts': '',
    'a.gen.ts': '',
  });
  try {
    assertEquals((await listRepoFiles(root)).files, [
      '.gitignore',
      'a.gen.ts',
      'src/.gitignore',
      'src/a.ts',
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('listRepoFiles applies .git/info/exclude', async () => {
  const root = await tree({
    '.git/info/exclude': 'secret.txt\n',
    'secret.txt': '',
    'sub/secret.txt': '',
    'a.txt': '',
  });
  try {
    assertEquals((await listRepoFiles(root)).files, ['a.txt']);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('listRepoFiles sorts by code unit', async () => {
  const root = await tree({
    'a/b': '',
    'a.txt': '',
    'B.md': '',
    'a-z': '',
  });
  try {
    assertEquals((await listRepoFiles(root)).files, [
      'B.md',
      'a-z',
      'a.txt',
      'a/b',
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('listRepoFiles stops at maxFiles, truncated', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 10; i++) files[`d${i % 3}/f${i}.ts`] = '';
  const root = await tree(files);
  try {
    const result = await listRepoFiles(root, { maxFiles: 4 });
    assertEquals(result.truncated, true);
    assertEquals(result.files.length, 4);
    assertEquals(result.files, [
      'd0/f0.ts',
      'd0/f3.ts',
      'd0/f6.ts',
      'd0/f9.ts',
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('listRepoFiles: a missing root is not_found', async () => {
  const err = await assertRejects(
    () => listRepoFiles('/no/such/devc/root'),
    FilesError,
  );
  assertEquals(err.code, 'not_found');
});
