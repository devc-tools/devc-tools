import { assert, assertEquals } from 'jsr:@std/assert';
import {
  canonicalJson,
  launcherFlags,
  LspConfigStore,
  type LspProject,
  matchProject,
  normalizeRoot,
  optionsArg,
  parseLanguageServers,
  readLanguageServers,
  withProject,
  writeLanguageServers,
} from '../web/lsp_config.ts';
import { repoOverlayDir } from '@devc-tools/core/repo.ts';

const PATH = '/home/me/.config/devc/repos/app-1234abcd/language-servers.json';

function parse(data: unknown) {
  const warnings: string[] = [];
  const projects = parseLanguageServers(data, PATH, (l) => warnings.push(l));
  return { projects, warnings };
}

const PROJECTS: LspProject[] = [
  {
    language: 'python',
    root: 'py/server',
    options: { python: '/venv/bin/python' },
  },
  { language: 'python', root: 'py', options: {} },
  {
    language: 'java',
    root: '',
    options: { buildCommand: './gradlew compileJava' },
  },
];

Deno.test('matchProject: the longest root containing the file wins', () => {
  assertEquals(
    matchProject(PROJECTS, 'python', 'py/server/app/main.py'),
    PROJECTS[0],
  );
  assertEquals(matchProject(PROJECTS, 'python', 'py/client/x.py'), PROJECTS[1]);
  assertEquals(matchProject(PROJECTS, 'python', 'py/server'), PROJECTS[0]);
  // A path-segment prefix, not a string prefix.
  assertEquals(
    matchProject(PROJECTS, 'python', 'py/serverless/x.py'),
    PROJECTS[1],
  );
  assertEquals(matchProject(PROJECTS, 'python', 'pyx/x.py'), null);
});

Deno.test('matchProject: the "" root is the whole checkout', () => {
  assertEquals(
    matchProject(PROJECTS, 'java', 'src/main/java/A.java'),
    PROJECTS[2],
  );
  assertEquals(matchProject(PROJECTS, 'java', 'A.java'), PROJECTS[2]);
  assertEquals(launcherFlags(PROJECTS[2], '/workspaces/app'), [
    '--root',
    '/workspaces/app',
    '--options',
    optionsArg({ buildCommand: './gradlew compileJava' }),
  ]);
});

Deno.test('matchProject: no match means no flags (detection and defaults)', () => {
  assertEquals(matchProject(PROJECTS, 'typescript', 'web/a.ts'), null);
  assertEquals(matchProject([], 'python', 'a.py'), null);
  assertEquals(launcherFlags(null, '/workspaces/app'), []);
  const flags = launcherFlags(PROJECTS[0], '/workspaces/app/');
  assertEquals(flags.slice(0, 2), ['--root', '/workspaces/app/py/server']);
  // The options ride in as base64 of UTF-8 JSON.
  const decoded = new TextDecoder().decode(
    Uint8Array.from(atob(flags[3]), (c) => c.charCodeAt(0)),
  );
  assertEquals(JSON.parse(decoded), { python: '/venv/bin/python' });
  assertEquals(
    JSON.parse(new TextDecoder().decode(
      Uint8Array.from(
        atob(optionsArg({ name: 'café ☕' })),
        (c) => c.charCodeAt(0),
      ),
    )),
    { name: 'café ☕' },
  );
});

Deno.test('parseLanguageServers: a good file', () => {
  const { projects, warnings } = parse({
    version: 1,
    projects: [
      { language: 'python', root: 'py/server/', options: { python: '/x' } },
      { language: 'typescript', root: '.', options: {} },
    ],
  });
  assertEquals(warnings, []);
  assertEquals(projects, [
    { language: 'python', root: 'py/server', options: { python: '/x' } },
    { language: 'typescript', root: '', options: {} },
  ]);
});

Deno.test('parseLanguageServers: each bad entry is skipped alone, with one line naming the file', () => {
  const { projects, warnings } = parse({
    version: 1,
    projects: [
      { language: 'go', root: '', options: {} },
      { language: 'python', root: '../elsewhere', options: {} },
      { language: 'python', root: '/abs', options: {} },
      { language: 'python', root: 'ok', options: [] },
      'not an entry',
      { language: 'python', root: 'ok', options: {} },
      { language: 'python', root: 'ok/', options: { second: true } },
      { language: 'java', root: 'ok', options: {} },
    ],
  });
  assertEquals(projects, [
    { language: 'python', root: 'ok', options: {} },
    { language: 'java', root: 'ok', options: {} },
  ]);
  assertEquals(warnings.length, 6);
  for (const w of warnings) {
    assert(w.includes(PATH) || w.includes('language-servers.json'), w);
  }
  assert(warnings[0].includes('projects[0]') && warnings[0].includes('"go"'));
  assert(
    warnings[5].includes('projects[6]') && warnings[5].includes('repeats'),
  );
});

Deno.test('parseLanguageServers: a bad version, or not an object, ignores the whole file', () => {
  for (
    const data of [
      { version: 2, projects: [{ language: 'python', root: '', options: {} }] },
      { projects: [] },
      [],
      'x',
      null,
      { version: 1, projects: {} },
    ]
  ) {
    const { projects, warnings } = parse(data);
    assertEquals(projects, [], JSON.stringify(data));
    assertEquals(warnings.length, 1, JSON.stringify(data));
  }
});

Deno.test('normalizeRoot', () => {
  assertEquals(normalizeRoot(''), '');
  assertEquals(normalizeRoot('.'), '');
  assertEquals(normalizeRoot('./devc//web/'), 'devc/web');
  assertEquals(normalizeRoot('a/../b'), null);
  assertEquals(normalizeRoot('/a'), null);
});

Deno.test('canonicalJson: key-order independent, nested', () => {
  assertEquals(
    canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }),
    canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
  );
  assertEquals(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert(canonicalJson({ a: [1, 2] }) !== canonicalJson({ a: [2, 1] }));
  assertEquals(canonicalJson({}), '{}');
});

Deno.test('withProject: add, replace and remove (lsp_settings_set)', () => {
  const added = withProject(PROJECTS, 'typescript', 'web/a.ts', {
    root: 'web',
    options: {},
  });
  assertEquals(added.length, 4);
  assertEquals(added[3], { language: 'typescript', root: 'web', options: {} });
  const replaced = withProject(PROJECTS, 'python', 'py/server/x.py', {
    root: 'py/server',
    options: { python: '/other' },
  });
  assertEquals(replaced.length, 3);
  assertEquals(replaced[0], {
    language: 'python',
    root: 'py/server',
    options: { python: '/other' },
  });
  // null removes the entry that matches the file now (the longest root), and only it.
  const removed = withProject(PROJECTS, 'python', 'py/server/x.py', null);
  assertEquals(removed, [PROJECTS[1], PROJECTS[2]]);
  assertEquals(withProject(PROJECTS, 'typescript', 'a.ts', null), PROJECTS);
});

Deno.test('writeLanguageServers: an atomic write (temp file renamed over the old one)', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/repos/app-1/language-servers.json`;
    await writeLanguageServers(path, PROJECTS);
    const first = await Deno.stat(path);
    assertEquals(await readLanguageServers(path), PROJECTS);
    assertEquals(JSON.parse(await Deno.readTextFile(path)).version, 1);
    await writeLanguageServers(path, PROJECTS.slice(0, 1));
    const second = await Deno.stat(path);
    assert(
      first.ino !== second.ino,
      'replaced by rename, not rewritten in place',
    );
    const left = [...Deno.readDirSync(`${dir}/repos/app-1`)].map((e) => e.name);
    assertEquals(left, ['language-servers.json'], 'no temp file left');
    assertEquals(await readLanguageServers(path), PROJECTS.slice(0, 1));
    // Missing: no entries, no warning. Bad JSON: one warning.
    const warnings: string[] = [];
    assertEquals(
      await readLanguageServers(`${dir}/nope.json`, (l) => warnings.push(l)),
      [],
    );
    await Deno.writeTextFile(`${dir}/bad.json`, '{nope');
    assertEquals(
      await readLanguageServers(`${dir}/bad.json`, (l) => warnings.push(l)),
      [],
    );
    assertEquals(warnings.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('LspConfigStore: one file per repo, shared by its worktrees; cached; onChange on write', async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    const run = (args: string[], cwd: string) =>
      new Deno.Command('git', { args, cwd, stdout: 'null', stderr: 'null' })
        .output();
    const main = `${dir}/app`;
    await Deno.mkdir(`${main}/sub`, { recursive: true });
    await run(['init', '-q'], main);
    await run([
      '-c',
      'user.email=a@b',
      '-c',
      'user.name=a',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    ], main);
    await run(['worktree', 'add', '-q', `${dir}/app-wt`], main);
    const changes: string[] = [];
    const watches = new Map<string, () => void>();
    const store = new LspConfigStore({
      configDir: `${dir}/config`,
      onChange: (p) => changes.push(p),
      warn: () => {},
      watch: (path, onChange) => {
        watches.set(path, onChange);
        return { stop: () => watches.delete(path) };
      },
    });
    const a = await store.forFolder(`${main}/sub`);
    const b = await store.forFolder(`${dir}/app-wt`);
    assert(a && b);
    assertEquals(a.checkoutRoot, main);
    assertEquals(b.checkoutRoot, `${dir}/app-wt`);
    assertEquals(a.path, b.path);
    assertEquals(
      a.path,
      `${await repoOverlayDir(
        `${main}/.git`,
        `${dir}/config`,
      )}/language-servers.json`,
    );
    assertEquals(a.projects, []);
    assertEquals(watches.size, 0, 'no watch before the directory exists');
    await store.write(a.path, [{
      language: 'typescript',
      root: 'sub',
      options: {},
    }]);
    assertEquals(changes, [a.path]);
    assertEquals(
      [...watches.keys()],
      [a.path],
      'watched once the save made the directory',
    );
    assertEquals((await store.forFolder(`${dir}/app-wt`))?.projects, [
      { language: 'typescript', root: 'sub', options: {} },
    ]);
    assertEquals(await store.forFolder(dir), null, 'not in a repo');
    // An edit by hand: the watch re-reads the file, and onChange follows.
    await Deno.writeTextFile(
      a.path,
      JSON.stringify({
        version: 1,
        projects: [{ language: 'python', root: '', options: {} }],
      }),
    );
    watches.get(a.path)?.();
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(changes, [a.path, a.path]);
    assertEquals(await store.read(a.path), [{
      language: 'python',
      root: '',
      options: {},
    }]);
    store.stop();
    assertEquals(watches.size, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
