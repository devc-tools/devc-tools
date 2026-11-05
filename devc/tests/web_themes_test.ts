// devc web's color themes (`web/static/lib/themes.js`), which devc-desktop's View → Theme picks.
import { assert, assertEquals } from 'jsr:@std/assert';
import {
  DEFAULT_THEME,
  themeFromHash,
  themeNamed,
  THEMES,
  themeVars,
} from '../web/static/lib/themes.js';

/** `style.css`'s first `:root` block, as `{'--name': 'value'}`. */
async function rootVars(): Promise<Record<string, string>> {
  const css = await Deno.readTextFile(
    new URL('../web/static/style.css', import.meta.url),
  );
  const block = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  const vars: Record<string, string> = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars[m[1]] = m[2].trim();
  }
  return vars;
}

Deno.test('every theme sets every token, as #rrggbb (the focus glow #rrggbbaa)', () => {
  const names = Object.keys(themeVars(THEMES[0])).sort();
  assertEquals(names.length, 25);
  for (const theme of THEMES) {
    const vars = themeVars(theme);
    assertEquals(Object.keys(vars).sort(), names, theme.name);
    for (const [name, value] of Object.entries(vars)) {
      const re = name === '--tile-focus-glow'
        ? /^#[0-9a-f]{8}$/
        : /^#[0-9a-f]{6}$/;
      assert(re.test(value), `${theme.name} ${name} ${value}`);
    }
  }
});

Deno.test("slate is style.css's own colors", async () => {
  const root = await rootVars();
  const slate = themeVars(themeNamed('slate'));
  for (const [name, value] of Object.entries(slate)) {
    assertEquals(root[name]?.toLowerCase(), value, name);
  }
});

Deno.test('theme names are unique; slate is the default and the fallback', () => {
  const names = THEMES.map((t) => t.name);
  assertEquals(new Set(names).size, names.length);
  assertEquals(DEFAULT_THEME, 'slate');
  assertEquals(themeNamed('dusk').name, 'dusk');
  assertEquals(themeNamed('nope').name, 'slate');
  assertEquals(themeNamed(undefined).name, 'slate');
});

Deno.test('themeFromHash reads theme= only', () => {
  assertEquals(themeFromHash('#token=x&theme=mocha&view=v')?.name, 'mocha');
  assertEquals(themeFromHash('theme=graphite')?.name, 'graphite');
  assertEquals(themeFromHash('#theme=nope')?.name, 'slate');
  assertEquals(themeFromHash('#token=x'), null);
});

// devc-desktop's host colors (`HOST_COLORS` in its policy.ts), but for None, which is
// devc web's own `--panel`: a theme's backgrounds must not be one of them.
const HOST_COLOR_HEXES = [
  '#10251b',
  '#0f2427',
  '#121d33',
  '#1f1830',
  '#2a2210',
  '#2b1517',
];

/** Straight-line distance between two `#rrggbb` colors in RGB. */
function distance(a: string, b: string): number {
  const ch = (h: string, i: number) =>
    parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16);
  return Math.hypot(...[0, 1, 2].map((i) => ch(a, i) - ch(b, i)));
}

Deno.test('no theme background is within 9 of a host color', () => {
  // Slate, style.css's own colors, is 10.8 from the nearest; the tinted themes stay at least as
  // far as 9, so a host tile's color still stands out on each.
  const backgrounds = [
    '--bg',
    '--panel',
    '--panel-2',
    '--term-bg',
    '--sidebar-head',
    '--tile-head',
  ];
  for (const theme of THEMES) {
    const vars = themeVars(theme);
    for (const name of backgrounds) {
      for (const host of HOST_COLOR_HEXES) {
        const d = distance(vars[name], host);
        assert(
          d >= 9,
          `${theme.name} ${name} ${vars[name]} is ${d.toFixed(1)} from ${host}`,
        );
      }
    }
  }
});
