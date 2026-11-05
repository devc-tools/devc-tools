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

/**
 * Slate is `style.css`'s own colors. Each of the others is one hue through every token: its
 * backgrounds at a fixed lightness per role (bg 7.5%, term 8.5%, sidebar head 10.5%, panel 12.5%,
 * tile head 13.5%, panel-2 16.5%), at a saturation chosen to keep them at least 9 (RGB distance)
 * from every host color, as Slate is: the host colors cover most hues at this darkness, which is
 * why Dusk is plum, Midnight indigo and Mocha a red-brown.
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
  },
  {
    name: 'graphite',
    label: 'Graphite',
    colors: {
      bg: '#131313',
      panel: '#202020',
      panel2: '#2a2a2a',
      border: '#474747',
      text: '#dbdbdb',
      muted: '#9e9e9e',
      accent: '#e5b46c',
      termBg: '#161616',
      rowHover: '#333333',
      rowCurrent: '#404040',
      rowCurrentLine: '#8c8c8c',
      section: '#b2b2b2',
      sidebarHead: '#1b1b1b',
      tileBorder: '#4c4c4c',
      tileFocus: '#e5b46c',
      tileHead: '#222222',
      tileHeadFocus: '#454545',
      tileHeadLine: '#3d3d3d',
      tileLabel: '#ededed',
      tileRepo: '#cccccc',
      tileBranch: '#b0b0b0',
      tileBranchMark: '#969696',
      tileContainer: '#757575',
      tileContainerFocus: '#919191',
    },
  },
  {
    name: 'dusk',
    label: 'Dusk',
    colors: {
      bg: '#1d0a1d',
      panel: '#301030',
      panel2: '#3f153f',
      border: '#5d325d',
      text: '#e3d3e3',
      muted: '#af8daf',
      accent: '#e495e4',
      termBg: '#210b21',
      rowHover: '#4a1c4a',
      rowCurrent: '#5c235c',
      rowCurrentLine: '#ba5eba',
      section: '#bea7be',
      sidebarHead: '#280d28',
      tileBorder: '#633663',
      tileFocus: '#e495e4',
      tileHead: '#341134',
      tileHeadFocus: '#642664',
      tileHeadLine: '#532853',
      tileLabel: '#f2e9f2',
      tileRepo: '#d7c1d7',
      tileBranch: '#bea2be',
      tileBranchMark: '#a687a6',
      tileContainer: '#846784',
      tileContainerFocus: '#a182a1',
    },
  },
  {
    name: 'mocha',
    label: 'Mocha',
    colors: {
      bg: '#1d0f0a',
      panel: '#301a10',
      panel2: '#3f2215',
      border: '#5d3f32',
      text: '#e3d8d3',
      muted: '#af978d',
      accent: '#e79a74',
      termBg: '#21110b',
      rowHover: '#4a2a1c',
      rowCurrent: '#5c3423',
      rowCurrentLine: '#ba7a5e',
      section: '#beaea7',
      sidebarHead: '#28150d',
      tileBorder: '#634336',
      tileFocus: '#e79a74',
      tileHead: '#341c11',
      tileHeadFocus: '#643826',
      tileHeadLine: '#533528',
      tileLabel: '#f2ebe9',
      tileRepo: '#d7c7c1',
      tileBranch: '#beaaa2',
      tileBranchMark: '#a69087',
      tileContainer: '#846f67',
      tileContainerFocus: '#a18b82',
    },
  },
  {
    name: 'midnight',
    label: 'Midnight',
    colors: {
      bg: '#0b0a1d',
      panel: '#131030',
      panel2: '#19153f',
      border: '#36325d',
      text: '#d5d3e3',
      muted: '#908daf',
      accent: '#6892f3',
      termBg: '#0d0b21',
      rowHover: '#201c4a',
      rowCurrent: '#28235c',
      rowCurrentLine: '#665eba',
      section: '#a9a7be',
      sidebarHead: '#100d28',
      tileBorder: '#393663',
      tileFocus: '#6892f3',
      tileHead: '#141134',
      tileHeadFocus: '#2b2664',
      tileHeadLine: '#2b2853',
      tileLabel: '#e9e9f2',
      tileRepo: '#c2c1d7',
      tileBranch: '#a4a2be',
      tileBranchMark: '#8987a6',
      tileContainer: '#696784',
      tileContainerFocus: '#8582a1',
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
