// devc web's color themes: dark palettes over `style.css`'s color tokens, chosen by the page's URL
// hash (`#…&theme=<name>`), as devc-desktop's View → Theme sets it. devc-desktop imports this file
// too, for its own views, its window's colors and its menu's swatches. Pure: no DOM here. See
// `.plans/devc-ui-themes.md`.

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

/** @typedef {{name: string, label: string, colors: ThemeColors}} Theme */

/** @type {readonly Theme[]} */
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
  },
  {
    name: 'graphite',
    label: 'Graphite',
    colors: {
      bg: '#121212',
      panel: '#1b1b1c',
      panel2: '#262628',
      border: '#3a3a3d',
      text: '#d4d4d6',
      muted: '#8e8e93',
      accent: '#e3a857',
      termBg: '#141414',
      rowHover: '#2a2a2d',
      rowCurrent: '#34312c',
      rowCurrentLine: '#b0874a',
      section: '#a1a1a6',
      sidebarHead: '#1e1e20',
      tileBorder: '#3d3d41',
      tileFocus: '#e3a857',
      tileHead: '#222224',
      tileHeadFocus: '#3a3328',
      tileHeadLine: '#3a3a3d',
      tileLabel: '#ececee',
      tileRepo: '#c4c4c8',
      tileBranch: '#a8a8ad',
      tileBranchMark: '#8e8e93',
      tileContainer: '#6e6e73',
      tileContainerFocus: '#8e8e93',
    },
  },
  {
    name: 'dusk',
    label: 'Dusk',
    colors: {
      bg: '#13111a',
      panel: '#1c1926',
      panel2: '#272336',
      border: '#3a3450',
      text: '#d6d1e6',
      muted: '#9a90b5',
      accent: '#b39ddb',
      termBg: '#15131c',
      rowHover: '#2a2540',
      rowCurrent: '#352d52',
      rowCurrentLine: '#8a76c2',
      section: '#a69cc2',
      sidebarHead: '#1f1b2b',
      tileBorder: '#3f3858',
      tileFocus: '#b39ddb',
      tileHead: '#221e30',
      tileHeadFocus: '#3a3058',
      tileHeadLine: '#3d3652',
      tileLabel: '#ebe6f7',
      tileRepo: '#c9bfe3',
      tileBranch: '#ab9fcc',
      tileBranchMark: '#9285b8',
      tileContainer: '#6e6489',
      tileContainerFocus: '#8a7fab',
    },
  },
  {
    name: 'mocha',
    label: 'Mocha',
    colors: {
      bg: '#16120f',
      panel: '#201a16',
      panel2: '#2c241e',
      border: '#43372d',
      text: '#e2d7cc',
      muted: '#a8968a',
      accent: '#d98e73',
      termBg: '#18130f',
      rowHover: '#31281f',
      rowCurrent: '#3d3127',
      rowCurrentLine: '#b5835e',
      section: '#b3a293',
      sidebarHead: '#241d18',
      tileBorder: '#4a3d33',
      tileFocus: '#d98e73',
      tileHead: '#271f1a',
      tileHeadFocus: '#44332a',
      tileHeadLine: '#463a30',
      tileLabel: '#f2e8de',
      tileRepo: '#d4c4b5',
      tileBranch: '#b8a596',
      tileBranchMark: '#9c8a7d',
      tileContainer: '#7a6a5e',
      tileContainerFocus: '#998779',
    },
  },
  {
    name: 'midnight',
    label: 'Midnight',
    colors: {
      bg: '#0a0e16',
      panel: '#0f1522',
      panel2: '#172033',
      border: '#24304a',
      text: '#c9d6ea',
      muted: '#7f93b3',
      accent: '#5fb3f9',
      termBg: '#0b0f18',
      rowHover: '#18233a',
      rowCurrent: '#1d2c4a',
      rowCurrentLine: '#4f7fc0',
      section: '#94a6c4',
      sidebarHead: '#111829',
      tileBorder: '#26344f',
      tileFocus: '#5fb3f9',
      tileHead: '#121a2b',
      tileHeadFocus: '#1d3152',
      tileHeadLine: '#243049',
      tileLabel: '#e2ecfa',
      tileRepo: '#adc2e2',
      tileBranch: '#8ea4c8',
      tileBranchMark: '#7489ad',
      tileContainer: '#56698a',
      tileContainerFocus: '#7086a8',
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
 * A theme's CSS variables, `--tile-focus-glow` (the focus color at alpha `28`) included.
 *
 * @param {Theme} theme
 * @returns {Record<string, string>}
 */
export function themeVars(theme) {
  /** @type {Record<string, string>} */
  const vars = {};
  for (const [key, name] of VARS) vars[name] = theme.colors[key];
  vars['--tile-focus-glow'] = `${theme.colors.tileFocus}28`;
  return vars;
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
