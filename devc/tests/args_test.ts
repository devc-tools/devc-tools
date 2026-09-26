import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from 'jsr:@std/assert@^1';
import {
  DEVC_HERDR_SESSION,
  herdrLaunchArgs,
  parseAttachArgs,
  parseBridgeAllow,
  parseBuildArgs,
  parseUpArgs,
} from '../args.ts';

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
  });
});

Deno.test('parseBuildArgs parses a path and both flags in any order', () => {
  assertEquals(parseBuildArgs(['/some/path']), {
    target: '/some/path',
    noCache: false,
    json: false,
    bridgeAllow: null,
  });
  assertEquals(parseBuildArgs(['--no-cache', '/some/path']), {
    target: '/some/path',
    noCache: true,
    json: false,
    bridgeAllow: null,
  });
  assertEquals(parseBuildArgs(['/some/path', '--json', '--no-cache']), {
    target: '/some/path',
    noCache: true,
    json: true,
    bridgeAllow: null,
  });
});

Deno.test('parseUpArgs defaults to cwd with no flags', () => {
  assertEquals(parseUpArgs([]), {
    target: undefined,
    printConfig: false,
    json: false,
    bridgeAllow: null,
  });
});

Deno.test('parseUpArgs parses a path and both flags in any order', () => {
  assertEquals(parseUpArgs(['/some/path']), {
    target: '/some/path',
    printConfig: false,
    json: false,
    bridgeAllow: null,
  });
  assertEquals(parseUpArgs(['--print-config', '/some/path']), {
    target: '/some/path',
    printConfig: true,
    json: false,
    bridgeAllow: null,
  });
  assertEquals(parseUpArgs(['/some/path', '--json', '--print-config']), {
    target: '/some/path',
    printConfig: true,
    json: true,
    bridgeAllow: null,
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
  assertEquals(parseUpArgs(['--bridge-allow', 'git-push']), {
    target: undefined,
    printConfig: false,
    json: false,
    bridgeAllow: ['git-push'],
  });
  assertEquals(parseUpArgs(['--bridge-allow=git-push,pr-review']).bridgeAllow, [
    'git-push',
    'pr-review',
  ]);
  assertEquals(
    parseUpArgs(['--bridge-allow', 'pr-review,pr-resolve', '/path']),
    {
      target: '/path',
      printConfig: false,
      json: false,
      bridgeAllow: ['pr-review', 'pr-resolve'],
    },
  );
  assertEquals(parseBuildArgs(['/p', '--bridge-allow', 'git-push', '--json']), {
    target: '/p',
    noCache: false,
    json: true,
    bridgeAllow: ['git-push'],
  });
});

Deno.test('--bridge-allow trims, dedupes and sorts into canonical order', () => {
  assertEquals(parseBridgeAllow(' pr-resolve , pr-review '), [
    'pr-review',
    'pr-resolve',
  ]);
  assertEquals(parseBridgeAllow('pr-review,git-push,pr-review,'), [
    'git-push',
    'pr-review',
  ]);
});

Deno.test('--bridge-allow refuses bad values with the documented messages', () => {
  const cases: [string[], string][] = [
    [
      ['--bridge-allow'],
      '--bridge-allow needs at least one of: git-push, pr-review, pr-resolve',
    ],
    [
      ['--bridge-allow='],
      '--bridge-allow needs at least one of: git-push, pr-review, pr-resolve',
    ],
    [['--bridge-allow', ' , '], '--bridge-allow needs at least one of'],
    [
      ['--bridge-allow', 'git-pull'],
      'unknown capability git-pull — valid: git-push, pr-review, pr-resolve',
    ],
    [['--bridge-allow', 'pr-resolve'], 'pr-resolve requires pr-review'],
    [
      ['--bridge-allow', 'git-push', '--bridge-allow=pr-review'],
      '--bridge-allow given more than once',
    ],
    [
      ['--bridge-git-push'],
      '--bridge-git-push was replaced by --bridge-allow git-push',
    ],
  ];
  for (const [args, message] of cases) {
    for (const parse of [parseUpArgs, parseBuildArgs]) {
      assertThrows(() => parse(args), Error, message, args.join(' '));
    }
  }
});

/** Run the devc CLI from source; the refusals below happen before any Docker call. */
async function cli(
  ...args: string[]
): Promise<{ code: number; stderr: string }> {
  const { code, stderr } = await new Deno.Command(Deno.execPath(), {
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

Deno.test('CLI: --bridge-allow is refused by every attach-family command, and the old flag everywhere', async () => {
  for (const command of ['attach', 'claude', 'copilot', 'pi', 'herdr']) {
    const r = await cli(command, '/nonexistent', '--bridge-allow', 'git-push');
    assertEquals(r.code, 2, `${command}: ${r.stderr}`);
    assertStringIncludes(
      r.stderr,
      `--bridge-allow is accepted by \`devc up\` and \`devc build\` only, not \`devc ${command}\``,
    );
  }
  const exec = await cli(
    'exec',
    '/nonexistent',
    '--bridge-allow=git-push',
    '--',
    'true',
  );
  assertEquals(exec.code, 2, exec.stderr);
  assertStringIncludes(exec.stderr, 'not `devc exec`');
  for (const command of ['up', 'build', 'attach']) {
    const r = await cli(command, '/nonexistent', '--bridge-git-push');
    assertEquals(r.code, 2, `${command}: ${r.stderr}`);
    assertStringIncludes(
      r.stderr,
      '--bridge-git-push was replaced by --bridge-allow git-push',
    );
  }
  const bad = await cli('up', '/nonexistent', '--bridge-allow', 'pr-resolve');
  assertEquals(bad.code, 2, bad.stderr);
  assertStringIncludes(bad.stderr, 'pr-resolve requires pr-review');
});
