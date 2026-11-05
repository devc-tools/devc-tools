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
  assertEquals(themeNamed('teal').name, 'teal');
  assertEquals(themeNamed('nope').name, 'slate');
  assertEquals(themeNamed(undefined).name, 'slate');
});

Deno.test('themeFromHash reads theme= only', () => {
  assertEquals(themeFromHash('#token=x&theme=amber&view=v')?.name, 'amber');
  assertEquals(themeFromHash('theme=graphite')?.name, 'graphite');
  assertEquals(themeFromHash('#theme=nope')?.name, 'slate');
  assertEquals(themeFromHash('#token=x'), null);
});

Deno.test("the tinted themes are the host colors' hues", () => {
  assertEquals(THEMES.map((t) => t.name), [
    'slate',
    'graphite',
    'green',
    'teal',
    'blue',
    'purple',
    'amber',
    'red',
  ]);
});
