import { assertEquals } from 'jsr:@std/assert';
import { parser } from 'npm:@lezer/javascript@1.5.6';
import {
  currentItem,
  MAX_OUTLINE_ITEMS,
  outlineOf,
} from '../web/static/lib/outline.js';
import { MAX_OUTLINE_ITEMS as PROTOCOL_MAX_OUTLINE_ITEMS } from '../web/protocol.ts';

type Row = [kind: string, name: string, depth: number, modifiers?: string[]];

/** The outline of `src`, parsed as TypeScript (or the given dialect). */
function outline(src: string, dialect = 'ts') {
  return outlineOf(parser.configure({ dialect }).parse(src), src);
}

/** Each item as `[kind, name, depth, modifiers]`, modifiers left out when empty. */
function rows(src: string, dialect = 'ts'): Row[] {
  return outline(src, dialect).items.map((i) =>
    i.modifiers.length
      ? [i.kind, i.name, i.depth, i.modifiers]
      : [i.kind, i.name, i.depth]
  );
}

Deno.test('outline: Vitest/Jest suites and tests, nested, with modifiers', () => {
  const src = `
import { describe, it, test } from 'vitest';
describe('math', () => {
  it('adds', () => {});
  it.skip('subtracts', () => {});
  test.only('multiplies', async () => {});
  it.todo('divides');
  describe('nested', function () {
    test(\`template \${1}\`, () => {});
  });
});
describe.each([1, 2])('n %i', (n) => {
  test.concurrent.each([[1]])('row %s', () => {});
});
it.skipIf(true)('maybe', () => {});
`;
  assertEquals(rows(src), [
    ['suite', 'math', 0],
    ['test', 'adds', 1],
    ['test', 'subtracts', 1, ['skip']],
    ['test', 'multiplies', 1, ['only']],
    ['test', 'divides', 1, ['todo']],
    ['suite', 'nested', 1],
    ['test', 'template ${1}', 2],
    ['suite', 'n %i', 0, ['each']],
    ['test', 'row %s', 1, ['concurrent', 'each']],
    ['test', 'maybe', 0, ['skipIf']],
  ]);
});

Deno.test('outline: node:test options objects are not modifiers', () => {
  const src = `
describe('suite', { skip: true }, () => {
  it('case', { timeout: 10 }, () => {});
});
`;
  assertEquals(rows(src), [
    ['suite', 'suite', 0],
    ['test', 'case', 1],
  ]);
});

Deno.test('outline: Deno.test forms and nested t.step', () => {
  const src = `
Deno.test('a', () => {});
Deno.test({ name: 'b', fn() {} });
Deno.test({ name: 'b2', fn: async (t) => { await t.step('in b2', () => {}); } });
Deno.test(function c() {});
Deno.test('d', { permissions: {} }, () => {});
Deno.test.ignore('e', () => {});
Deno.bench('f', () => {});
Deno.test('steps', async (t) => {
  await t.step('outer', async (t) => {
    await t.step('inner', () => {});
  });
});
`;
  assertEquals(rows(src), [
    ['test', 'a', 0],
    ['test', 'b', 0],
    ['test', 'b2', 0],
    ['test', 'in b2', 1],
    ['test', 'c', 0],
    ['test', 'd', 0],
    ['test', 'e', 0, ['ignore']],
    ['test', 'f', 0],
    ['test', 'steps', 0],
    ['test', 'outer', 1],
    ['test', 'inner', 2],
  ]);
});

Deno.test('outline: calls that are not tests', () => {
  const src = `
/x/.test(s);
test.foo('not a modifier');
t.step('step outside a test');
Deno.exit(0);
it[name]('computed');
const helper = () => { it('registered by a helper', () => {}); };
`;
  assertEquals(rows(src), [['function', 'helper', 0]]);
});

Deno.test('outline: tests in loops and blocks inside a suite', () => {
  const src = `
describe('cases', () => {
  for (const c of cases) it(\`case \${c}\`, () => {});
  if (slow) {
    test('slow', () => {});
  }
});
`;
  assertEquals(rows(src), [
    ['suite', 'cases', 0],
    ['test', 'case ${c}', 1],
    ['test', 'slow', 1],
  ]);
});

Deno.test('outline: top-level declarations', () => {
  const src = `
export function f() { function inner() {} }
async function* gen() {}
export default function () {}
export const g = () => 1, x = 2, h = function () {};
let plain = 1;
export abstract class C {
  #priv() {}
  get q() { return 1; }
  constructor() {}
  static async *r() {}
  field = 1;
}
interface I { a: 1 }
export type T = 1;
enum E { A }
`;
  assertEquals(rows(src), [
    ['function', 'f', 0],
    ['function', 'gen', 0],
    ['function', 'default', 0],
    ['function', 'g', 0],
    ['function', 'h', 0],
    ['class', 'C', 0],
    ['method', '#priv', 1],
    ['method', 'q', 1],
    ['method', 'constructor', 1],
    ['method', 'r', 1],
    ['interface', 'I', 0],
    ['type', 'T', 0],
    ['enum', 'E', 0],
  ]);
});

Deno.test('outline: JavaScript and TSX', () => {
  assertEquals(rows('function a() {}\nit("b", () => {});', ''), [
    ['function', 'a', 0],
    ['test', 'b', 0],
  ]);
  const tsx = `
export function App() { return <div/>; }
const B = () => <b/>;
`;
  assertEquals(rows(tsx, 'ts jsx'), [
    ['function', 'App', 0],
    ['function', 'B', 0],
  ]);
});

Deno.test('outline: a long or multi-line name is cut to one line', () => {
  const long = 'x'.repeat(200);
  const [item] = outline(`it('${long}', () => {});`).items;
  assertEquals(item.name, 'x'.repeat(119) + '…');
  const [multi] = outline('it(`two\n   lines`, () => {});').items;
  assertEquals(multi.name, 'two lines');
});

Deno.test('outline: stops at MAX_OUTLINE_ITEMS', () => {
  const src = Array.from(
    { length: MAX_OUTLINE_ITEMS + 100 },
    (_, i) => `it('t${i}', () => {});`,
  ).join('\n');
  const { items, truncated } = outline(src);
  assertEquals(items.length, MAX_OUTLINE_ITEMS);
  assertEquals(truncated, true);
  assertEquals(outline('it("a", () => {});').truncated, false);
});

Deno.test('outline: line and endLine, CRLF included', () => {
  const src = [
    '// header',
    "describe('s', () => {",
    "  it('a', () => {",
    '  });',
    '});',
  ].join('\r\n');
  const items = outline(src).items;
  assertEquals(
    items.map((i) => [i.name, i.line, i.endLine]),
    [['s', 2, 5], ['a', 3, 4]],
  );
});

Deno.test('currentItem: the deepest item holding the line', () => {
  const src = [
    "describe('s', () => {", // 1
    "  it('a', () => {", // 2
    '    x();', // 3
    '  });', // 4
    '', // 5
    "  it('b', () => {});", // 6
    '});', // 7
    'function f() {}', // 8
  ].join('\n');
  const items = outline(src).items;
  const at = (line: number) => {
    const i = currentItem(items, line);
    return i === null ? null : items[i].name;
  };
  assertEquals(at(3), 'a');
  assertEquals(at(5), 's');
  assertEquals(at(6), 'b');
  assertEquals(at(8), 'f');
  assertEquals(currentItem(outline('\n\nit("a", () => {});').items, 1), null);
});

Deno.test('MAX_OUTLINE_ITEMS matches the protocol check', () => {
  assertEquals(MAX_OUTLINE_ITEMS, PROTOCOL_MAX_OUTLINE_ITEMS);
});
