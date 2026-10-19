import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@^1';
import {
  displayPath,
  expandPath,
  globalConfigExists,
  loadGlobalConfig,
  makeGlobalConfig,
  saveGlobalConfig,
  webSourceFromConfig,
} from '../config.ts';
import { withTemp } from './helpers.ts';

Deno.test('expandPath: leading ~ and ~/ expand to $HOME', () => {
  const home = Deno.env.get('HOME')!;
  assertEquals(expandPath('~'), home);
  assertEquals(expandPath('~/code'), `${home}/code`);
  // A ~ that is not the first character is a literal.
  assertEquals(expandPath('/a/~/b'), '/a/~/b');
});

Deno.test('expandPath: $VAR and ${VAR} anywhere', () => {
  Deno.env.set('DEVC_TEST_ROOT', '/srv');
  try {
    assertEquals(expandPath('$DEVC_TEST_ROOT/x'), '/srv/x');
    assertEquals(expandPath('${DEVC_TEST_ROOT}/x'), '/srv/x');
  } finally {
    Deno.env.delete('DEVC_TEST_ROOT');
  }
});

Deno.test('expandPath: unset var throws naming the key', () => {
  Deno.env.delete('DEVC_TEST_MISSING');
  assertThrows(
    () => expandPath('$DEVC_TEST_MISSING/x'),
    Error,
    'DEVC_TEST_MISSING',
  );
});

Deno.test('displayPath collapses $HOME to ~', () => {
  const home = Deno.env.get('HOME')!;
  assertEquals(displayPath(`${home}/code`), '~/code');
  assertEquals(displayPath('/elsewhere'), '/elsewhere');
});

Deno.test('load/save round-trip stores raw, expands on read', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/config.json`;
    await saveGlobalConfig(makeGlobalConfig(['~/code'], [], path));

    const loaded = await loadGlobalConfig(path);
    // Raw, not expanded.
    assertEquals(loaded.codeRoots, ['~/code']);
    assertEquals(loaded.skillsRoots, []);
    // Expanded accessor.
    const home = Deno.env.get('HOME')!;
    assertEquals(loaded.codeRootsExpanded(), [`${home}/code`]);

    // Pretty JSON with trailing newline.
    const text = await Deno.readTextFile(path);
    assert(text.endsWith('\n'));
    assert(text.includes('  "codeRoots"'));
  });
});

Deno.test('unknown keys are preserved on rewrite', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/config.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify(
        { codeRoots: ['~/a'], skillsRoots: [], future: { x: 1 } },
        null,
        2,
      ) + '\n',
    );
    const loaded = await loadGlobalConfig(path);
    assertEquals(loaded.extra, { future: { x: 1 } });
    await saveGlobalConfig(loaded);
    const reread = await loadGlobalConfig(path);
    assertEquals(reread.extra, { future: { x: 1 } });
    assertEquals(reread.codeRoots, ['~/a']);
  });
});

Deno.test('missing/invalid file -> empty lists, no crash', async () => {
  await withTemp(async (dir) => {
    const missing = `${dir}/nope.json`;
    assertEquals(await globalConfigExists(missing), false);
    const loaded = await loadGlobalConfig(missing);
    assertEquals(loaded.codeRoots, []);
    assertEquals(loaded.skillsRoots, []);

    const bad = `${dir}/bad.json`;
    await Deno.writeTextFile(bad, '{not json');
    const loadedBad = await loadGlobalConfig(bad);
    assertEquals(loadedBad.codeRoots, []);
    assertEquals(loadedBad.skillsRoots, []);
  });
});

Deno.test('globalConfigExists true after save', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/config.json`;
    assertEquals(await globalConfigExists(path), false);
    await saveGlobalConfig(makeGlobalConfig([], [], path));
    assertEquals(await globalConfigExists(path), true);
  });
});

Deno.test('webSourceFromConfig: absent, expanded, preserved on save, and refused when bad', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/config.json`;
    const home = Deno.env.get('HOME')!;
    assertEquals(webSourceFromConfig(await loadGlobalConfig(path)), null);

    await Deno.writeTextFile(
      path,
      JSON.stringify({ codeRoots: [], webSource: '~/co/devc' }),
    );
    const cfg = await loadGlobalConfig(path);
    assertEquals(webSourceFromConfig(cfg), `${home}/co/devc`);
    // A wizard rewrite keeps it, as written.
    await saveGlobalConfig(
      makeGlobalConfig(['~/code'], [], path, cfg.extra, cfg.recentSkills),
    );
    assertEquals(
      JSON.parse(await Deno.readTextFile(path)).webSource,
      '~/co/devc',
    );

    for (const [value, ok] of [['', null], ['/abs/devc', '/abs/devc']]) {
      await Deno.writeTextFile(path, JSON.stringify({ webSource: value }));
      assertEquals(webSourceFromConfig(await loadGlobalConfig(path)), ok);
    }
    for (const bad of ['rel/devc', 7]) {
      await Deno.writeTextFile(path, JSON.stringify({ webSource: bad }));
      const loaded = await loadGlobalConfig(path);
      assertThrows(() => webSourceFromConfig(loaded), Error, 'webSource');
    }
  });
});
