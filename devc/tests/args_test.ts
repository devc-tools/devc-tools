import { assertEquals } from 'jsr:@std/assert@^1';
import { parseAttachArgs, parseBuildArgs, parseUpArgs } from '../args.ts';

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

Deno.test('parseBuildArgs defaults to cwd with no flags', () => {
  assertEquals(parseBuildArgs([]), {
    target: undefined,
    noCache: false,
    json: false,
  });
});

Deno.test('parseBuildArgs parses a path and both flags in any order', () => {
  assertEquals(parseBuildArgs(['/some/path']), {
    target: '/some/path',
    noCache: false,
    json: false,
  });
  assertEquals(parseBuildArgs(['--no-cache', '/some/path']), {
    target: '/some/path',
    noCache: true,
    json: false,
  });
  assertEquals(parseBuildArgs(['/some/path', '--json', '--no-cache']), {
    target: '/some/path',
    noCache: true,
    json: true,
  });
});

Deno.test('parseUpArgs defaults to cwd with no flags', () => {
  assertEquals(parseUpArgs([]), {
    target: undefined,
    printConfig: false,
    json: false,
  });
});

Deno.test('parseUpArgs parses a path and both flags in any order', () => {
  assertEquals(parseUpArgs(['/some/path']), {
    target: '/some/path',
    printConfig: false,
    json: false,
  });
  assertEquals(parseUpArgs(['--print-config', '/some/path']), {
    target: '/some/path',
    printConfig: true,
    json: false,
  });
  assertEquals(parseUpArgs(['/some/path', '--json', '--print-config']), {
    target: '/some/path',
    printConfig: true,
    json: true,
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

Deno.test('parseAttachArgs keeps the first positional as the target', () => {
  assertEquals(parseAttachArgs(['/first', '/second']).target, '/first');
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
