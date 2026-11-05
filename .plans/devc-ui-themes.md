# devc-ui-themes

Dark color themes for devc web and devc-desktop's own UI (not the host terminals, which keep
their own **Host Terminal Color**). One palette list, in devc web, used by both: devc web applies
a theme from its URL hash; devc-desktop picks it under **View → Theme**, with a color swatch on
each menu item, and passes it on.

## Checklist

- [x] `devc/web/static/lib/themes.js`: the palettes and the pure helpers (§ Themes)
- [x] devc web applies `#…&theme=<name>` on load and on `hashchange`, its container terminals
      included (§ devc web)
- [x] devc-desktop: **View → Theme** with swatches, `uiTheme` in the state file, the theme in
      every devc web view's hash, its own views themed by inserted CSS, the window and title-bar
      colors (§ devc-desktop)
- [x] Swatches on **View → Host Terminal Color** too
- [x] `devc-desktop/README.md` and `devc/README.md`
- [ ] Validation (below)

## Themes

Eight dark palettes. `slate` is today's colors exactly and the default; `graphite` is neutral
gray. The other six are solid tints in the host colors' own hues and saturations (revised twice
after the first build, at the user's word: accent-only tints were too subtle, then hue-shifted
tints kept apart from the host colors were not what was wanted; "solid tints, no restriction").
Each background role sits at a fixed lightness (bg 7.5%, term 8.5%, sidebar head 11%, panel 13%,
tile head 14%, panel-2 16.5%), so none matches a host color exactly; any theme may go with any host
color, and when they share a hue a host tile is told apart by its `HOST · user@host` strip.

| name       | label    | look                             |
| ---------- | -------- | -------------------------------- |
| `slate`    | Slate    | today's blue-gray, blue accent   |
| `graphite` | Graphite | neutral grays, light-gray accent |
| `green`    | Green    | the green host color's hue       |
| `teal`     | Teal     | the teal host color's hue        |
| `blue`     | Blue     | the blue host color's hue        |
| `purple`   | Purple   | the purple host color's hue      |
| `amber`    | Amber    | the amber host color's hue       |
| `red`      | Red      | the red host color's hue         |

Each theme sets these devc web tokens (the `:root` variables in `style.css` of the same names):
`--bg --panel --panel-2 --border --text --muted --accent --term-bg --row-hover --row-current
--row-current-line --section --sidebar-head --tile-border --tile-focus --tile-focus-glow
--tile-head --tile-head-focus --tile-head-line --tile-label --tile-repo --tile-branch
--tile-branch-mark --tile-container --tile-container-focus`. `--tile-focus-glow` is
`--tile-focus` with alpha `28`. Status colors (`--idle`, `--working`, …), `--danger` and the other
hardcoded colors in `style.css` stay as they are on every theme.

`lib/themes.js` exports `THEMES` (in the table's order), `themeNamed(name)` (unknown or missing →
`slate`), `themeVars(theme)` (`{'--bg': '#…', …}`, every token above) and `themeFromHash(hash)`
(the `theme` parameter, or `null`).

## devc web

- `client.js` (imported by every page) applies `themeFromHash(location.hash)` at once and on each
  `hashchange`: each variable set on `document.documentElement.style`, and
  `data-theme="<name>"` on `<html>`. No `theme` parameter: nothing is set (`style.css`'s own
  values, Slate). It never reads or writes storage: the hash is the only input.
- Container terminals (`renderer.js`) take their background from `--term-bg` when made, and
  again on a `devc-theme` event `client.js` dispatches on `window` after applying a theme.

## devc-desktop

- **View → Theme**: radio items in table order, each with a 16×16 swatch icon (the theme's
  `--panel`, solid, with a 1 px gray edge, as the host colors' swatches), made with
  `nativeImage.createFromBitmap`.
  Saved as `"uiTheme": "<name>"` in `desktop-state.json`; unknown or missing → `slate`.
- **View → Host Terminal Color** items get swatches too (the color's background, with a 1 px
  `--border` edge of the current theme).
- **devc web's views** (`/main`, `/sidebar`, `/host-status`): `devcPage` adds `&theme=<name>` to
  every URL it builds; a change sets `theme=` in each view's hash by a hash-only load (nothing
  reloads), as `setColumn` does for `sidebar=`.
- **The app's own views** (title bar, rail, status, overlay menu, Containers pane, the drawer's
  page and the host tiles' pages): `webContents.insertCSS(':root{…}')` with `themeVars`, inserted
  again on every `dom-ready` and replaced (old key removed) on a change. Their stylesheets read the
  same variable names: `rail.css`'s two hardcoded colors become `var(--border)` /
  `var(--accent)`, `titlebar.css`'s `--bg` becomes `var(--sidebar-head)`-based. Host terminals'
  backgrounds stay the host color.
- **Native colors**: the window's and views' background (`--bg`), the rail view's background
  (`--border`), and on Linux/Windows `win.setTitleBarOverlay({ color: --sidebar-head,
  symbolColor: --text })`, set at start and on each change.

## Validation

- [x] `cd devc && deno test -A tests/web_layout_test.ts tests/web_themes_test.ts` pass, with a new
      `web_themes_test.ts`: every theme sets every token, as `#rrggbb` (`--tile-focus-glow`
      `#rrggbbaa`); `slate` equals `style.css`'s `:root` values for each token; names are unique;
      `themeNamed` falls back to `slate`; `themeFromHash` reads `theme=` only; the theme list is
      Slate, Graphite and the six host hues, in that order (no host color appears verbatim in
      devc web: `web_desktop_test.ts`).
- [x] `cd devc-desktop && npm run check && npm test` pass, with tests for the swatch bitmap (size,
      BGRA order, border and inner square). (`uiTheme` is read with `themeNamed`, tested in
      `web_themes_test.ts`: `policy.ts` cannot import devc web's files under `node --test`.)
- [x] `deno fmt --check` on every touched file.
- [x] Linux, real app: each theme from **View → Theme** recolors `/main`, `/sidebar`, the status
      strip, the Containers pane, the title bar, the rail and the drawer's frame at once, with no
      reload (an open container terminal keeps its contents) and host terminals keep the host
      color; the choice survives a restart; the menus show swatches (screenshot). Done under
      Xvfb through a temporary key that cycled the themes (the menu bar is unreachable there),
      with no container running: themes switch live on every part listed, host terminals stay
      green, Graphite came back after a restart. **Not seen here:** the swatches (no menu bar)
      and a container terminal's background; both are for the user's look on macOS.
- [ ] The Mac apps built (`npm run build:mac`), and the user's look on macOS.

## Relevant Files

| File                                                 | Change                                                    |
| ---------------------------------------------------- | --------------------------------------------------------- |
| `devc/web/static/lib/themes.js` (new)                | Palettes and helpers                                      |
| `devc/web/static/client.js`                          | Apply the hash's theme; `devc-theme` event                |
| `devc/web/static/renderer.js`                        | Terminal background from `--term-bg`, and on `devc-theme` |
| `devc/tests/web_themes_test.ts` (new)                | Tests above                                               |
| `devc/README.md`                                     | `#…&theme=`                                               |
| `devc-desktop/src/main/main.ts`                      | Menu, state, hashes, inserted CSS, native colors          |
| `devc-desktop/src/main/policy.ts`                    | Swatch bitmap, `uiTheme` reading                          |
| `devc-desktop/tests/policy.test.ts`                  | Tests above                                               |
| `devc-desktop/src/renderer/rail.css`, `titlebar.css` | Read the theme's variables                                |
| `devc-desktop/README.md`                             | View → Theme                                              |
| `.plans/PLAN.md`                                     | Status entry and phase row                                |
