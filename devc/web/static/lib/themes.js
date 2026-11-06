// devc web's color themes: palettes over `style.css`'s color tokens, chosen by the page's URL hash
// (`#…&theme=<name>`, as devc-desktop's View → Theme sets it), each in a dark and a light mode
// (the page follows `prefers-color-scheme`; devc-desktop's View → Appearance sets that). devc-desktop
// imports this file too, for its own views, its window's colors and its menu's swatches. Pure: no
// DOM here. See `.plans/archived/devc-ui-themes.md` and `.plans/devc-web-light-mode.md`.

/**
 * @typedef {object} ThemeColors
 * @property {string} bg @property {string} panel @property {string} panel2
 * @property {string} border @property {string} text @property {string} muted
 * @property {string} accent @property {string} termBg @property {string} rowHover
 * @property {string} rowCurrent @property {string} rowCurrentLine @property {string} section
 * @property {string} sidebarHead @property {string} tileBorder @property {string} tileFocus
 * @property {string} tileHead @property {string} tileHeadFocus @property {string} tileHeadLine
 * @property {string} tileLabel @property {string} tileRepo @property {string} tileBranch
 * @property {string} tileBranchMark @property {string} tileContainer
 * @property {string} tileContainerFocus
 */

/**
 * `colors` is the dark palette, `light` the light one.
 *
 * @typedef {{name: string, label: string, colors: ThemeColors, light: ThemeColors}} Theme
 */

/** @typedef {'dark' | 'light'} Mode */

/**
 * Slate is `style.css`'s own colors. Graphite is neutral gray. The rest are the host terminal
 * colors' own hues and saturations (devc-desktop's `HOST_COLORS`) through every token, each
 * background role at a fixed lightness (bg 7.5%, term 8.5%, sidebar head 11%, panel 13%, tile head
 * 14%, panel-2 16.5%; the host colors sit at 10–14%, and none is matched exactly), so they are as
 * solid as a host terminal. Any theme may go with any host color: with the same hue, a host tile
 * is told apart by its `HOST · user@host` strip.
 *
 * Each light palette is its dark one's hues, role for role, at a fixed lightness per role (term
 * 99%, panel 98%, bg 95% … text 16%), background roles' saturation capped at 40%, and any text role
 * short of its contrast (text 7, muted, section and accent 4.5, on bg, panel and term) darkened
 * until it reaches it.
 *
 * @type {readonly Theme[]}
 */
export const THEMES = [
  {
    // `style.css`'s own values.
    name: 'slate',
    label: 'Slate',
    colors: {
      bg: '#0e1218',
      panel: '#181e27',
      panel2: '#222c3a',
      border: '#303a49',
      text: '#cbd5e3',
      muted: '#8598b4',
      accent: '#83aff0',
      termBg: '#11131a',
      rowHover: '#253042',
      rowCurrent: '#2a3c55',
      rowCurrentLine: '#5b81b3',
      section: '#9caac0',
      sidebarHead: '#1b222d',
      tileBorder: '#354459',
      tileFocus: '#83aff0',
      tileHead: '#1d2734',
      tileHeadFocus: '#2c405f',
      tileHeadLine: '#344155',
      tileLabel: '#e0eaf7',
      tileRepo: '#b3c6e0',
      tileBranch: '#93a9c8',
      tileBranchMark: '#7d93b3',
      tileContainer: '#62748d',
      tileContainerFocus: '#7b8fac',
    },
    light: {
      bg: '#eff2f6',
      panel: '#f9fafb',
      panel2: '#dfe4ec',
      border: '#c1cad7',
      text: '#1d2735',
      muted: '#526685',
      accent: '#1657b6',
      termBg: '#fcfcfd',
      rowHover: '#d8dee9',
      rowCurrent: '#c8d4e4',
      rowCurrentLine: '#6287b6',
      section: '#4b5c76',
      sidebarHead: '#e6e9f0',
      tileBorder: '#b2bfd1',
      tileFocus: '#1657b6',
      tileHead: '#e8ecf2',
      tileHeadFocus: '#cbd6e7',
      tileHeadLine: '#c6cfdc',
      tileLabel: '#0d1c31',
      tileRepo: '#233957',
      tileBranch: '#374d6c',
      tileBranchMark: '#4b6181',
      tileContainer: '#697c96',
      tileContainerFocus: '#536784',
    },
  },
  {
    name: 'graphite',
    label: 'Graphite',
    colors: {
      bg: '#131313',
      panel: '#212121',
      panel2: '#2a2a2a',
      border: '#474747',
      text: '#dbdbdb',
      muted: '#9e9e9e',
      accent: '#c2c2c2',
      termBg: '#161616',
      rowHover: '#333333',
      rowCurrent: '#404040',
      rowCurrentLine: '#8c8c8c',
      section: '#b2b2b2',
      sidebarHead: '#1c1c1c',
      tileBorder: '#4c4c4c',
      tileFocus: '#c2c2c2',
      tileHead: '#242424',
      tileHeadFocus: '#454545',
      tileHeadLine: '#3d3d3d',
      tileLabel: '#ededed',
      tileRepo: '#cccccc',
      tileBranch: '#b0b0b0',
      tileBranchMark: '#969696',
      tileContainer: '#757575',
      tileContainerFocus: '#919191',
    },
    light: {
      bg: '#f2f2f2',
      panel: '#fafafa',
      panel2: '#e6e6e6',
      border: '#cccccc',
      text: '#292929',
      muted: '#6b6b6b',
      accent: '#666666',
      termBg: '#fcfcfc',
      rowHover: '#e0e0e0',
      rowCurrent: '#d6d6d6',
      rowCurrentLine: '#8c8c8c',
      section: '#616161',
      sidebarHead: '#ebebeb',
      tileBorder: '#c2c2c2',
      tileFocus: '#666666',
      tileHead: '#ededed',
      tileHeadFocus: '#d9d9d9',
      tileHeadLine: '#d1d1d1',
      tileLabel: '#1f1f1f',
      tileRepo: '#3d3d3d',
      tileBranch: '#525252',
      tileBranchMark: '#666666',
      tileContainer: '#808080',
      tileContainerFocus: '#6b6b6b',
    },
  },
  {
    name: 'green',
    label: 'Green',
    colors: {
      bg: '#0b1b13',
      panel: '#142e22',
      panel2: '#193b2b',
      border: '#365948',
      text: '#d5e2dc',
      muted: '#91ac9f',
      accent: '#69d3a0',
      termBg: '#0d1e16',
      rowHover: '#214534',
      rowCurrent: '#295741',
      rowCurrentLine: '#68b18d',
      section: '#a9bcb3',
      sidebarHead: '#11271c',
      tileBorder: '#3a5f4d',
      tileFocus: '#69d3a0',
      tileHead: '#153224',
      tileHeadFocus: '#2c5e46',
      tileHeadLine: '#2c4e3e',
      tileLabel: '#eaf1ed',
      tileRepo: '#c3d5cc',
      tileBranch: '#a5bbb0',
      tileBranchMark: '#8aa397',
      tileContainer: '#6a8176',
      tileContainerFocus: '#859e92',
    },
    light: {
      bg: '#edf7f2',
      panel: '#f8fcfa',
      panel2: '#dbf0e6',
      border: '#c0d8cc',
      text: '#213029',
      muted: '#587467',
      accent: '#257e53',
      termBg: '#fbfdfd',
      rowHover: '#d6ebe1',
      rowCurrent: '#c8e5d7',
      rowCurrentLine: '#68b18d',
      section: '#556d62',
      sidebarHead: '#e3f3eb',
      tileBorder: '#b3d1c2',
      tileFocus: '#257e53',
      tileHead: '#e6f4ed',
      tileHeadFocus: '#cbe7d9',
      tileHeadLine: '#c4ded2',
      tileLabel: '#18251e',
      tileRepo: '#32483d',
      tileBranch: '#465d52',
      tileBranchMark: '#5a7266',
      tileContainer: '#738c80',
      tileContainerFocus: '#5f776c',
    },
  },
  {
    name: 'teal',
    label: 'Teal',
    colors: {
      bg: '#0b191c',
      panel: '#132c30',
      panel2: '#18383d',
      border: '#35555a',
      text: '#d4e0e2',
      muted: '#8fa9ad',
      accent: '#64c9d8',
      termBg: '#0c1d1f',
      rowHover: '#1f4247',
      rowCurrent: '#275259',
      rowCurrentLine: '#64aab5',
      section: '#a8babd',
      sidebarHead: '#102528',
      tileBorder: '#385b61',
      tileFocus: '#64c9d8',
      tileHead: '#142f33',
      tileHeadFocus: '#2a5960',
      tileHeadLine: '#2a4b50',
      tileLabel: '#e9f0f1',
      tileRepo: '#c2d3d6',
      tileBranch: '#a4b9bc',
      tileBranchMark: '#89a1a4',
      tileContainer: '#687f82',
      tileContainerFocus: '#849b9f',
    },
    light: {
      bg: '#edf6f7',
      panel: '#f8fbfc',
      panel2: '#dbedf0',
      border: '#bfd6d9',
      text: '#212e31',
      muted: '#587479',
      accent: '#227986',
      termBg: '#fbfdfd',
      rowHover: '#d4e9ec',
      rowCurrent: '#c6e2e6',
      rowCurrentLine: '#64aab5',
      section: '#546a6e',
      sidebarHead: '#e2f1f3',
      tileBorder: '#b1cdd2',
      tileFocus: '#227986',
      tileHead: '#e6f2f4',
      tileHeadFocus: '#cae4e8',
      tileHeadLine: '#c3dcdf',
      tileLabel: '#182425',
      tileRepo: '#314649',
      tileBranch: '#455b5e',
      tileBranchMark: '#597073',
      tileContainer: '#718a8e',
      tileContainerFocus: '#5e7478',
    },
  },
  {
    name: 'blue',
    label: 'Blue',
    colors: {
      bg: '#0a101c',
      panel: '#111c31',
      panel2: '#16233e',
      border: '#33415c',
      text: '#d4d9e3',
      muted: '#8e99ae',
      accent: '#75a8f0',
      termBg: '#0b1220',
      rowHover: '#1d2c49',
      rowCurrent: '#24375b',
      rowCurrentLine: '#607eb8',
      section: '#a7afbe',
      sidebarHead: '#0f182a',
      tileBorder: '#364563',
      tileFocus: '#75a8f0',
      tileHead: '#131e35',
      tileHeadFocus: '#273b63',
      tileHeadLine: '#293652',
      tileLabel: '#e9ecf1',
      tileRepo: '#c1c8d7',
      tileBranch: '#a3acbd',
      tileBranchMark: '#8791a6',
      tileContainer: '#677183',
      tileContainerFocus: '#838ca0',
    },
    light: {
      bg: '#edf1f7',
      panel: '#f8f9fc',
      panel2: '#dbe2f0',
      border: '#bdc7db',
      text: '#202631',
      muted: '#59667d',
      accent: '#1458b8',
      termBg: '#fbfcfd',
      rowHover: '#d4dded',
      rowCurrent: '#c6d1e7',
      rowCurrentLine: '#607eb8',
      section: '#525c6f',
      sidebarHead: '#e2e8f3',
      tileBorder: '#b0bcd4',
      tileFocus: '#1458b8',
      tileHead: '#e6ebf4',
      tileHeadFocus: '#c9d4e8',
      tileHeadLine: '#c2cce0',
      tileLabel: '#181d25',
      tileRepo: '#30384a',
      tileBranch: '#444d5f',
      tileBranchMark: '#576175',
      tileContainer: '#707b8f',
      tileContainerFocus: '#5d6679',
    },
  },
  {
    name: 'purple',
    label: 'Purple',
    colors: {
      bg: '#110d19',
      panel: '#1d162c',
      panel2: '#251c38',
      border: '#423956',
      text: '#d9d6e1',
      muted: '#9a93a9',
      accent: '#b89de7',
      termBg: '#130f1d',
      rowHover: '#2d2442',
      rowCurrent: '#382d53',
      rowCurrentLine: '#806eab',
      section: '#afabba',
      sidebarHead: '#181325',
      tileBorder: '#463d5c',
      tileFocus: '#b89de7',
      tileHead: '#1f182f',
      tileHeadFocus: '#3d3059',
      tileHeadLine: '#382f4b',
      tileLabel: '#eceaf0',
      tileRepo: '#c9c4d4',
      tileBranch: '#aca7b9',
      tileBranchMark: '#928ca1',
      tileContainer: '#716c7f',
      tileContainerFocus: '#8d879b',
    },
    light: {
      bg: '#f1eef6',
      panel: '#f9f8fc',
      panel2: '#e2ddee',
      border: '#c8c2d6',
      text: '#26222f',
      muted: '#675f77',
      accent: '#5528a4',
      termBg: '#fcfcfd',
      rowHover: '#ddd7e9',
      rowCurrent: '#d1cae2',
      rowCurrentLine: '#806eab',
      section: '#5c576a',
      sidebarHead: '#e8e4f1',
      tileBorder: '#bdb5ce',
      tileFocus: '#5528a4',
      tileHead: '#ebe7f3',
      tileHeadFocus: '#d5cde4',
      tileHeadLine: '#cdc7dc',
      tileLabel: '#1d1924',
      tileRepo: '#3a3447',
      tileBranch: '#4d485b',
      tileBranchMark: '#625c70',
      tileContainer: '#7b758a',
      tileContainerFocus: '#676175',
    },
  },
  {
    name: 'amber',
    label: 'Amber',
    colors: {
      bg: '#1c170b',
      panel: '#302712',
      panel2: '#3d3217',
      border: '#5b4f34',
      text: '#e3ded4',
      muted: '#ada48f',
      accent: '#e7b655',
      termBg: '#1f1a0c',
      rowHover: '#483b1e',
      rowCurrent: '#5a4a26',
      rowCurrentLine: '#b69d63',
      section: '#bdb7a8',
      sidebarHead: '#29210f',
      tileBorder: '#615538',
      tileFocus: '#e7b655',
      tileHead: '#342a14',
      tileHeadFocus: '#615029',
      tileHeadLine: '#50452a',
      tileLabel: '#f1efe9',
      tileRepo: '#d6d0c2',
      tileBranch: '#bcb5a3',
      tileBranchMark: '#a59c88',
      tileContainer: '#827b68',
      tileContainerFocus: '#9f9784',
    },
    light: {
      bg: '#f7f4ed',
      panel: '#fcfbf8',
      panel2: '#f0eadb',
      border: '#dad1be',
      text: '#312c20',
      muted: '#796f58',
      accent: '#8f6614',
      termBg: '#fdfdfb',
      rowHover: '#ede5d4',
      rowCurrent: '#e7dcc6',
      rowCurrentLine: '#b69d63',
      section: '#6e6754',
      sidebarHead: '#f3eee2',
      tileBorder: '#d2c9b1',
      tileFocus: '#8f6614',
      tileHead: '#f4f0e6',
      tileHeadFocus: '#e8dfc9',
      tileHeadLine: '#dfd7c3',
      tileLabel: '#252218',
      tileRepo: '#494231',
      tileBranch: '#5e5745',
      tileBranchMark: '#746b58',
      tileContainer: '#8e8671',
      tileContainerFocus: '#78705e',
    },
  },
  {
    name: 'red',
    label: 'Red',
    colors: {
      bg: '#1a0d0e',
      panel: '#2c1618',
      panel2: '#381c1e',
      border: '#56393b',
      text: '#e1d6d7',
      muted: '#aa9394',
      accent: '#ea8689',
      termBg: '#1d0e10',
      rowHover: '#432326',
      rowCurrent: '#532c2f',
      rowCurrentLine: '#ab6d72',
      section: '#baabac',
      sidebarHead: '#261314',
      tileBorder: '#5c3d3f',
      tileFocus: '#ea8689',
      tileHead: '#30181a',
      tileHeadFocus: '#5a3033',
      tileHeadLine: '#4c2f31',
      tileLabel: '#f0eaeb',
      tileRepo: '#d4c4c5',
      tileBranch: '#b9a7a8',
      tileBranchMark: '#a18c8e',
      tileContainer: '#7f6b6d',
      tileContainerFocus: '#9c8789',
    },
    light: {
      bg: '#f7eeef',
      panel: '#fcf8f9',
      panel2: '#eeddde',
      border: '#d6c2c3',
      text: '#2f2224',
      muted: '#785e5f',
      accent: '#ae1e22',
      termBg: '#fdfcfc',
      rowHover: '#ead7d9',
      rowCurrent: '#e3cacc',
      rowCurrentLine: '#ab6d72',
      section: '#6a5759',
      sidebarHead: '#f1e4e5',
      tileBorder: '#ceb5b7',
      tileFocus: '#ae1e22',
      tileHead: '#f3e7e8',
      tileHeadFocus: '#e4cdcf',
      tileHeadLine: '#dcc6c8',
      tileLabel: '#24191b',
      tileRepo: '#473435',
      tileBranch: '#5b4849',
      tileBranchMark: '#705c5e',
      tileContainer: '#8a7577',
      tileContainerFocus: '#756163',
    },
  },
];

/** The default theme: `style.css`'s own colors. */
export const DEFAULT_THEME = 'slate';

/**
 * The theme named `name`, Slate for anything else.
 *
 * @param {unknown} name
 * @returns {Theme}
 */
export function themeNamed(name) {
  return THEMES.find((t) => t.name === name) ??
    /** @type {Theme} */ (THEMES.find((t) => t.name === DEFAULT_THEME));
}

/** Each token's CSS variable, in `style.css`'s names. */
const VARS = /** @type {const} */ ([
  ['bg', '--bg'],
  ['panel', '--panel'],
  ['panel2', '--panel-2'],
  ['border', '--border'],
  ['text', '--text'],
  ['muted', '--muted'],
  ['accent', '--accent'],
  ['termBg', '--term-bg'],
  ['rowHover', '--row-hover'],
  ['rowCurrent', '--row-current'],
  ['rowCurrentLine', '--row-current-line'],
  ['section', '--section'],
  ['sidebarHead', '--sidebar-head'],
  ['tileBorder', '--tile-border'],
  ['tileFocus', '--tile-focus'],
  ['tileHead', '--tile-head'],
  ['tileHeadFocus', '--tile-head-focus'],
  ['tileHeadLine', '--tile-head-line'],
  ['tileLabel', '--tile-label'],
  ['tileRepo', '--tile-repo'],
  ['tileBranch', '--tile-branch'],
  ['tileBranchMark', '--tile-branch-mark'],
  ['tileContainer', '--tile-container'],
  ['tileContainerFocus', '--tile-container-focus'],
]);

/**
 * The tokens every theme shares, one value per mode: status colors (also the viewer's syntax
 * colors), diffs and shadows. Dark is `style.css`'s own.
 *
 * @type {Readonly<Record<Mode, Readonly<Record<string, string>>>>}
 */
const SHARED = {
  dark: {
    '--idle': '#9aa9bd',
    '--working': '#6cc7e8',
    '--blocked': '#e9b87e',
    '--done': '#8bd6ae',
    '--unknown': '#b59cf0',
    '--danger': '#ff7b7b',
    '--diff-add': '#17331f',
    '--diff-del': '#3a1a1d',
    '--diff-add-word': '#2a6a3c',
    '--diff-del-word': '#7a2c33',
    '--shadow': '#00000066',
  },
  light: {
    '--idle': '#5d6b7e',
    '--working': '#087399',
    '--blocked': '#9a5b00',
    '--done': '#1f7a45',
    '--unknown': '#7048c4',
    '--danger': '#c42b2b',
    '--diff-add': '#dff3e4',
    '--diff-del': '#fbe3e4',
    '--diff-add-word': '#b4e3c0',
    '--diff-del-word': '#f4bcc1',
    '--shadow': '#00000022',
  },
};

/**
 * WCAG 2 relative luminance of `#rrggbb`.
 *
 * @param {string} hex
 * @returns {number}
 */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG 2 contrast ratio of two `#rrggbb` colors.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * Text on a filled `fill`: near-black or white, whichever stands out more.
 *
 * @param {string} fill
 * @returns {string}
 */
function onFill(fill) {
  return contrast('#0d0f14', fill) >= contrast('#ffffff', fill)
    ? '#0d0f14'
    : '#ffffff';
}

/**
 * A theme's palette in `mode`.
 *
 * @param {Theme} theme
 * @param {Mode} mode
 * @returns {ThemeColors}
 */
export function themeColors(theme, mode) {
  return mode === 'light' ? theme.light : theme.colors;
}

/**
 * A theme's CSS variables in `mode`: its palette, `--tile-focus-glow` (the focus color at alpha
 * `28`), the shared tokens and the text on filled accent, danger and blocked
 * (`--on-accent`, `--on-danger`, `--on-blocked`).
 *
 * @param {Theme} theme
 * @param {Mode} [mode]
 * @returns {Record<string, string>}
 */
export function themeVars(theme, mode = 'dark') {
  const colors = themeColors(theme, mode);
  const shared = SHARED[mode];
  /** @type {Record<string, string>} */
  const vars = {};
  for (const [key, name] of VARS) vars[name] = colors[key];
  vars['--tile-focus-glow'] = `${colors.tileFocus}28`;
  Object.assign(vars, shared);
  vars['--on-accent'] = onFill(colors.accent);
  vars['--on-danger'] = onFill(shared['--danger']);
  vars['--on-blocked'] = onFill(shared['--blocked']);
  return vars;
}

/** Light terminals' ANSI colors (VS Code Light's). */
const LIGHT_ANSI = {
  black: '#000000',
  red: '#cd3131',
  green: '#107c10',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5',
};

/**
 * A container terminal's xterm.js theme: dark is the background alone (xterm's own colors for the
 * rest); light adds foreground, cursor, selection and a light ANSI palette.
 *
 * @param {Theme} theme
 * @param {Mode} mode
 * @returns {Record<string, string>}
 */
export function terminalTheme(theme, mode) {
  const c = themeColors(theme, mode);
  if (mode !== 'light') return { background: c.termBg };
  return {
    background: c.termBg,
    foreground: c.text,
    cursor: c.text,
    cursorAccent: c.termBg,
    selectionBackground: `${c.accent}4d`,
    ...LIGHT_ANSI,
  };
}

/**
 * devc-desktop's View → Appearance value: `system`, `light` or `dark`; anything else is `system`.
 *
 * @param {unknown} v
 * @returns {'system' | 'light' | 'dark'}
 */
export function appearanceNamed(v) {
  return v === 'light' || v === 'dark' ? v : 'system';
}

/**
 * The theme a URL hash names (`#…&theme=<name>`), or `null` when it names none; an unknown name
 * is Slate.
 *
 * @param {string} hash  `location.hash`, `#` included or not
 * @returns {Theme | null}
 */
export function themeFromHash(hash) {
  const name = new URLSearchParams(hash.replace(/^#/, '')).get('theme');
  return name === null ? null : themeNamed(name);
}
