# devc-web-light-mode

Light mode for devc web and devc-desktop's own UI. Mode (dark or light) is separate from the
theme: every theme of devc-ui-themes (`.plans/archived/devc-ui-themes.md`) gets a light palette
in the same hue. The page follows the OS's `prefers-color-scheme`; devc-desktop adds **View →
Appearance** (System / Light / Dark), which it applies through Electron's
`nativeTheme.themeSource`, so its pages see it as `prefers-color-scheme`. Container terminals and
the code viewer go light too, with a full ANSI palette. Host terminals keep the host color in
both modes.

## Checklist

- [x] `devc/web/static/lib/themes.js`: a light palette per theme, the shared status and derived
      tokens per mode, `themeVars(theme, mode)`, `terminalTheme(theme, mode)`,
      `appearanceNamed` (§ Palettes, § themes.js API)
- [x] `style.css`: the new tokens in `:root` (dark, today's values), a
      `@media (prefers-color-scheme: light)` block with Slate's light values, the eight hardcoded
      colors replaced by tokens (§ style.css)
- [x] `client.js` applies the mode from `prefers-color-scheme`, live (§ devc web)
- [x] Container terminals (`renderer.js`) take `terminalTheme` and follow changes (§ devc web)
- [x] Code viewer (`viewer.js`): CodeMirror's `dark` flag follows the mode (§ devc web)
- [x] devc-desktop: **View → Appearance**, `appearance` in the state file,
      `nativeTheme.themeSource`, its own views and native colors in the current mode, its
      renderer CSS on tokens (§ devc-desktop)
- [x] `devc/README.md`, `devc-desktop/README.md`
- [ ] Validation (below)

## Palettes

### Light theme colors

Every theme in `THEMES` gains `light: ThemeColors` (same keys as `colors`, which stays the dark
palette, unchanged). Each light token is generated from the theme's dark token of the **same
role**: same HSL hue; same saturation, except the background roles (lightness ≥ 76 below), whose
saturation is capped at 40%; Graphite stays at 0. Lightness (HSL %) per role:

| roles                                                             | L (%) |
| ----------------------------------------------------------------- | ----- |
| `termBg`                                                          | 99    |
| `panel`                                                           | 98    |
| `bg`                                                              | 95    |
| `tileHead`                                                        | 93    |
| `sidebarHead`                                                     | 92    |
| `panel2`                                                          | 90    |
| `rowHover`                                                        | 88    |
| `tileHeadFocus`                                                   | 85    |
| `rowCurrent`                                                      | 84    |
| `tileHeadLine`                                                    | 82    |
| `border`                                                          | 80    |
| `tileBorder`                                                      | 76    |
| `rowCurrentLine`                                                  | 55    |
| `tileContainer`                                                   | 50    |
| `tileContainerFocus`, `muted`                                     | 42    |
| `tileBranchMark`, `accent` (`tileFocus` is set equal to `accent`) | 40    |
| `section`                                                         | 38    |
| `tileBranch`                                                      | 32    |
| `tileRepo`                                                        | 24    |
| `text`                                                            | 16    |
| `tileLabel`                                                       | 12    |

Then contrast (WCAG 2 relative luminance) is enforced: a role below its minimum against the
theme's light `bg`, `panel` and `termBg` (each) is darkened 1 L at a time until it passes. Minima:
`text` and `tileLabel` 7; `muted`, `section` and `accent` 4.5. Values are written into `themes.js`
as literal `#rrggbb` (generated once by a throwaway script, not at run time), like the dark ones.

### Shared tokens, per mode

These were hardcoded or not themed; they become tokens, one value per mode, the same for every
theme. Dark values are today's exactly.

| token             | dark (today) | light       |
| ----------------- | ------------ | ----------- |
| `--idle`          | `#9aa9bd`    | `#5d6b7e`   |
| `--working`       | `#6cc7e8`    | `#087399`   |
| `--blocked`       | `#e9b87e`    | `#9a5b00`   |
| `--done`          | `#8bd6ae`    | `#1f7a45`   |
| `--unknown`       | `#b59cf0`    | `#7048c4`   |
| `--danger`        | `#ff7b7b`    | `#c42b2b`   |
| `--diff-add`      | `#17331f`    | `#dff3e4`   |
| `--diff-del`      | `#3a1a1d`    | `#fbe3e4`   |
| `--diff-add-word` | `#2a6a3c`    | `#b4e3c0`   |
| `--diff-del-word` | `#7a2c33`    | `#f4bcc1`   |
| `--shadow`        | `#00000066`  | `#00000022` |

The status colors double as syntax colors in the viewer, so each light one must reach 4.5 against
every theme's light `termBg` and `panel` (a value given here that fails is darkened 1 L at a time,
and this table updated).

### Derived tokens

`themeVars` computes these from the palette it is given, so they are not in `ThemeColors`:

- `--tile-focus-glow`: `tileFocus` + alpha `28` (as today).
- `--on-accent`, `--on-danger`, `--on-blocked`: text on a filled `--accent` / `--danger` /
  `--blocked` background: `#0d0f14` or `#ffffff`, whichever has the higher contrast with that
  fill. (Dark mode gives `#0d0f14` throughout; the blocked badge's `#1a1206` becomes `#0d0f14`.)

### Terminal

`terminalTheme(theme, mode)` returns the xterm.js `ITheme` for container terminals:

- dark: `{ background: termBg }` only (xterm's defaults for the rest, as today).
- light: `background: termBg`, `foreground: text`, `cursor: text`, `cursorAccent: termBg`,
  `selectionBackground: accent + '4d'`, and this ANSI palette (VS Code Light's):
  `black #000000, red #cd3131, green #107c10, yellow #949800, blue #0451a5, magenta #bc05bc,
  cyan #0598bc, white #555555, brightBlack #666666, brightRed #cd3131, brightGreen #14ce14,
  brightYellow #b5ba00, brightBlue #0451a5, brightMagenta #bc05bc, brightCyan #0598bc,
  brightWhite #a5a5a5`.

The renderer also sets xterm's `minimumContrastRatio` to `4.5` in light mode and `1` (xterm's
default) in dark: TUIs that assume a dark background (bright white text, Claude Code's own UI)
stay readable without per-app palettes.

## themes.js API

Contract (devc-desktop imports it):

- `Theme` = `{ name, label, colors, light }`; `THEMES` keeps its order and names.
- `themeVars(theme, mode = 'dark')` → every token of devc-ui-themes, plus the shared tokens and
  derived tokens above, for that mode. `mode` is `'dark' | 'light'`.
- `terminalTheme(theme, mode)` → as § Terminal.
- `appearanceNamed(v)` → `'system' | 'light' | 'dark'`; anything else is `'system'`.
- `themeNamed`, `themeFromHash`, `DEFAULT_THEME` unchanged.

## style.css

- `:root` gains the shared and derived tokens with their dark values. `color-scheme: dark` stays
  there.
- After `:root`, `@media (prefers-color-scheme: light) { :root { … } }` holds Slate's light value
  for every token `themeVars` sets, and `color-scheme: light`. This is what a page with no
  `theme=` in its hash (a plain browser) shows in light mode, with no flash before JS runs.
- The hardcoded colors become tokens: `button.primary` (line ~2800) `color: var(--on-accent)`;
  `button.primary.danger` (~2891) `var(--on-danger)`; the blocked badge (~3078)
  `var(--on-blocked)`; `.diff-row` add/del (~3320, ~3325) `var(--diff-add)` / `var(--diff-del)`;
  `.diff-word` add/del (~3351, ~3357) `var(--diff-add-word)` / `var(--diff-del-word)`; the popup
  shadow (~3701) `0 4px 12px var(--shadow)`.
- The 39 `color-mix()` uses are left as they are (they mix tokens); fix any that read wrong in the
  light screenshots (Validation) by mixing tokens differently, never by adding a hardcoded color.

**Gotcha:** `web_themes_test.ts` reads `style.css`'s first `:root` block with
`/:root\s*\{([^}]*)\}/`. The top-level `:root` must stay first in the file, so that this still
finds the dark values. The light values are read from the `:root` inside
`@media (prefers-color-scheme: light) {`, whose own closing brace the `[^}]*` match stops before.

## devc web

- `client.js`: the mode is `matchMedia('(prefers-color-scheme: light)').matches ? 'light' :
  'dark'`. It sets `data-mode="<mode>"` on `<html>` always. With `theme=` in the hash it sets
  `themeVars(theme, mode)` on `<html>`'s style; without, it sets none (style.css's own, by media
  query). It re-applies on `hashchange` and on the media query's `change` event, and dispatches
  `devc-theme` when either theme or mode changed. **Gotcha:** today's early return
  (`root.dataset.theme === theme.name`) must also compare the mode, or a mode change with the same
  theme is ignored. Still no storage: hash and media query are the only inputs.
- `renderer.js`: `theme: terminalTheme(theme, mode)` and `minimumContrastRatio` at creation and
  on `devc-theme`, setting `term.options.theme` to the new object outright (not spread over the
  old one, or light ANSI colors would survive a switch to dark). The theme is
  `themeFromHash(location.hash) ?? themeNamed(DEFAULT_THEME)`, the mode from `<html data-mode>`.
- `viewer.js`: the `EditorView.theme(…, { dark: true })` becomes two (`dark: true` / `false`,
  same rules) in a `Compartment`, reconfigured on `devc-theme` for every open editor. The highlight
  style already reads tokens.

## devc-desktop

- **View → Appearance**: radio items System, Light, Dark, placed above **Theme**. Saved as
  `"appearance": "<value>"` in `desktop-state.json` (read with `appearanceNamed`; missing →
  `system`). Applied as `nativeTheme.themeSource = <value>` after `loadState()` and before the
  window is created, and on each change. Electron makes every webContents' `prefers-color-scheme`
  follow `themeSource`, so devc web's views switch by themselves: no hash change, no reload.
- The mode for the app's own views is `nativeTheme.shouldUseDarkColors ? 'dark' : 'light'`.
  `themeCss()` uses `themeVars(uiTheme, mode)`; `nativeColors()` uses that mode's palette. On
  `nativeTheme.on('updated', …)` (fired for a menu change and for the OS switching under
  System) re-run `themeView` for every themed view and `nativeColors()`.
- Renderer CSS onto tokens: `status.css` line ~51 `#0d0f14` → `var(--on-accent)`;
  `actions.css` `#f07a6a` / `#7fd18b` → `var(--danger)` / `var(--done)`; `menu.css`'s
  `color-scheme: dark` → `color-scheme: light dark` and its shadow → `var(--shadow)`. The
  fallback values inside `var(--x, #…)` and the `:root` defaults in `menu.css`/`status.css` stay
  (they are overridden by the inserted CSS).
- Unchanged: `host.css`, `slot.css` (a host terminal and its slot keep the host color and
  `color-scheme: dark`), the Theme and Host Terminal Color swatches.
- **Gotcha:** on Linux, `shouldUseDarkColors` under System follows the GTK theme, which under
  Xvfb is usually light; validate with explicit Light and Dark.

## Validation

- [x] `cd devc && deno test -A tests/web_themes_test.ts tests/web_layout_test.ts` pass, with
      `web_themes_test.ts` extended: every theme's `light` has every `ThemeColors` key as
      `#rrggbb`; `themeVars(t, 'light')` and `themeVars(t, 'dark')` set the same keys, all shared
      and derived tokens included; Slate dark equals `style.css`'s top-level `:root` and Slate
      light equals its `prefers-color-scheme: light` `:root`, token for token; for every theme in
      light mode `text` and `tileLabel` ≥ 7 and `muted`, `section`, `accent` and the six status
      colors ≥ 4.5 against `bg`, `panel` and `termBg`; in both modes `--on-accent`,
      `--on-danger`, `--on-blocked` ≥ 4.5 against their fills; `terminalTheme(t, 'light')` has
      the 16 ANSI keys above and `terminalTheme(t, 'dark')` only `background`;
      `appearanceNamed` maps unknown values to `system`; `style.css` has no hex color outside
      `:root` blocks other than those listed as staying (text on accent, diff and shadow gone).
- [x] `cd devc && deno task check` passes (the static files are not in it; the tests above import
      `themes.js`).
- [x] `cd devc-desktop && npm run check && npm test` pass.
- [x] `deno fmt --check` on every touched file.
- [ ] Browser, no devc-desktop: devc web in Chromium with DevTools' **Emulate CSS media feature
      prefers-color-scheme: light**, then dark: the page, an open container terminal (its
      contents kept) and a file viewer switch live; screenshots of `/` in light mode with the
      sidebar, a terminal, a viewer and a diff tile open, for the user.
- [ ] **Not run** (no Docker here, so devc-desktop's devc web cannot start): Linux, real app under Xvfb (as devc-ui-themes, through a temporary key since the menu bar is
      unreachable): Light and Dark switch `/main`, `/sidebar`, the status strip, the Containers
      pane, the title bar, the rail and the drawer's frame live, for at least Slate, Graphite and
      Amber; host terminals keep the host color; the choice survives a restart. Screenshots for
      the user.
- [ ] The Mac apps built (`npm run build:mac`: done, `dist/mac/devcd.app` and
      `dist/mac-arm64/devcd.app`), and the user's look on macOS, including System
      following the OS appearance switch.

## Relevant Files

| File                                    | Change                                                        |
| --------------------------------------- | ------------------------------------------------------------- |
| `devc/web/static/lib/themes.js`         | Light palettes, shared/derived tokens, new helpers            |
| `devc/web/static/style.css`             | New tokens, light media block, hardcoded colors → tokens      |
| `devc/web/static/client.js`             | Mode from `prefers-color-scheme`, live                        |
| `devc/web/static/renderer.js`           | `terminalTheme`, `minimumContrastRatio`, follows `devc-theme` |
| `devc/web/static/viewer.js`             | Dark/light CodeMirror theme in a `Compartment`                |
| `devc/tests/web_themes_test.ts`         | Tests above                                                   |
| `devc/README.md`                        | Light mode follows `prefers-color-scheme`                     |
| `devc-desktop/src/main/main.ts`         | View → Appearance, state, `nativeTheme`, mode for own views   |
| `devc-desktop/src/renderer/status.css`  | `--on-accent`                                                 |
| `devc-desktop/src/renderer/actions.css` | `--danger`, `--done`                                          |
| `devc-desktop/src/renderer/menu.css`    | `color-scheme`, `--shadow`                                    |
| `devc-desktop/README.md`                | View → Appearance                                             |
| `.plans/PLAN.md`                        | Status entry and phase row                                    |
