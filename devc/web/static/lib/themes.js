// devc web's color themes: dark palettes over `style.css`'s color tokens, chosen by the page's URL
// hash (`#…&theme=<name>`), as devc-desktop's View → Theme sets it. devc-desktop imports this file
// too, for its own views, its window's colors and its menu's swatches. Pure: no DOM here. See
// `.plans/archived/devc-ui-themes.md`.

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
 * Slate is `style.css`'s own colors. Graphite is neutral gray. The rest are the host terminal
 * colors' own hues and saturations (devc-desktop's `HOST_COLORS`) through every token, each
 * background role at a fixed lightness (bg 7.5%, term 8.5%, sidebar head 11%, panel 13%, tile head
 * 14%, panel-2 16.5%; the host colors sit at 10–14%, and none is matched exactly), so they are as
 * solid as a host terminal. Any theme may go with any host color: with the same hue, a host tile
 * is told apart by its `HOST · user@host` strip.
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
