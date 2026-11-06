// devc web's color themes (`web/static/lib/themes.js`), which devc-desktop's View → Theme picks.
import { assert, assertEquals } from 'jsr:@std/assert';
import {
  appearanceNamed,
  contrast,
  DEFAULT_THEME,
  terminalTheme,
  themeFromHash,
  themeNamed,
  THEMES,
  themeVars,
} from '../web/static/lib/themes.js';

const styleCss = () =>
  Deno.readTextFile(new URL('../web/static/style.css', import.meta.url));

/** A `:root { … }` block's custom properties, as `{'--name': 'value'}`. */
function blockVars(block: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars[m[1]] = m[2].trim();
  }
  return vars;
}

/** `style.css`'s first `:root` block: the dark values. */
async function rootVars(): Promise<Record<string, string>> {
  return blockVars(/:root\s*\{([^}]*)\}/.exec(await styleCss())?.[1] ?? '');
}

/** `style.css`'s `:root` inside `@media (prefers-color-scheme: light)`. */
async function lightRootVars(): Promise<Record<string, string>> {
  const re =
    /@media \(prefers-color-scheme: light\)\s*\{\s*:root\s*\{([^}]*)\}/;
  return blockVars(re.exec(await styleCss())?.[1] ?? '');
}

const MODES = ['dark', 'light'] as const;
const STATUS = [
  '--idle',
  '--working',
  '--blocked',
  '--done',
  '--unknown',
  '--danger',
];

Deno.test('every theme sets every token in both modes, as #rrggbb (alpha ones #rrggbbaa)', () => {
  const names = Object.keys(themeVars(THEMES[0])).sort();
  assertEquals(names.length, 25 + 11 + 3);
  for (const theme of THEMES) {
    assertEquals(
      Object.keys(theme.light).sort(),
      Object.keys(theme.colors).sort(),
    );
    for (const mode of MODES) {
      const vars = themeVars(theme, mode);
      assertEquals(Object.keys(vars).sort(), names, `${theme.name} ${mode}`);
      for (const [name, value] of Object.entries(vars)) {
        const re = name === '--tile-focus-glow' || name === '--shadow'
          ? /^#[0-9a-f]{8}$/
          : /^#[0-9a-f]{6}$/;
        assert(re.test(value), `${theme.name} ${mode} ${name} ${value}`);
      }
    }
  }
});

Deno.test("slate is style.css's own colors, dark and light", async () => {
  const slate = themeNamed('slate');
  for (
    const [root, mode] of [
      [await rootVars(), 'dark'],
      [await lightRootVars(), 'light'],
    ] as const
  ) {
    for (const [name, value] of Object.entries(themeVars(slate, mode))) {
      assertEquals(root[name]?.toLowerCase(), value, `${mode} ${name}`);
    }
  }
});

Deno.test('light palettes are readable', () => {
  for (const theme of THEMES) {
    const c = theme.light;
    const vars = themeVars(theme, 'light');
    for (const bg of [c.bg, c.panel, c.termBg]) {
      for (
        const [k, min] of [['text', 7], ['tileLabel', 7], ['muted', 4.5], [
          'section',
          4.5,
        ], ['accent', 4.5]] as const
      ) {
        assert(contrast(c[k], bg) >= min, `${theme.name} ${k} on ${bg}`);
      }
      for (const k of STATUS) {
        assert(contrast(vars[k], bg) >= 4.5, `${theme.name} ${k} on ${bg}`);
      }
    }
  }
});

Deno.test('text on a filled accent, danger or blocked is readable in both modes', () => {
  for (const theme of THEMES) {
    for (const mode of MODES) {
      const v = themeVars(theme, mode);
      for (
        const [on, fill] of [['--on-accent', '--accent'], [
          '--on-danger',
          '--danger',
        ], ['--on-blocked', '--blocked']]
      ) {
        assert(contrast(v[on], v[fill]) >= 4.5, `${theme.name} ${mode} ${on}`);
      }
    }
  }
});

Deno.test('terminal themes: dark is the background alone, light a full palette', () => {
  const slate = themeNamed('slate');
  assertEquals(terminalTheme(slate, 'dark'), {
    background: slate.colors.termBg,
  });
  const light = terminalTheme(slate, 'light');
  assertEquals(light.background, slate.light.termBg);
  assertEquals(light.foreground, slate.light.text);
  for (
    const color of [
      'black',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'white',
    ]
  ) {
    const bright = `bright${color[0].toUpperCase()}${color.slice(1)}`;
    assert(/^#[0-9a-f]{6}$/.test(light[color]), color);
    assert(/^#[0-9a-f]{6}$/.test(light[bright]), bright);
  }
});

Deno.test('appearanceNamed: system, light or dark; anything else is system', () => {
  assertEquals(appearanceNamed('light'), 'light');
  assertEquals(appearanceNamed('dark'), 'dark');
  assertEquals(appearanceNamed('system'), 'system');
  assertEquals(appearanceNamed('nope'), 'system');
  assertEquals(appearanceNamed(undefined), 'system');
});

Deno.test("style.css's only literal colors outside :root are the ones meant to stay", async () => {
  const css = (await styleCss())
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/:root\s*\{[^}]*\}/g, '');
  const found = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])
    .sort();
  // The brand letter (dark mode), the checkerboard, an iframe page's white.
  assertEquals(found, ['#a5c6b9', '#c8c8c8', '#f4f4f4', '#fff']);
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
