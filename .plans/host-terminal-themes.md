# devc-desktop: host terminals are themed like devc web, in a theme of their own

Decided with the user on 2026-11-06. Runs before `host-terminal-herdr`.

Host terminals were left dark-only by `devc-web-light-mode` ("host terminals keep the host color"):
`HOST_COLORS` are fixed dark backgrounds, `slot.css` says `color-scheme: dark` and hardcodes its
text and paste bar colors, and the terminal takes xterm.js's dark defaults. That was not the
design. A host terminal is themed exactly as devc web is — a theme from `lib/themes.js`, in the
current mode — except that **View → Host Terminal Color** picks _which_ theme, so it can differ
from devc web's.

## Checklist

- [ ] `policy.ts`: Host Terminal Color is a theme choice (`HOST_THEMES`, `hostThemeOf`); fixed
      backgrounds are gone.
- [ ] `main.ts`: the drawer's and host tiles' views are themed with the host theme in the current
      mode (`themeVars`), and re-themed on a host theme change and on `nativeTheme` `updated`.
- [ ] Host terminals' xterm.js options come from `terminalTheme(hostTheme, mode)` and
      `minimumContrastRatio` (4.5 light, 1 dark), as container terminals'; replaced outright on a
      change.
- [ ] `host.css`, `slot.css`: no hardcoded colors; `color-scheme` follows the mode.
- [ ] Menu swatches from the theme, as View → Theme's.
- [ ] Tests; `devc-desktop/README.md`'s Host Terminal Color text.

## Decisions

- **D1: the choices.** View → Host Terminal Color lists **Same as Theme**, then every theme in
  `THEMES` order (Slate, Graphite, Green, Teal, Blue, Purple, Amber, Red). Saved as `hostColor`
  (unchanged key): a theme name, or `none` for Same as Theme. A saved `green`, `teal`, `blue`,
  `purple`, `amber` or `red` is that theme; `none` is Same as Theme; anything else or missing is
  `green` (today's default).
- **D2: what the host theme covers.** Everything in the host pages: the drawer's tiles, tabs and
  strip (devc web's `style.css` tokens), a host tile's strip and paste bar, the terminal. The app
  inserts `themeVars(hostTheme, uiMode())` into `hostView` and each slot view instead of
  `uiTheme`'s; every other view of the app keeps `uiTheme`. Same as Theme is `uiTheme`, and then
  follows View → Theme.
- **D3: the terminal.** `--host-bg` is gone; the terminal background is the theme's `termBg` in
  the mode (`--term-bg` from `themeVars`). The xterm.js `theme` is `terminalTheme(hostTheme, mode)`
  and `minimumContrastRatio` is `4.5` light, `1` dark, assigned whole on each change so no light
  color survives a switch to dark (as `renderer.js`'s `onTheme`). The main process computes them
  and sends them: `host-term:info`'s `color` and the `host-term:color` message become
  `{theme: Record<string, string>, minimumContrastRatio: number}`. A slot view's and the host
  view's native background (`setBackgroundColor`) is the theme's `termBg` in the mode.
- **D4: when it changes.** On Host Terminal Color, on View → Theme while Same as Theme, and on
  `nativeTheme` `updated` (View → Appearance or the OS): `retheme` re-themes the host views with
  the host theme and resends `host-term:color` to the drawer and every slot.
- **D5: CSS.** `slot.css`: `color: var(--text)`, the paste bar `var(--panel)`, the strip's edge
  `var(--border)`; `color-scheme: light dark` in both sheets (the page follows
  `prefers-color-scheme`, which `nativeTheme.themeSource` sets). `host.css`'s `.host-term` and
  `#tiles .lm_content` take `var(--term-bg)`.
- **D6: swatches.** Each Host Terminal Color item's swatch is View → Theme's for that theme
  (`swatchTone(t.colors.panel)`, edged in `t.colors.panel`); Same as Theme's is the current
  `uiTheme`'s.

## Contracts

`policy.ts` (replacing `HostColor`, `HOST_COLORS`, `hostColorOf`):

```ts
export interface HostThemeChoice {
  value: string;
  label: string;
} // value: a theme name or 'none'
/** Same as Theme, then THEMES in order. */
export const HOST_THEMES: readonly HostThemeChoice[];
/** The saved `hostColor`'s choice: a theme name, 'none', or 'green' for anything else. */
export function hostThemeOf(saved: unknown): HostThemeChoice;
/** The theme a choice stands for: `uiTheme` for 'none'. */
export function hostTheme(choice: HostThemeChoice, uiTheme: Theme): Theme;
/** What a host terminal's xterm.js takes. */
export function hostTerminalOptions(
  theme: Theme,
  mode: 'light' | 'dark',
): { theme: Record<string, string>; minimumContrastRatio: number };
```

## Validation

- [ ] `cd devc-desktop && npm run check && npm test`; `policy.test.ts`:
  - [ ] `HOST_THEMES.map((c) => c.label)` is `['Same as Theme', 'Slate', 'Graphite', 'Green',
        'Teal', 'Blue', 'Purple', 'Amber', 'Red']`.
  - [ ] `hostThemeOf('blue').value === 'blue'`, `hostThemeOf('none').value === 'none'`,
        `hostThemeOf('pink').value === 'green'`, `hostThemeOf(undefined).value === 'green'`.
  - [ ] `hostTheme(hostThemeOf('none'), themeNamed('teal')).name === 'teal'`;
        `hostTheme(hostThemeOf('red'), themeNamed('teal')).name === 'red'`.
  - [ ] `hostTerminalOptions(themeNamed('green'), 'light')` equals
        `{theme: terminalTheme(themeNamed('green'), 'light'), minimumContrastRatio: 4.5}`, and
        `'dark'` gives ratio `1` and `{background: themeNamed('green').colors.termBg}`.
- [ ] `grep -n "#[0-9a-fA-F]\{6\}\|rgb(" devc-desktop/src/renderer/slot.css devc-desktop/src/renderer/host.css`
      finds nothing; `grep -rn "host-bg\|HOST_COLORS\|hostColorOf" devc-desktop/src devc-desktop/tests`
      finds nothing.
- [ ] `deno fmt --check` on touched files.
- [ ] `cd devc-desktop && npm run build:mac` succeeds.
- [ ] Real app (`npm start` on Linux, and the Mac build), drawer and a host tile each:
  - [ ] View → Appearance → Light: the host terminal goes light in its host theme's hue (green by
        default), with dark text; `ls --color` stays readable. → Dark: back to dark, no light
        color left over.
  - [ ] Host Terminal Color → Purple, then Same as Theme: the terminal, tabs, strip and paste bar
        follow at once, in both modes; under Same as Theme, View → Theme → Teal changes them too.
  - [ ] The choice survives a restart; a saved `hostColor` from before (`blue`) shows as Blue.
  - [ ] Resizing or moving a host tile shows no flash of another color.
  - [ ] The menu's swatches match View → Theme's for the same theme.

## Relevant Files

- `devc-desktop/src/main/policy.ts`
- `devc-desktop/src/main/main.ts` (`setHostColor`, `retheme`, `themed`/`themeView` for host views,
  `host-term:info`, the slot view's background, the View menu)
- `devc-desktop/src/preload/host.ts` (`onColor`'s payload)
- `devc-desktop/src/renderer/host.ts`, `devc-desktop/src/renderer/slot.ts` (apply the options)
- `devc-desktop/src/renderer/host.css`, `devc-desktop/src/renderer/slot.css`
- `devc-desktop/tests/policy.test.ts`
- `devc-desktop/README.md` (Host Terminal Color, light mode)
- `.plans/PLAN.md`
