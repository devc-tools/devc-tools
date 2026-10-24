import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from 'jsr:@std/assert@^1';
import {
  checkBareBridgeRepos,
  DEVC_HERDR_SESSION,
  herdrLaunchArgs,
  parseAttachArgs,
  parseBridgeAllow,
  parseBridgeDefaultAllow,
  parseBridgeRepoAllow,
  parseBuildArgs,
  parseConfigArgs,
  parseUpArgs,
} from '../args.ts';
import type { BridgeCapability } from '@devc-tools/core/bridge.ts';

Deno.test('parseAttachArgs leaves target undefined when no path is given', () => {
  assertEquals(parseAttachArgs([]), {
    target: undefined,
    rebuild: false,
    noClear: false,
  });
  assertEquals(parseAttachArgs(['--build']), {
    target: undefined,
    rebuild: true,
    noClear: false,
  });
});

Deno.test('parseAttachArgs parses a bare path', () => {
  assertEquals(parseAttachArgs(['/some/path']), {
    target: '/some/path',
    rebuild: false,
    noClear: false,
  });
});

Deno.test('parseAttachArgs parses flags alongside a path in any order', () => {
  assertEquals(parseAttachArgs(['--build', '/some/path']), {
    target: '/some/path',
    rebuild: true,
    noClear: false,
  });
  assertEquals(parseAttachArgs(['/some/path', '--build']), {
    target: '/some/path',
    rebuild: true,
    noClear: false,
  });
});

Deno.test('parseAttachArgs parses --no-clear flag', () => {
  assertEquals(parseAttachArgs(['--no-clear']), {
    target: undefined,
    rebuild: false,
    noClear: true,
  });
  assertEquals(parseAttachArgs(['--no-clear', '--build', '/some/path']), {
    target: '/some/path',
    rebuild: true,
    noClear: true,
  });
});

Deno.test('parseAttachArgs rejects anything devc does not own before --', () => {
  // `--session foo` once attached to a project named `foo`; now it is refused outright.
  for (
    const args of [
      ['--session', 'foo'],
      ['/p', '--resume'],
      ['-c'],
      ['/p', 'session', 'list'],
      ['--build', '--bulid'],
    ]
  ) {
    assertThrows(() => parseAttachArgs(args), Error, 'unexpected argument');
  }
});

Deno.test('parseAttachArgs forwards everything after --, verbatim', () => {
  assertEquals(parseAttachArgs(['--', '--session', 'foo']), {
    target: undefined,
    rebuild: false,
    noClear: false,
    extraArgs: ['--session', 'foo'],
  });
  // devc's own flags after `--` belong to the command — no order-dependent overlap.
  assertEquals(
    parseAttachArgs([
      '/p',
      '--build',
      '--cwd',
      '/c',
      '--',
      '--build',
      '--cwd=x',
    ]),
    {
      target: '/p',
      rebuild: true,
      noClear: false,
      cwd: '/c',
      extraArgs: ['--build', '--cwd=x'],
    },
  );
  // A bare `--` with nothing after it forwards nothing.
  assertEquals(parseAttachArgs(['/p', '--']), {
    target: '/p',
    rebuild: false,
    noClear: false,
  });
});

Deno.test('herdrLaunchArgs defaults to the devc session', () => {
  assertEquals(DEVC_HERDR_SESSION, 'devc');
  assertEquals(herdrLaunchArgs([]), ['--session', 'devc']);
  assertEquals(herdrLaunchArgs(['--handoff']), [
    '--session',
    'devc',
    '--handoff',
  ]);
});

Deno.test('herdrLaunchArgs leaves an explicit target or subcommand alone', () => {
  for (
    const args of [
      ['--session', 'mine'],
      ['--session=mine'],
      ['--remote', 'host'],
      ['--remote=host'],
      ['session', 'list'],
      ['--machine', 'box', 'pane', 'list'],
    ]
  ) {
    assertEquals(herdrLaunchArgs(args), args);
  }
});

Deno.test('parseBuildArgs defaults to cwd with no flags', () => {
  assertEquals(parseBuildArgs([]), {
    target: undefined,
    noCache: false,
    json: false,
    bridgeAllow: null,
    bridgeRepos: [],
  });
});

Deno.test('parseBuildArgs parses a path and both flags in any order', () => {
  assertEquals(parseBuildArgs(['/some/path']), {
    target: '/some/path',
    noCache: false,
    json: false,
    bridgeAllow: null,
    bridgeRepos: [],
  });
  assertEquals(parseBuildArgs(['--no-cache', '/some/path']), {
    target: '/some/path',
    noCache: true,
    json: false,
    bridgeAllow: null,
    bridgeRepos: [],
  });
  assertEquals(parseBuildArgs(['/some/path', '--json', '--no-cache']), {
    target: '/some/path',
    noCache: true,
    json: true,
    bridgeAllow: null,
    bridgeRepos: [],
  });
});

Deno.test('parseUpArgs defaults to cwd with no flags', () => {
  assertEquals(parseUpArgs([]), {
    target: undefined,
    printConfig: false,
    json: false,
    bridgeAllow: null,
    bridgeRepos: [],
  });
});

Deno.test('parseUpArgs parses a path and both flags in any order', () => {
  assertEquals(parseUpArgs(['/some/path']), {
    target: '/some/path',
    printConfig: false,
    json: false,
    bridgeAllow: null,
    bridgeRepos: [],
  });
  assertEquals(parseUpArgs(['--print-config', '/some/path']), {
    target: '/some/path',
    printConfig: true,
    json: false,
    bridgeAllow: null,
    bridgeRepos: [],
  });
  assertEquals(parseUpArgs(['/some/path', '--json', '--print-config']), {
    target: '/some/path',
    printConfig: true,
    json: true,
    bridgeAllow: null,
    bridgeRepos: [],
  });
});

Deno.test('parseAttachArgs leaves cwd absent when --cwd is not given', () => {
  assertEquals(parseAttachArgs(['/some/path', '--build']).cwd, undefined);
  assertEquals('cwd' in parseAttachArgs(['/some/path']), false);
});

Deno.test('parseAttachArgs: --cwd <path> does not become the target', () => {
  assertEquals(parseAttachArgs(['--cwd', '/x']), {
    target: undefined,
    rebuild: false,
    noClear: false,
    cwd: '/x',
  });
});

Deno.test('parseAttachArgs parses --cwd=<path>', () => {
  assertEquals(parseAttachArgs(['--cwd=/x']), {
    target: undefined,
    rebuild: false,
    noClear: false,
    cwd: '/x',
  });
});

Deno.test('parseAttachArgs assigns a path and a --cwd separately', () => {
  assertEquals(
    parseAttachArgs(['/project', '--cwd', '/workspaces/tools/x']),
    {
      target: '/project',
      rebuild: false,
      noClear: false,
      cwd: '/workspaces/tools/x',
    },
  );
  // …and in the other order, where the naive positional scan would take the cwd value.
  assertEquals(
    parseAttachArgs(['--cwd', '/workspaces/tools/x', '/project']),
    {
      target: '/project',
      rebuild: false,
      noClear: false,
      cwd: '/workspaces/tools/x',
    },
  );
  assertEquals(
    parseAttachArgs(['--cwd=/workspaces/tools/x', '/project']),
    {
      target: '/project',
      rebuild: false,
      noClear: false,
      cwd: '/workspaces/tools/x',
    },
  );
});

Deno.test('parseAttachArgs: --cwd with no value neither throws nor eats a flag', () => {
  assertEquals(parseAttachArgs(['--cwd']), {
    target: undefined,
    rebuild: false,
    noClear: false,
  });
  assertEquals(parseAttachArgs(['--cwd', '--build', '/project']), {
    target: '/project',
    rebuild: true,
    noClear: false,
  });
  assertEquals(parseAttachArgs(['--cwd=']), {
    target: undefined,
    rebuild: false,
    noClear: false,
  });
});

Deno.test('parseAttachArgs refuses a second positional rather than ignoring it', () => {
  assertThrows(
    () => parseAttachArgs(['/first', '/second']),
    Error,
    "unexpected argument '/second'",
  );
});

Deno.test('parseAttachArgs: --cwd alongside every other flag', () => {
  assertEquals(
    parseAttachArgs(['--no-clear', '--cwd', '/w', '--build', '/project']),
    {
      target: '/project',
      rebuild: true,
      noClear: true,
      cwd: '/w',
    },
  );
});

Deno.test('--bridge-allow is parsed by up and build in both spellings, and is never the target', () => {
  assertEquals(parseUpArgs(['--bridge-allow', 'gh-push']), {
    target: undefined,
    printConfig: false,
    json: false,
    bridgeAllow: ['gh-push'],
    bridgeRepos: [],
  });
  assertEquals(
    parseUpArgs(['--bridge-allow=gh-push,gh-pr-read']).bridgeAllow,
    [
      'gh-push',
      'gh-pr-read',
    ],
  );
  assertEquals(
    parseUpArgs(['--bridge-allow', 'gh-pr-read,gh-pr-resolve', '/path']),
    {
      target: '/path',
      printConfig: false,
      json: false,
      bridgeAllow: ['gh-pr-read', 'gh-pr-resolve'],
      bridgeRepos: [],
    },
  );
  assertEquals(parseBuildArgs(['/p', '--bridge-allow', 'gh-push', '--json']), {
    target: '/p',
    noCache: false,
    json: true,
    bridgeAllow: ['gh-push'],
    bridgeRepos: [],
  });
});

Deno.test('--bridge-allow trims, dedupes and sorts into canonical order', () => {
  assertEquals(parseBridgeAllow(' gh-pr-resolve , gh-pr-read '), [
    'gh-pr-read',
    'gh-pr-resolve',
  ]);
  assertEquals(parseBridgeAllow('gh-pr-read,gh-push,gh-pr-read,'), [
    'gh-push',
    'gh-pr-read',
  ]);
  assertEquals(
    parseBridgeAllow(
      'gh-pr-resolve-copilot,gh-pr-reply,gh-pr-resolve,gh-pr-read',
    ),
    ['gh-pr-read', 'gh-pr-reply', 'gh-pr-resolve', 'gh-pr-resolve-copilot'],
  );
});

Deno.test('--bridge-allow gh and gh-* expand to every gh- capability', () => {
  const all: BridgeCapability[] = [
    'gh-push',
    'gh-pr-read',
    'gh-pr-reply',
    'gh-pr-pending-review',
    'gh-pr-viewed',
    'gh-pr-resolve',
    'gh-pr-resolve-copilot',
    'gh-pr-request-review',
  ];
  for (
    const value of [
      'gh',
      'gh-*',
      ' gh ',
      'gh-push,gh',
      'gh,gh-*',
      'gh-pr-resolve,gh-*',
    ]
  ) {
    assertEquals(parseBridgeAllow(value), all, value);
  }
  assertEquals(parseUpArgs(['--bridge-allow', 'gh']).bridgeAllow, all);
  assertEquals(parseBuildArgs(['--bridge-allow=gh-*']).bridgeAllow, all);
  assertEquals(all.length, 8);
});

Deno.test('--bridge-allow refuses bad values with the documented messages', () => {
  const cases: [string[], string][] = [
    [
      ['--bridge-allow'],
      '--bridge-allow needs at least one of: gh-push, gh-pr-read, gh-pr-reply, gh-pr-pending-review, gh-pr-viewed, gh-pr-resolve, gh-pr-resolve-copilot, gh-pr-request-review (or gh / gh-* for all of them)',
    ],
    [
      ['--bridge-allow='],
      '--bridge-allow needs at least one of: gh-push, gh-pr-read, gh-pr-reply, gh-pr-pending-review, gh-pr-viewed, gh-pr-resolve, gh-pr-resolve-copilot, gh-pr-request-review (or gh / gh-* for all of them)',
    ],
    [['--bridge-allow', ' , '], '--bridge-allow needs at least one of'],
    [
      ['--bridge-allow', 'git-pull'],
      'unknown capability git-pull — valid: gh-push, gh-pr-read, gh-pr-reply, gh-pr-pending-review, gh-pr-viewed, gh-pr-resolve, gh-pr-resolve-copilot, gh-pr-request-review (or gh / gh-* for all of them)',
    ],
    [
      ['--bridge-allow', 'git-push'],
      'unknown capability git-push — valid: gh-push, gh-pr-read, gh-pr-reply, gh-pr-pending-review, gh-pr-viewed, gh-pr-resolve, gh-pr-resolve-copilot, gh-pr-request-review (or gh / gh-* for all of them)',
    ],
    [['--bridge-allow', 'pr-review'], 'unknown capability pr-review — valid:'],
    [
      ['--bridge-allow', 'gh-pr-review'],
      'gh-pr-review was split — grant gh-pr-read,gh-pr-reply instead',
    ],
    [
      ['--bridge-allow', 'gh-push,gh-pr-review,gh-pr-resolve'],
      'gh-pr-review was split — grant gh-pr-read,gh-pr-reply instead',
    ],
    [['--bridge-allow', '*'], 'unknown capability * — valid:'],
    [['--bridge-allow', 'gh-pr-*'], 'unknown capability gh-pr-* — valid:'],
    [['--bridge-allow', 'GH'], 'unknown capability GH — valid:'],
    [['--bridge-allow', 'gh-push,gh*'], 'unknown capability gh* — valid:'],
    [
      ['--bridge-allow', 'gh-pr-resolve'],
      'gh-pr-resolve requires gh-pr-read',
    ],
    [
      ['--bridge-allow', 'gh-pr-resolve-copilot'],
      'gh-pr-resolve-copilot requires gh-pr-read',
    ],
    [['--bridge-allow', 'gh-pr-reply'], 'gh-pr-reply requires gh-pr-read'],
    [
      ['--bridge-allow', 'gh-pr-request-review'],
      'gh-pr-request-review requires gh-pr-read',
    ],
    [['--bridge-allow', 'gh-pr-viewed'], 'gh-pr-viewed requires gh-pr-read'],
    [
      ['--bridge-allow', 'none,gh-push'],
      "--bridge-allow none can't be combined with capabilities",
    ],
    [
      ['--bridge-allow=gh, none'],
      "--bridge-allow none can't be combined with capabilities",
    ],
    [
      ['--bridge-allow', 'gh-push', '--bridge-allow=gh-pr-read'],
      '--bridge-allow given more than once',
    ],
    [
      ['--bridge-git-push'],
      '--bridge-git-push was replaced by --bridge-allow gh-push',
    ],
  ];
  for (const [args, message] of cases) {
    for (const parse of [parseUpArgs, parseBuildArgs]) {
      assertThrows(() => parse(args), Error, message, args.join(' '));
    }
  }
});

Deno.test('--bridge-allow none revokes, and the flag absent is null', () => {
  assertEquals(parseBridgeAllow('none'), 'none');
  assertEquals(parseBridgeAllow(' none ,'), 'none');
  assertEquals(parseUpArgs(['--bridge-allow', 'none']).bridgeAllow, 'none');
  assertEquals(parseBuildArgs(['--bridge-allow=none']).bridgeAllow, 'none');
  assertEquals(parseUpArgs([]).bridgeAllow, null);
  assertEquals(parseBuildArgs(['proj']).bridgeAllow, null);
});

Deno.test('bridgeDefaultAllow: canonical, trimmed, deduplicated; absent, null or [] is none', () => {
  assertEquals(parseBridgeDefaultAllow(undefined), null);
  assertEquals(parseBridgeDefaultAllow(null), null);
  assertEquals(parseBridgeDefaultAllow([]), null);
  assertEquals(parseBridgeDefaultAllow([' gh-pr-read ']), ['gh-pr-read']);
  assertEquals(
    parseBridgeDefaultAllow(['gh-pr-viewed', 'gh-pr-read', 'gh-pr-read']),
    ['gh-pr-read', 'gh-pr-viewed'],
  );
  assertEquals(
    parseBridgeDefaultAllow([
      'gh-pr-request-review',
      'gh-push',
      'gh-pr-reply',
      'gh-pr-read',
    ]),
    ['gh-push', 'gh-pr-read', 'gh-pr-reply', 'gh-pr-request-review'],
  );
});

Deno.test('gh and gh-* in the config defaults expand to every gh- capability, as on the flag', () => {
  const all = [
    'gh-push',
    'gh-pr-read',
    'gh-pr-reply',
    'gh-pr-pending-review',
    'gh-pr-viewed',
    'gh-pr-resolve',
    'gh-pr-resolve-copilot',
    'gh-pr-request-review',
  ];
  assertEquals(parseBridgeDefaultAllow(['gh']), all);
  assertEquals(parseBridgeDefaultAllow([' gh-* ', 'gh-push']), all);
  assertEquals(parseBridgeRepoAllow({ '/a;/b': ['gh-*'] }), [
    { key: '/a', path: '/a', grants: all },
    { key: '/b', path: '/b', grants: all },
  ]);
  // Other patterns are still unknown names.
  for (const n of ['*', 'gh-pr-*', 'GH']) {
    const e = assertThrows(() => parseBridgeDefaultAllow([n]));
    assertStringIncludes((e as Error).message, `unknown capability ${n}`);
  }
});

Deno.test('bridgeDefaultAllow refuses bad values with each documented reason', () => {
  const cases: [unknown, string][] = [
    ['gh-pr-read', 'must be an array of capability names'],
    [{ 'gh-pr-read': true }, 'must be an array of capability names'],
    [7, 'must be an array of capability names'],
    [['gh-pr-read', 7], 'must be an array of capability names'],
    [['gh-pr-read', null], 'must be an array of capability names'],
    [
      ['gh-pr-nope'],
      'unknown capability gh-pr-nope — valid: gh-push, gh-pr-read, gh-pr-reply, gh-pr-pending-review, gh-pr-viewed, gh-pr-resolve, gh-pr-resolve-copilot, gh-pr-request-review',
    ],
    [
      ['none'],
      'unknown capability none — valid: gh-push, gh-pr-read, gh-pr-reply, gh-pr-pending-review, gh-pr-viewed, gh-pr-resolve, gh-pr-resolve-copilot, gh-pr-request-review',
    ],
    [['gh-pr-viewed'], 'gh-pr-viewed requires gh-pr-read'],
    [['gh-pr-resolve', 'gh-push'], 'gh-pr-resolve requires gh-pr-read'],
    [
      ['gh-pr-review'],
      'gh-pr-review was split — grant gh-pr-read,gh-pr-reply instead',
    ],
    [
      ['gh-push', 'gh-pr-review'],
      'gh-pr-review was split — grant gh-pr-read,gh-pr-reply instead',
    ],
  ];
  for (const [value, reason] of cases) {
    const e = assertThrows(() => parseBridgeDefaultAllow(value));
    assertEquals((e as Error).message, reason, JSON.stringify(value));
  }
});

Deno.test('bridgeRepoAllow: keys expanded, values canonicalized, [] kept; absent or null is none', () => {
  const home = Deno.env.get('HOME')!;
  assertEquals(parseBridgeRepoAllow(undefined), null);
  assertEquals(parseBridgeRepoAllow(null), null);
  assertEquals(parseBridgeRepoAllow({}), []);
  Deno.env.set('DEVC_TEST_REPOS', '/srv/repos');
  try {
    assertEquals(
      parseBridgeRepoAllow({
        '~/code/shared-lib/': ['gh-pr-reply', ' gh-pr-read', 'gh-pr-read'],
        '~/code/secrets': [],
        '$DEVC_TEST_REPOS/x': ['gh-push'],
        '/abs': ['gh-pr-read'],
      }),
      [
        {
          key: '~/code/shared-lib/',
          path: `${home}/code/shared-lib`,
          grants: ['gh-pr-read', 'gh-pr-reply'],
        },
        { key: '~/code/secrets', path: `${home}/code/secrets`, grants: [] },
        {
          key: '$DEVC_TEST_REPOS/x',
          path: '/srv/repos/x',
          grants: ['gh-push'],
        },
        { key: '/abs', path: '/abs', grants: ['gh-pr-read'] },
      ],
    );
  } finally {
    Deno.env.delete('DEVC_TEST_REPOS');
  }
});

Deno.test('bridgeRepoAllow: a ;-separated key gives each path its own entry with the shared list', () => {
  const home = Deno.env.get('HOME')!;
  assertEquals(
    parseBridgeRepoAllow({
      '~/code/a; /srv/b/ ;~/code/c': ['gh-pr-viewed', 'gh-pr-read'],
      '/solo': [],
    }),
    [
      {
        key: '~/code/a',
        path: `${home}/code/a`,
        grants: ['gh-pr-read', 'gh-pr-viewed'],
      },
      {
        key: '/srv/b/',
        path: '/srv/b',
        grants: ['gh-pr-read', 'gh-pr-viewed'],
      },
      {
        key: '~/code/c',
        path: `${home}/code/c`,
        grants: ['gh-pr-read', 'gh-pr-viewed'],
      },
      { key: '/solo', path: '/solo', grants: [] },
    ],
  );
});

Deno.test('bridgeRepoAllow refuses bad values with each documented reason', () => {
  Deno.env.delete('DEVC_TEST_UNSET');
  const object = 'must be an object mapping repo paths to capability lists';
  const cases: [unknown, string][] = [
    [['/a'], object],
    ['/a', object],
    [7, object],
    [true, object],
    [{ 'code/lib': ['gh-pr-read'] }, 'code/lib: not an absolute path'],
    [{ '~user/lib': ['gh-pr-read'] }, '~user/lib: not an absolute path'],
    [
      { '$DEVC_TEST_UNSET/lib': ['gh-pr-read'] },
      '$DEVC_TEST_UNSET/lib: $DEVC_TEST_UNSET is not set',
    ],
    [{ '/a': 'gh-pr-read' }, '/a: must be an array of capability names'],
    [{ '/a': null }, '/a: must be an array of capability names'],
    [{ '/a': ['gh-pr-read', 7] }, '/a: must be an array of capability names'],
    [
      { '/a': ['gh-pr-nope'] },
      '/a: unknown capability gh-pr-nope — valid: gh-push, gh-pr-read, gh-pr-reply, gh-pr-pending-review, gh-pr-viewed, gh-pr-resolve, gh-pr-resolve-copilot, gh-pr-request-review',
    ],
    [
      { '/a': ['gh-pr-review'] },
      '/a: gh-pr-review was split — grant gh-pr-read,gh-pr-reply instead',
    ],
    [{ '/a': ['gh-pr-reply'] }, '/a: gh-pr-reply requires gh-pr-read'],
    // The first bad key is the one named.
    [
      { '/ok': ['gh-pr-read'], '/b': ['gh-pr-viewed'] },
      '/b: gh-pr-viewed requires gh-pr-read',
    ],
    // A `;` list: a bad list names the whole key, a bad path only that path.
    [
      { '/a;/b': ['gh-pr-reply'] },
      '/a;/b: gh-pr-reply requires gh-pr-read',
    ],
    [{ '/a;code/b': ['gh-pr-read'] }, 'code/b: not an absolute path'],
    [{ '/a;;/b': ['gh-pr-read'] }, '/a;;/b: empty path in the list'],
    [{ '/a;': ['gh-pr-read'] }, '/a;: empty path in the list'],
  ];
  for (const [value, reason] of cases) {
    const e = assertThrows(() => parseBridgeRepoAllow(value));
    assertEquals((e as Error).message, reason, JSON.stringify(value));
  }
});

Deno.test('a bare --bridge-repo parses, and is refused only when neither default key is set', () => {
  assertEquals(parseUpArgs(['--bridge-repo', '/a']).bridgeRepos, ['/a']);
  assertEquals(parseUpArgs(['--bridge-repo', '/a']).bridgeAllow, null);
  assertEquals(parseBuildArgs(['--bridge-repo=/a', 'proj']).bridgeRepos, [
    '/a',
  ]);
  const refusal =
    '--bridge-repo requires --bridge-allow, "bridgeDefaultAllow" or "bridgeRepoAllow"';
  assertThrows(
    () => checkBareBridgeRepos(['/a'], null, null),
    Error,
    refusal,
  );
  assertThrows(
    () => checkBareBridgeRepos(['/a'], null, []),
    Error,
    refusal,
  );
  checkBareBridgeRepos(['/a'], ['gh-pr-read'], null);
  checkBareBridgeRepos(['/a'], null, [
    { key: '/a', path: '/a', grants: ['gh-pr-read'] },
  ]);
  // An entry of [] still counts as set: the repo is then skipped with a notice.
  checkBareBridgeRepos(['/a'], null, [{ key: '/a', path: '/a', grants: [] }]);
  checkBareBridgeRepos([], null, null);
});

Deno.test('--bridge-repo is repeatable in both spellings, and its value is never the target', () => {
  assertEquals(
    parseUpArgs([
      '--bridge-allow',
      'gh',
      '--bridge-repo',
      '/a',
      '--bridge-repo=/b',
      'proj',
    ]),
    {
      target: 'proj',
      printConfig: false,
      json: false,
      bridgeAllow: [
        'gh-push',
        'gh-pr-read',
        'gh-pr-reply',
        'gh-pr-pending-review',
        'gh-pr-viewed',
        'gh-pr-resolve',
        'gh-pr-resolve-copilot',
        'gh-pr-request-review',
      ],
      bridgeRepos: ['/a', '/b'],
    },
  );
  assertEquals(
    parseBuildArgs(['--bridge-repo', '~/x', '--bridge-allow=gh-push']),
    {
      target: undefined,
      noCache: false,
      json: false,
      bridgeAllow: ['gh-push'],
      bridgeRepos: ['~/x'],
    },
  );
});

Deno.test('--bridge-repo refuses bad uses with the documented messages', () => {
  const sixteen = Array.from(
    { length: 16 },
    (_, i) => `--bridge-repo=/r${i}`,
  );
  const cases: [string[], string][] = [
    [
      ['--bridge-allow', 'none', '--bridge-repo', '/a'],
      '--bridge-repo requires --bridge-allow with capabilities',
    ],
    [['--bridge-allow', 'gh', '--bridge-repo'], '--bridge-repo needs a path'],
    [['--bridge-allow', 'gh', '--bridge-repo='], '--bridge-repo needs a path'],
    [
      ['--bridge-allow', 'gh', '--bridge-repo', '/a', '--bridge-repo=/a/'],
      '--bridge-repo /a/ given more than once',
    ],
    [['--bridge-allow', 'gh', ...sixteen], '--bridge-repo given 16 times'],
  ];
  for (const [args, message] of cases) {
    for (const parse of [parseUpArgs, parseBuildArgs]) {
      assertThrows(() => parse(args), Error, message, args.join(' '));
    }
  }
  // Fifteen is the most, and still parses.
  assertEquals(
    parseUpArgs(['--bridge-allow', 'gh', ...sixteen.slice(1)]).bridgeRepos
      .length,
    15,
  );
});

Deno.test('--bridge-repo: two spellings of one directory are the same repo', async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.mkdir(`${dir}/repo`);
    await Deno.symlink(`${dir}/repo`, `${dir}/link`);
    assertThrows(
      () =>
        parseUpArgs([
          '--bridge-allow',
          'gh',
          '--bridge-repo',
          `${dir}/repo`,
          '--bridge-repo',
          `${dir}/link`,
        ]),
      Error,
      `--bridge-repo ${dir}/link given more than once`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Run the devc CLI from source; the refusals below happen before any Docker call. */
async function cli(
  ...args: string[]
): Promise<{ code: number; stderr: string }> {
  return await cliIn(undefined, ...args);
}

/** {@link cli}, with `HOME` set to `home` when given. */
async function cliIn(
  home: string | undefined,
  ...args: string[]
): Promise<{ code: number; stderr: string }> {
  const { code, stderr } = await new Deno.Command(Deno.execPath(), {
    env: home === undefined ? undefined : { HOME: home },
    args: [
      'run',
      '-A',
      new URL('../main.ts', import.meta.url).pathname,
      ...args,
    ],
    stdout: 'null',
    stderr: 'piped',
  }).output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

Deno.test('CLI: --bridge-allow and --bridge-repo are refused by every attach-family command, and the old flag everywhere', async () => {
  for (const command of ['attach', 'claude', 'copilot', 'pi', 'herdr']) {
    const r = await cli(command, '/nonexistent', '--bridge-allow', 'gh-push');
    assertEquals(r.code, 2, `${command}: ${r.stderr}`);
    assertStringIncludes(
      r.stderr,
      `--bridge-allow is accepted by \`devc up\` and \`devc build\` only, not \`devc ${command}\``,
    );
  }
  const exec = await cli(
    'exec',
    '/nonexistent',
    '--bridge-allow=gh-push',
    '--',
    'true',
  );
  assertEquals(exec.code, 2, exec.stderr);
  assertStringIncludes(exec.stderr, 'not `devc exec`');
  for (const command of ['attach', 'claude', 'copilot', 'pi', 'herdr']) {
    const r = await cli(command, '/nonexistent', '--bridge-repo', '/a');
    assertEquals(r.code, 2, `${command}: ${r.stderr}`);
    assertStringIncludes(
      r.stderr,
      `devc: --bridge-repo is accepted by \`devc up\` and \`devc build\` only, not \`devc ${command}\``,
    );
  }
  const execRepo = await cli(
    'exec',
    '/nonexistent',
    '--bridge-repo=/a',
    '--',
    'true',
  );
  assertEquals(execRepo.code, 2, execRepo.stderr);
  assertStringIncludes(
    execRepo.stderr,
    '--bridge-repo is accepted by `devc up` and `devc build` only, not `devc exec`',
  );
  const home = await Deno.makeTempDir();
  try {
    const noAllow = await cliIn(
      home,
      'up',
      '/nonexistent',
      '--bridge-repo',
      '/a',
    );
    assertEquals(noAllow.code, 2, noAllow.stderr);
    assertStringIncludes(
      noAllow.stderr,
      'devc: --bridge-repo requires --bridge-allow, "bridgeDefaultAllow" or "bridgeRepoAllow"',
    );
    await Deno.mkdir(`${home}/.config/devc`, { recursive: true });
    await Deno.writeTextFile(
      `${home}/.config/devc/config.json`,
      JSON.stringify({ bridgeRepoAllow: { 'lib': ['gh-pr-read'] } }),
    );
    const badMap = await cliIn(home, 'up', '/nonexistent');
    assertEquals(badMap.code, 2, badMap.stderr);
    assertStringIncludes(
      badMap.stderr,
      'devc: ~/.config/devc/config.json: bridgeRepoAllow: lib: not an absolute path',
    );
    // Two keys naming one repo — here a repo and a folder inside it.
    await Deno.mkdir(`${home}/code/lib/.git`, { recursive: true });
    await Deno.mkdir(`${home}/code/lib/src`, { recursive: true });
    await Deno.writeTextFile(
      `${home}/.config/devc/config.json`,
      JSON.stringify({
        bridgeRepoAllow: {
          '~/code/gone': ['gh-pr-read'],
          '~/code/lib': ['gh-pr-read'],
          '~/code/lib/src': [],
        },
      }),
    );
    const twice = await cliIn(home, 'up', '/nonexistent');
    assertEquals(twice.code, 2, twice.stderr);
    assertStringIncludes(
      twice.stderr,
      'devc: bridgeRepoAllow: ignoring ~/code/gone: no such folder',
    );
    assertStringIncludes(
      twice.stderr,
      'devc: ~/.config/devc/config.json: bridgeRepoAllow: ~/code/lib and ~/code/lib/src name the same repo',
    );
    // A config.jsonc wins over config.json, and the message names it.
    await Deno.writeTextFile(
      `${home}/.config/devc/config.jsonc`,
      '{\n  // defaults\n  "bridgeDefaultAllow": ["gh-nope"],\n}\n',
    );
    const jsonc = await cliIn(home, 'up', '/nonexistent');
    assertEquals(jsonc.code, 2, jsonc.stderr);
    assertStringIncludes(
      jsonc.stderr,
      'devc: ~/.config/devc/config.json is ignored because ~/.config/devc/config.jsonc exists',
    );
    assertStringIncludes(
      jsonc.stderr,
      'devc: ~/.config/devc/config.jsonc: bridgeDefaultAllow: unknown capability gh-nope',
    );
    // Only a config.jsonc: the same message, and no ignored notice.
    await Deno.remove(`${home}/.config/devc/config.json`);
    const only = await cliIn(home, 'up', '/nonexistent');
    assertEquals(only.code, 2, only.stderr);
    assertStringIncludes(
      only.stderr,
      'devc: ~/.config/devc/config.jsonc: bridgeDefaultAllow: unknown capability gh-nope',
    );
    assert(!only.stderr.includes('is ignored'), only.stderr);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
  for (const command of ['up', 'build', 'attach']) {
    const r = await cli(command, '/nonexistent', '--bridge-git-push');
    assertEquals(r.code, 2, `${command}: ${r.stderr}`);
    assertStringIncludes(
      r.stderr,
      '--bridge-git-push was replaced by --bridge-allow gh-push',
    );
  }
  const bad = await cli(
    'up',
    '/nonexistent',
    '--bridge-allow',
    'gh-pr-resolve',
  );
  assertEquals(bad.code, 2, bad.stderr);
  assertStringIncludes(bad.stderr, 'gh-pr-resolve requires gh-pr-read');
  const renamed = await cli(
    'up',
    '/nonexistent',
    '--bridge-allow',
    'gh-pr-review',
  );
  assertEquals(renamed.code, 2, renamed.stderr);
  assertStringIncludes(
    renamed.stderr,
    'gh-pr-review was split — grant gh-pr-read,gh-pr-reply instead',
  );
  const lone = await cli(
    'up',
    '/nonexistent',
    '--bridge-allow',
    'gh-pr-request-review',
  );
  assertEquals(lone.code, 2, lone.stderr);
  assertStringIncludes(
    lone.stderr,
    'gh-pr-request-review requires gh-pr-read',
  );
});

Deno.test('parseConfigArgs: PATH and the two scope flags, in any order', () => {
  assertEquals(parseConfigArgs([]), {
    target: undefined,
    global: false,
    repo: false,
  });
  assertEquals(parseConfigArgs(['p']), {
    target: 'p',
    global: false,
    repo: false,
  });
  assertEquals(parseConfigArgs(['--repo']), {
    target: undefined,
    global: false,
    repo: true,
  });
  assertEquals(parseConfigArgs(['--repo', 'p']), {
    target: 'p',
    global: false,
    repo: true,
  });
  assertEquals(parseConfigArgs(['p', '--repo']), {
    target: 'p',
    global: false,
    repo: true,
  });
  assertEquals(parseConfigArgs(['--global']), {
    target: undefined,
    global: true,
    repo: false,
  });
});

Deno.test('parseConfigArgs: rejects --global with --repo, unknown flags and a second PATH', () => {
  assertThrows(
    () => parseConfigArgs(['--global', '--repo']),
    Error,
    '--global and --repo cannot be combined',
  );
  assertThrows(
    () => parseConfigArgs(['--bogus']),
    Error,
    "unexpected argument '--bogus'",
  );
  assertThrows(
    () => parseConfigArgs(['a', 'b']),
    Error,
    "unexpected argument 'b'",
  );
});
