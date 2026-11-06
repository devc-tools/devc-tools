# Terminals: one host terminal module, one shared terminal surface

> **Superseded before implementation (2026-11-06)** by [host-terminal-herdr](../host-terminal-herdr.md):
> host terminals move to Herdr and draw with devc web's `renderer.js`, so sharing happens at the
> Herdr-terminal level (`term_mouse.js`, `host_terminal.ts`, `hostMenuEntries`) instead of the
> xterm.js level this plan describes. Nothing here was built.

Decided with the user on 2026-11-06. Prerequisite: the copy-on-select change (host terminals,
`devc-desktop/src/renderer/copy_select.ts`, `hostPermission`; the viewer's in `viewer.js`) is
committed before this starts.

## Checklist

- [ ] `devc/web/static/lib/term_surface.js`: `TERM_FONT_FAMILY`, `attachLinks`, `copyOnSelect`.
- [ ] `renderer.js` and `tiles.js` use it; container terminals behave exactly as before.
- [ ] `devc-desktop/src/renderer/host_terminal.ts`: `createHostTerminal`, `pasteGuard`,
      `onHostShortcut`. `host.ts` and `slot.ts` build their terminals only through it;
      `copy_select.ts` is deleted.
- [ ] Host terminals: Cmd+click (Ctrl+click off a Mac) on an http(s) URL opens it in the system
      browser, plain text URLs and OSC 8 hyperlinks both.
- [ ] Host views' `lockDownBundled` calls pass `external: true`.
- [ ] One host terminal menu: `hostMenuEntries` in `policy.ts`, one builder in `main.ts` used by the
      drawer and host tiles.
- [ ] `devc-web.d.ts` declares `devc-web/lib/term_surface.js`.
- [ ] Tests: `devc/tests/web_term_surface_test.ts`, `policy.test.ts`.
- [ ] `devc-desktop/README.md`: copy on select and Cmd+click links in the host terminal sections.

## Goal

A terminal feature is written once. Today the drawer (`host.ts`) and a host tile (`slot.ts`)
each build their own xterm.js, paste bar and shortcut handler, and `main.ts` builds their
right-click menus separately (the tile's split items were added a day after the drawer's).
Container terminals (`renderer.js`) and host terminals share nothing, so host terminals have no
links. `layout.js` is the model: one module devc web owns, bundled into the app at build time,
with hooks for what differs.

## Decisions

- **D1: two layers.** `lib/term_surface.js` (devc web, shared with the app) holds what any
  xterm.js terminal does on its own surface: links under the pointer and copy on select.
  `host_terminal.ts` (app only) holds what both host terminals do: their xterm options and addons,
  the paste bar, the split shortcuts. Transport (Herdr cells vs a local pty), mouse routing and
  what a link click does stay with each terminal type.
- **D2: `term_surface.js` never imports xterm.js.** It takes a `Terminal` instance. devc web
  vendors xterm.js (`vendor/xterm/`) and `renderer.js` stays the only devc web module importing
  it; the app uses `@xterm/xterm` 6.0.0 from npm. Use only APIs both have: `buffer.active`
  (`getLine`, `getCell`, `getWidth`, `getChars`, `viewportY`), `registerLinkProvider`,
  `hasSelection`, `getSelection`, `element`.
- **D3: host terminals link URLs only.** A path in a host terminal is a path on the host, which
  devc web's viewer cannot open. File paths are not underlined there. Opening host paths is a
  later decision for the user.
- **D4: a link click is caught on mousedown, in the capture phase,** on the terminal's container
  element, before xterm.js sees it, as `tiles.js` already does for container terminals. It then
  works while a full-screen app has mouse reporting on (vim with `mouse=a`, tmux), where xterm.js
  would send the click to the app instead of activating the link.
- **D5: URLs leave through `window.open`.** The host views' `lockDownBundled` gets
  `external: true`, which sends an http(s) `window.open` to `shell.openExternal` (`externalUrl`)
  and denies everything else. No new IPC.
- **D6: menus come from one ordered list.** The drawer's and a tile's menus differ only in the move
  item and the last item; everything else is the same list.

## Contracts

### `devc/web/static/lib/term_surface.js`

```js
export const TERM_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

/**
 * Underlines links under the pointer and shows a pointer cursor while `linkModifier` says the
 * opening key is down (lifted from `renderer.js`, unchanged behavior).
 * @param {Terminal} term  opened
 * @param {HTMLElement} element  the element `term` was opened in
 * @param {{kinds: ('url'|'file')[], linkHint?: string,
 *          linkModifier: (ev: MouseEvent|KeyboardEvent) => boolean}} opts
 * @returns {{linkAt(cell: {column: number, row: number}): Link | null,
 *            linkAtEvent(ev: MouseEvent): Link | null, dispose(): void}}
 *   `row` is a viewport row (0 = top of the screen), `column` a cell column. `linkAtEvent` finds
 *   the cell under the pointer from `.xterm-screen`'s rect and `term.cols`/`term.rows` with
 *   `pixelToCell` (`lib/input.js`), or null before the terminal is laid out.
 */
export function attachLinks(term, element, opts) {}

/**
 * Copies the terminal's selection when the left button comes up anywhere in the window, for a
 * press on `element` that `when` accepts (default: every left press).
 * @param {Terminal} term
 * @param {HTMLElement} element
 * @param {{when?: (ev: MouseEvent) => boolean}} [opts]
 * @returns {() => void}  dispose
 */
export function copyOnSelect(term, element, opts) {}
```

Gotchas:

- **Buffer rows vs viewport rows.** The link provider's `y` is a 1-based _buffer_ line:
  `getLine(y - 1)`. `linkAt`'s `row` is a _viewport_ row: read `getLine(buffer.active.viewportY +
  row)`. `renderer.js` gets away with `getLine(row)` only because container terminals have
  `scrollback: 0`; host terminals have 5000.
- **Copy timing.** Read the selection in a `setTimeout(0)` after the window's `mouseup`: xterm.js
  settles a selection in its own mouseup handler, which may run after this one.
- `findLinks` (`lib/links.js`) returns both kinds; `attachLinks` filters by `opts.kinds`.

### `renderer.js` / `tiles.js`

- `renderer.js`'s link code (`lineLinks`, cursor toggling, `registerLinkProvider`, `linkAt`)
  becomes `attachLinks(term, element, {kinds: ['url', 'file'], linkHint, linkModifier})`. The
  `Renderer` interface does not change.
- `renderer.js` calls `copyOnSelect(term, element, {when: (ev) => ev.shiftKey})`. `tiles.js`'s
  Shift branch in `attachMouse` keeps its early `return` (the press goes to xterm.js) but no
  longer copies. A plain drag still copies through Herdr (`copySelection`), unchanged.
- The font family comes from `TERM_FONT_FAMILY`.

### `devc-desktop/src/renderer/host_terminal.ts`

```ts
export interface HostTerminal {
  term: Terminal;
  fit: FitAddon;
  serialize: SerializeAddon;
}
/** Opens the terminal in `el`, with copy on select and URL links. */
export function createHostTerminal(
  el: HTMLElement,
  opts: { background?: string },
): HostTerminal;
/** The multi-line paste bar (`#paste`, `#paste-lines`, `#paste-text`, `#paste-ok`,
 *  `#paste-cancel`, both pages' existing ids). `target()` is the terminal a paste goes into,
 *  read when the paste happens; `listenOn` gets the capture-phase paste listener. */
export function pasteGuard(
  listenOn: HTMLElement,
  target: () => Terminal | null,
): void;
/** Capture-phase keydown for `hostShortcut`; `cb` gets the command name (not on repeat). */
export function onHostShortcut(cb: (name: HostCommand) => void): void;
```

- Terminal options, the same for both pages: `cursorBlink: true`, `fontFamily: TERM_FONT_FAMILY`,
  `fontSize: 13`, `scrollback: 5000`, `theme: { background }` when given.
- Links: `attachLinks(term, el, {kinds: ['url'], linkHint, linkModifier})` with
  `linkHint` = `Cmd+click to open` on a Mac, `Ctrl+click to open` elsewhere, and `linkModifier` =
  `metaKey` on a Mac, `ctrlKey` elsewhere (`navigator.platform.startsWith('Mac')`, as `slot.ts`).
  A capture-phase `mousedown` on `el`: left button, modifier down, `linkAtEvent(ev)` not null →
  `preventDefault`, `stopPropagation`, `window.open(link.url, '_blank', 'noopener,noreferrer')`.
- OSC 8: `linkHandler: { activate(ev, uri) { … }, allowNonHttpProtocols: false }` in the
  terminal options; it opens `uri` the same way only when `linkModifier(ev)` and the URI's
  protocol is `http:` or `https:`. Without the modifier it does nothing (no `confirm()`: dialogs
  are refused in these views).
- Copy on select: `copyOnSelect(term, el)` (every left press).
- `slot.ts`'s split shortcuts skip `close` (End Shell is menu-only there); the drawer's do not.
  Keep that in the callers, not in `onHostShortcut`.

### Menus

`policy.ts`:

```ts
export type HostMenuEntry =
  | 'split-right'
  | 'split-below'
  | 'new-tab'
  | 'separator'
  | 'cd'
  | 'move'
  | 'last';
export function hostMenuEntries(where: 'drawer' | 'slot'): HostMenuEntry[];
// both: ['split-right','split-below','new-tab','separator','cd','separator','move','last']
```

`main.ts` has one builder that maps entries to `MenuItemConstructorOptions`, used by the
`host-term:context-menu` handler for both views. Exact labels and order:

| Entry       | Drawer                                      | Host tile                                                      |
| ----------- | ------------------------------------------- | -------------------------------------------------------------- |
| split-right | Split vertically                            | Split vertically                                               |
| split-below | Split horizontally                          | Split horizontally                                             |
| new-tab     | New terminal in this stack                  | New terminal in this stack                                     |
| cd          | `cdItems(id)`                               | `cdItems(shell)`; none (and no separator) once the shell ended |
| move        | Move to Main Area (enabled as today)        | Move to Bottom Panel (enabled as today)                        |
| last        | Close (`close` command, its shortcut shown) | End Shell (disabled once ended)                                |

Accelerators shown, `registerAccelerator: false`, as today. Clicks do what they do today: the
drawer's send `host-term:command` to the host view; the tile's call `slotCommand`.

## Validation

- [ ] `cd devc-desktop && npm run check && npm test` pass.
- [ ] `cd devc && deno task test` passes, including the new `tests/web_term_surface_test.ts`:
      with a fake `term` (`buffer.active.getLine` returning cells, a `viewportY`), `attachLinks`
      with `kinds: ['url']` returns no file links; `linkAt({column, row})` reads buffer line
      `viewportY + row` (a fake with `viewportY: 10` finds a URL placed on line 12 at `row: 2`).
- [ ] `policy.test.ts`: `hostMenuEntries('drawer')` and `hostMenuEntries('slot')` equal the
      list above.
- [ ] `deno check devc/web/static/renderer.js devc/web/static/tiles.js devc/web/static/lib/term_surface.js`
      and `deno lint` on touched files pass; `deno fmt --check` on touched files passes.
- [ ] `grep -n "new Terminal(" devc-desktop/src/renderer/*.ts` matches only `host_terminal.ts`.
- [ ] `grep -rn "registerLinkProvider" devc/web/static devc-desktop/src --include=*.js --include=*.ts | grep -v vendor`
      matches only `lib/term_surface.js`.
- [ ] `grep -n "Split vertically" devc-desktop/src/main/main.ts` matches once.
- [ ] `test ! -e devc-desktop/src/renderer/copy_select.ts`.
- [ ] `cd devc-desktop && npm run build:mac` succeeds (the user checks the Mac apps).
- [ ] Real app (`npm start`), drawer and a host tile each:
  - [ ] `echo https://example.com/a_(b)`: hovering underlines `https://example.com/a_(b)`;
        Cmd/Ctrl+click opens it in the system browser; a plain click does not.
  - [ ] `printf '\e]8;;https://example.com\e\\link\e]8;;\e\\\n'`: Cmd/Ctrl+click on `link` opens
        it; a plain click does nothing.
  - [ ] `echo /etc/hosts README.md`: no underline.
  - [ ] In `vim` with `:set mouse=a`, a URL in the buffer opens with Cmd/Ctrl+click, and vim does
        not move its cursor there.
  - [ ] A drag, a double-click and a triple-click each put the selection on the clipboard.
  - [ ] A two-line paste shows the paste bar; Paste sends it, Escape cancels.
  - [ ] Right-click menus show exactly the table's items; each item works.
  - [ ] Split shortcuts (Cmd+D / Cmd+Shift+D / Cmd+T, or Linux's) work; Move to Main Area and Move
        to Bottom Panel keep the scrollback.
- [ ] Real devc web, a container terminal (regression): Cmd/Ctrl+click on a URL and on a file
      path in a repo still open; Shift+drag still copies; a plain drag still copies through Herdr.

## Relevant Files

- `devc/web/static/lib/term_surface.js` (new)
- `devc/web/static/renderer.js`
- `devc/web/static/tiles.js`
- `devc/tests/web_term_surface_test.ts` (new)
- `devc-desktop/src/renderer/host_terminal.ts` (new)
- `devc-desktop/src/renderer/host.ts`
- `devc-desktop/src/renderer/slot.ts`
- `devc-desktop/src/renderer/copy_select.ts` (deleted)
- `devc-desktop/src/renderer/devc-web.d.ts`
- `devc-desktop/src/main/main.ts`
- `devc-desktop/src/main/policy.ts`
- `devc-desktop/tests/policy.test.ts`
- `devc-desktop/README.md` (host terminal and host tile sections; the security section's
  description of what the host views are granted)
- `.plans/PLAN.md`
