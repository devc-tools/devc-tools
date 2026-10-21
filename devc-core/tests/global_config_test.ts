import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from 'jsr:@std/assert@^1';
import {
  bridgeDefaultAllowFromConfig,
  bridgeRepoAllowFromConfig,
  displayPath,
  expandPath,
  globalConfigExists,
  jiraFromConfig,
  loadGlobalConfig,
  makeGlobalConfig,
  resolveGlobalConfigPath,
  saveGlobalConfig,
  webSourceFromConfig,
} from '../config.ts';
import { parseJsonc } from '../jsonc_edit.ts';
import { setLogger } from '../log.ts';
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

Deno.test('jiraFromConfig: absent, valid, preserved on save, and each refusal', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/config.json`;
    const load = async (jira: unknown) => {
      await Deno.writeTextFile(path, JSON.stringify({ jira }));
      return await loadGlobalConfig(path);
    };
    assertEquals(jiraFromConfig(await loadGlobalConfig(path)), null);
    assertEquals(jiraFromConfig(await load(null)), null);

    const jira = {
      pattern: 'AB-\\d+',
      url: 'https://acme.atlassian.net/browse/{key}',
    };
    const cfg = await load(jira);
    assertEquals(jiraFromConfig(cfg), jira);
    // A wizard rewrite keeps it, as written.
    await saveGlobalConfig(
      makeGlobalConfig(['~/code'], [], path, cfg.extra, cfg.recentSkills),
    );
    assertEquals(JSON.parse(await Deno.readTextFile(path)).jira, jira);

    const url = jira.url;
    for (
      const [value, message] of [
        [['x'], '"jira" must be an object'],
        ['x', '"jira" must be an object'],
        [{ url }, '"jira.pattern" must be a non-empty string'],
        [{ pattern: '', url }, '"jira.pattern" must be a non-empty string'],
        [
          { pattern: '(', url },
          '"jira.pattern" is not a valid regular expression: ',
        ],
        [
          { pattern: 'AB-\\d*|', url },
          '"jira.pattern" must not match an empty string',
        ],
        [{ pattern: 'AB', url: 7 }, '"jira.url" must be an http(s) URL'],
        [
          { pattern: 'AB', url: 'not a url' },
          '"jira.url" must be an http(s) URL',
        ],
        [
          { pattern: 'AB', url: 'javascript:alert({key})' },
          '"jira.url" must be an http(s) URL',
        ],
        [
          { pattern: 'AB', url: 'https://acme.atlassian.net/browse/' },
          '"jira.url" must contain {key}',
        ],
      ] as const
    ) {
      const loaded = await load(value);
      assertThrows(
        () => jiraFromConfig(loaded),
        Error,
        `${displayPath(path)}: ${message}`,
      );
    }
  });
});

Deno.test('bridgeDefaultAllowFromConfig: raw, and a load and save keeps it unchanged', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/config.json`;
    assertEquals(
      bridgeDefaultAllowFromConfig(await loadGlobalConfig(path)),
      undefined,
    );
    // Kept exactly as written, even a value devc would refuse: only `up`/`build` validate it.
    for (const value of [[' gh-pr-viewed', 'gh-pr-read', 'gh-pr-read'], 'gh']) {
      const text = JSON.stringify(
        {
          codeRoots: ['~/a'],
          skillsRoots: [],
          recentSkills: [],
          bridgeDefaultAllow: value,
        },
        null,
        2,
      ) + '\n';
      await Deno.writeTextFile(path, text);
      const cfg = await loadGlobalConfig(path);
      assertEquals(bridgeDefaultAllowFromConfig(cfg), value);
      // The wizard's save path: fresh lists, the loaded extras.
      await saveGlobalConfig(
        makeGlobalConfig(
          cfg.codeRoots,
          cfg.skillsRoots,
          path,
          cfg.extra,
          cfg.recentSkills,
        ),
      );
      assertEquals(await Deno.readTextFile(path), text);
    }
  });
});

Deno.test('bridgeRepoAllowFromConfig: raw, and a load and save keeps it unchanged', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/config.json`;
    assertEquals(
      bridgeRepoAllowFromConfig(await loadGlobalConfig(path)),
      undefined,
    );
    // Kept exactly as written, even a value devc would refuse: only `up`/`build` validate it.
    for (
      const value of [
        {
          '~/code/shared-lib': ['gh-pr-reply', 'gh-pr-read'],
          '~/code/secrets': [],
        },
        ['not', 'an', 'object'],
      ]
    ) {
      const text = JSON.stringify(
        {
          codeRoots: ['~/a'],
          skillsRoots: [],
          recentSkills: [],
          bridgeDefaultAllow: ['gh-pr-read'],
          bridgeRepoAllow: value,
        },
        null,
        2,
      ) + '\n';
      await Deno.writeTextFile(path, text);
      const cfg = await loadGlobalConfig(path);
      assertEquals(bridgeRepoAllowFromConfig(cfg), value);
      await saveGlobalConfig(
        makeGlobalConfig(
          cfg.codeRoots,
          cfg.skillsRoots,
          path,
          cfg.extra,
          cfg.recentSkills,
        ),
      );
      assertEquals(await Deno.readTextFile(path), text);
    }
  });
});

/** Run `fn`, returning every warning core logged meanwhile. */
async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  setLogger((level, message) => {
    if (level === 'warning') seen.push(message);
  });
  try {
    await fn();
  } finally {
    setLogger(null);
  }
  return seen;
}

/** Load the config the resolver picks in `dir`, as a command does. */
async function loadIn(dir: string) {
  return await loadGlobalConfig(await resolveGlobalConfigPath(dir));
}

Deno.test('config file choice: only config.json is read', async () => {
  await withTemp(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/config.json`,
      JSON.stringify({ codeRoots: ['~/json'] }),
    );
    const cfg = await loadIn(dir);
    assertEquals(cfg.path, `${dir}/config.json`);
    assertEquals(cfg.codeRoots, ['~/json']);
  });
});

Deno.test('config file choice: only config.jsonc, with comments and trailing commas, is read', async () => {
  await withTemp(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/config.jsonc`,
      [
        '// my devc config',
        '{',
        '  /* roots,',
        '     across lines */',
        '  "codeRoots": ["~/a", "~/b",], // trailing',
        '  "webSource": "https://example.com//x", // a // in a string stays',
        '}',
        '',
      ].join('\n'),
    );
    const cfg = await loadIn(dir);
    assertEquals(cfg.path, `${dir}/config.jsonc`);
    assertEquals(cfg.codeRoots, ['~/a', '~/b']);
    assertEquals(cfg.extra, { webSource: 'https://example.com//x' });
  });
});

Deno.test('config file choice: both -> config.jsonc only, and the ignored notice once', async () => {
  await withTemp(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/config.json`,
      JSON.stringify({ codeRoots: ['~/json'], bridgeDefaultAllow: ['x'] }),
    );
    await Deno.writeTextFile(
      `${dir}/config.jsonc`,
      '{ "skillsRoots": ["~/s"] }',
    );
    const loads: Array<Awaited<ReturnType<typeof loadIn>>> = [];
    const warnings = await captureWarnings(async () => {
      loads.push(await loadIn(dir));
      loads.push(await loadIn(dir));
    });
    for (const cfg of loads) {
      assertEquals(cfg.path, `${dir}/config.jsonc`);
      assertEquals(cfg.codeRoots, []);
      assertEquals(cfg.skillsRoots, ['~/s']);
      assertEquals(cfg.extra, {});
    }
    assertEquals(warnings, [
      `devc: ${displayPath(`${dir}/config.json`)} is ignored because ${
        displayPath(`${dir}/config.jsonc`)
      } exists`,
    ]);
  });
});

Deno.test('config file choice: a symlinked config.jsonc counts', async () => {
  await withTemp(async (dir) => {
    await Deno.writeTextFile(`${dir}/real.jsonc`, '{"codeRoots": ["~/l"]}');
    await Deno.symlink(`${dir}/real.jsonc`, `${dir}/config.jsonc`);
    const cfg = await loadIn(dir);
    assertEquals(cfg.path, `${dir}/config.jsonc`);
    assertEquals(cfg.codeRoots, ['~/l']);
  });
});

Deno.test('config file choice: neither -> empty, and path is config.json', async () => {
  await withTemp(async (dir) => {
    const warnings = await captureWarnings(async () => {
      const cfg = await loadIn(dir);
      assertEquals(cfg.path, `${dir}/config.json`);
      assertEquals(cfg.codeRoots, []);
      assertEquals(cfg.extra, {});
    });
    assertEquals(warnings, []);
  });
});

Deno.test('an invalid config.jsonc loads empty, with the invalid notice once', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/config.jsonc`;
    await Deno.writeTextFile(path, '{ "codeRoots": ["~/a" "~/b"] }');
    const warnings = await captureWarnings(async () => {
      for (let i = 0; i < 2; i++) {
        const cfg = await loadIn(dir);
        assertEquals(cfg.path, path);
        assertEquals(cfg.codeRoots, []);
        assertEquals(cfg.extra, {});
      }
    });
    assertEquals(warnings.length, 1);
    assert(
      warnings[0].startsWith(`devc: ${displayPath(path)}: not valid JSONC (`),
      warnings[0],
    );
    assert(warnings[0].endsWith('), ignored'), warnings[0]);

    // Valid JSONC that is not an object is refused the same way.
    const arr = `${dir}/array.jsonc`;
    await Deno.writeTextFile(arr, '["~/a"]');
    const arrWarnings = await captureWarnings(async () => {
      assertEquals((await loadGlobalConfig(arr)).codeRoots, []);
    });
    assertEquals(arrWarnings, [
      `devc: ${displayPath(arr)}: not valid JSONC (not a JSON object), ignored`,
    ]);
  });
});

const COMMENTED_JSONC = [
  '// devc global config',
  '{',
  '  // where my code lives',
  '  "codeRoots": [',
  '    "~/code", // main',
  '    /* old */ "~/work",',
  '  ],',
  '  "skillsRoots": [],',
  '  "recentSkills": ["~/skills/a"],',
  '  // not a devc key yet',
  '  "future": { "x": 1 },',
  '  "bridgeRepoAllow": {',
  '    "~/code/lib": ["gh-pr-read"], // reviews only',
  '  },',
  '}',
  '',
].join('\n');

Deno.test('saving a .jsonc changes only the bytes inside the changed array', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/config.jsonc`;
    await Deno.writeTextFile(path, COMMENTED_JSONC);
    const cfg = await loadGlobalConfig(path);
    assertEquals(cfg.codeRoots, ['~/code', '~/work']);
    assertEquals(cfg.recentSkills, ['~/skills/a']);
    await saveGlobalConfig(
      makeGlobalConfig(cfg.codeRoots, cfg.skillsRoots, path, cfg.extra, [
        '~/skills/b',
        '~/skills/"q"',
      ]),
    );
    const out = await Deno.readTextFile(path);
    const marker = '"recentSkills": [';
    const open = COMMENTED_JSONC.indexOf(marker) + marker.length;
    const close = COMMENTED_JSONC.indexOf(']', open);
    const outClose = out.lastIndexOf(
      COMMENTED_JSONC.slice(close),
    );
    // Everything before the `[` and from the `]` on is byte-identical.
    assertEquals(out.slice(0, open), COMMENTED_JSONC.slice(0, open));
    assertEquals(out.slice(outClose), COMMENTED_JSONC.slice(close));
    assertEquals(
      out.slice(open, outClose),
      '\n    "~/skills/b",\n    "~/skills/\\"q\\""\n  ',
    );
    // It parses, and loads back to the new value with everything else intact.
    parseJsonc(out);
    const back = await loadGlobalConfig(path);
    assertEquals(back.recentSkills, ['~/skills/b', '~/skills/"q"']);
    assertEquals(back.codeRoots, ['~/code', '~/work']);
    assertEquals(back.extra, cfg.extra);
  });
});

Deno.test('saving a .jsonc inserts a missing key first and keeps every other byte', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/config.jsonc`;
    const text = COMMENTED_JSONC.replace('  "skillsRoots": [],\n', '');
    await Deno.writeTextFile(path, text);
    const cfg = await loadGlobalConfig(path);
    await saveGlobalConfig(
      makeGlobalConfig(
        cfg.codeRoots,
        ['~/skills'],
        path,
        cfg.extra,
        cfg.recentSkills,
      ),
    );
    const out = await Deno.readTextFile(path);
    const brace = text.indexOf('{') + 1;
    const inserted = '\n  "skillsRoots": [\n    "~/skills"\n  ],';
    assertEquals(
      out,
      text.slice(0, brace) + inserted + text.slice(brace),
    );
    assertEquals((await loadGlobalConfig(path)).skillsRoots, ['~/skills']);
  });
});

Deno.test('saving a .jsonc with nothing changed leaves it byte-identical', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/config.jsonc`;
    // No `skillsRoots` at all: absent and still empty is not a change.
    const text = COMMENTED_JSONC.replace('  "skillsRoots": [],\n', '');
    await Deno.writeTextFile(path, text);
    const cfg = await loadGlobalConfig(path);
    await saveGlobalConfig(cfg);
    await saveGlobalConfig(
      makeGlobalConfig(
        cfg.codeRoots,
        cfg.skillsRoots,
        path,
        cfg.extra,
        cfg.recentSkills,
      ),
    );
    assertEquals(await Deno.readTextFile(path), text);
  });
});

Deno.test('saving a .jsonc: a one-line array goes multi-line only when it changes', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/config.jsonc`;
    const text =
      '{\n  "codeRoots": ["~/a"], // one line\n  "skillsRoots": ["~/s"]\n}\n';
    await Deno.writeTextFile(path, text);
    const cfg = await loadGlobalConfig(path);
    await saveGlobalConfig(
      makeGlobalConfig(['~/a', '~/b'], cfg.skillsRoots, path, cfg.extra),
    );
    assertEquals(
      await Deno.readTextFile(path),
      '{\n  "codeRoots": [\n    "~/a",\n    "~/b"\n  ], // one line\n  "skillsRoots": ["~/s"]\n}\n',
    );
  });
});

Deno.test('saving a .jsonc that no longer parses is refused, the file untouched', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/config.jsonc`;
    await Deno.writeTextFile(path, '{ oops');
    await assertRejects(
      () => saveGlobalConfig(makeGlobalConfig(['~/a'], [], path)),
      Error,
      'not valid JSONC',
    );
    assertEquals(await Deno.readTextFile(path), '{ oops');
  });
});

Deno.test('globalConfigExists: true for either file', async () => {
  await withTemp(async (dir) => {
    assertEquals(await globalConfigExists(undefined, dir), false);
    await Deno.writeTextFile(`${dir}/config.jsonc`, '{}');
    assertEquals(await globalConfigExists(undefined, dir), true);
    await Deno.remove(`${dir}/config.jsonc`);
    await Deno.writeTextFile(`${dir}/config.json`, '{}');
    assertEquals(await globalConfigExists(undefined, dir), true);
  });
});
