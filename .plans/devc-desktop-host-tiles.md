# devc-desktop-host-tiles

Host terminals that sit in devc web's Golden Layout as tiles of their own, beside container
panes, files and diffs, without giving devc web any more reach into them than it has into the
drawer today. Host panes are told apart from container panes by a **background color the user
picks**, which devc web never learns.

**Read first:** [devc-desktop-host-terminal](archived/devc-desktop-host-terminal.md) (threat
model; "Step 0 results" for why iframes are out: a sandboxed cross-origin iframe takes keyboard
focus from its embedder) and [devc-desktop-electron](archived/devc-desktop-electron.md) (why
separate `WebContentsView`s pass). Both still hold and are not restated here.

## Checklist

- [x] Step 0: probe (§ Step 0) and record the results in this file. **Stop and report to the
      user if S1 or S2 fails.**
- [x] Step 1: host color: the **Host Terminal Color** menu, `hostColor` in the state file, applied
      to the drawer's host tiles (§ Host color)
- [x] Step 2: devc web: the `host` tile kind, its placeholder, the `host-slot` hash, and the
      `slot` / `drag` / `overlay` console lines (§ devc web)
- [x] Step 3: devc-desktop: slot views, the slot line parser and clamp, z-order, hiding rules
      (§ Slot views)
- [x] Step 4: the move guard (§ Move guard)
- [x] Step 5: shell lifetime: orphaned slot shells, **Restore Host Tiles**, **End Shell**
      (§ Shell lifetime)
- [x] Step 6: `devc-desktop/README.md` (host tiles, color, threat model additions) and
      `devc/README.md` (the `host` tile kind as seen in a browser)
- [ ] Validation (below), including the adversarial checks; then ask the user to run the macOS
      checks

## Decisions

- **The host view covers only the tile's content area.** Golden Layout keeps drawing every tab
  and stack header, host tiles included: a host tile's tab can sit in a stack beside devc web's
  own tabs, so no app view could draw that header. Consequence: **the tab is untrusted.** Its
  title, × and position are devc web's to draw, and may lie. The trust signals are inside the
  content area, drawn by the app: the host color and the `HOST · user@host` strip.
- **One `WebContentsView` per host tile ("slot view").** Tiles can be anywhere in the layout and
  a view is one rectangle. The drawer stays as it is (one view, its own Golden Layout, the Actions
  column) and remains the fallback. A shell lives in the view it was opened in for its whole life:
  there is no moving a shell between the drawer and a tile (scrollback would have to cross
  renderer processes).
- **devc web controls geometry only.** It says where a slot is, or that it is hidden. It cannot
  create a host shell, end one, read it, type into it, or learn the host color. Every slot line
  naming an id the app did not issue, or whose shell has ended, is ignored.
- **Only the user creates a host tile:** the app menu's **New Host Tile**. The app then asks
  `/main` to add the tile through its URL hash, the same channel `loadMainHash` uses for
  `sidebar=`.
- **devc web's × does not end the shell.** Removing the tile (×, closing its stack, a layout
  reset, a page reload that drops it) only orphans the shell: its view hides and the shell keeps
  running. A shell ends only by its own exit, or **End Shell** in the host view's own right-click
  menu. So devc web cannot kill a long-running host job.
- **Host color is a user-chosen preset, kept only in the app's state file.** devc web cannot see
  another view's pixels, so a fake host tile drawn by devc web must guess it. With a handful of
  presets a guess can succeed: the color is a strong cue, not a secret, and the README says so.
  The protection that does not depend on the color is unchanged: devc web can read no keystroke
  typed into a real host view, and focus moves to a view only by a click in it.
- **Native views draw over devc web; never the reverse.** Slot views are hidden (not lowered)
  whenever devc web needs to draw over them: a dialog, a Golden Layout drag, an open menu. Hiding
  is the only response, because a devc web view raised over a host view could draw a fake in the
  real one's place.

## Step 0: probe

A throwaway Electron app (not committed), as in devc-desktop-electron's probe: one `BaseWindow`,
a hostile devc stand-in view (sandboxed, own partition, no preload, `disableDialogs`) and a host
stand-in view placed at a rectangle the hostile page reports by console line. Real keystrokes
(`xdotool` on Linux under Xvfb; by hand on macOS). Record the results in a `## Step 0 results`
section here.

- **S1. Focus theft, with geometry.** The G3 attacks of the Electron probe (`window.focus()`,
  `element.focus()`, `autofocus`, `showModal`, `window.open`, all at once, every 300 ms) while
  the hostile page also moves and resizes the host view every 300 ms. Pass: 20/20 keystrokes in
  the host view, 0 in the hostile page.
- **S2. Pointer-move attack.** The hostile page moves the host view under the pointer 100 ms
  before a scripted click, then the script types 20 keys. With the move guard (§ Move guard) on:
  pass means 0 keys reach the host shell and 0 the page. Also record the result with the guard
  off, to show it is needed.
- **S3. Drag and dialogs.** A Golden Layout drag over a slot, and a dialog over one, with the
  slot hidden for each: record whether the hide/show is visibly jarring (subjective; report it).
- **S4. Lag.** Drag a Golden Layout splitter next to a slot: record whether the view trails the
  layout by more than one frame.

S1 or S2 failing is a stop: report to the user. S3 and S4 inform the README, not the go/no-go.

## Step 0 results (Linux, 2026-11-05)

Throwaway probe (not committed) on **Electron 44.5.0** under Xvfb, real keystrokes from
`xdotool`: one `BaseWindow`, a hostile page in a view like devc web's (sandboxed, own partition,
no preload, `disableDialogs`, windows denied), and a host view (own partition, a preload) placed
wherever the hostile page's `slot x y w h` console lines said, hidden on `hide`. **Chromium's
sandbox was off (`--no-sandbox`):** the tool environment sets `no_new_privs`, so the setuid
helper cannot run, and running outside it was refused. Which view receives keys does not depend
on the OS sandbox; the macOS checks run with it on.

| Check                                                                         | Guard off                     | Guard on (the revised rule)                                          |
| ----------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------- |
| **S1** focus attacks every 300 ms, view moving under the cursor (19 moves)    | 20/20 keys in host, 0 in page | 20/20 in host, 0 in page                                             |
| **S2** page moves the view under the pointer, user clicks, types 25 keys      | **25 keys in the host shell** | 0 in host, 0 in page (dropped)                                       |
| **S3** page hides/shows the view every 150 ms around the user's click into it | **20 keys in the page**       | 0 in either                                                          |
| **S4** page moves the view away and back every 150 ms around the click        | **20 keys in the page**       | 0 in either                                                          |
| **S5** clean click into the view, then the page hides/shows it while typing   | —                             | 3 in host (before the first hide), 0 in page; the rest reach no view |

- **S1 passes**: as in devc-desktop-electron, nothing a page calls moves focus to it, and moving
  a view does not either.
- **S2–S4**: the first guard (cursor-entry, focus handback) passed S2 but leaked all 20 keys in S3
  and S4, through the handback. The symmetric rule (§ Move guard) passes all three. The probe
  also showed that dropping keys merely _while_ a guard runs lets a page cut characters out of a
  command typed into an already-focused view; the rule drops only after a press.
- **S5** led to re-focusing a view shown again (§ Move guard).
- **S3/S4 of the plan's original list** (jarring hide/show, splitter lag) need eyes on a real
  display: not measured headless; part of the user's macOS checks.

## Contracts

### Host color (Step 1)

- App menu **View ▸ Host Terminal Color ▸** radio items, in this order, with these values:

  | Label  | `hostColor` | Background                       |
  | ------ | ----------- | -------------------------------- |
  | Green  | `green`     | `#10251b`                        |
  | Teal   | `teal`      | `#0f2427`                        |
  | Blue   | `blue`      | `#121d33`                        |
  | Purple | `purple`    | `#1f1830`                        |
  | Amber  | `amber`     | `#2a2210`                        |
  | Red    | `red`       | `#2b1517`                        |
  | None   | `none`      | `#181e27` (devc web's `--panel`) |

- Default `green`. Saved as `"hostColor": "<value>"` in `desktop-state.json` (`STATE_PATH`); an
  unknown or missing value reads as `green`.
- Applied to **every** host terminal (drawer tiles and slot views): xterm.js's
  `theme.background`, the tile content area behind it, and the `HOST` strip's background. The
  drawer's own strip, Actions column and tab headers keep their current colors.
- Sent to host pages over IPC only (`host-term:color`, value the background hex). Never in a URL,
  the devc partition, devc web's server, or anything `/main`, `/sidebar` or `/host-status` can
  read. A test asserts `devc/web/` contains none of the hex values above (except `#181e27`, which
  is devc web's own `--panel`).

### devc web (Step 2)

- **New tile kind `host`.** Golden Layout component type `host`, state `{ "hostSlot": "<id>" }`
  where `<id>` is 32 lowercase hex characters. Saved and restored with the layout like the other
  kinds (`layout_state.js`); a restored `host` tile with a malformed id is dropped.
- **Its content is a placeholder** drawn by devc web: the text `Host terminal — not running here`
  and, under it, `Close this tab`. In devc-desktop a live slot view covers it; in a browser, or
  after the app restarted (the shell is gone), it is what shows. Its tab title is `host`.
- **Opening one.** When `/main`'s hash has `host-slot=<id>` (on load or `hashchange`), the page
  adds a `host` tile with that id beside the focused tile (as a new tile in the focused tile's
  stack; the root if none), focuses it, then removes `host-slot` from the hash with
  `history.replaceState` (keeping the other parameters). An id already in the layout is not added
  twice. Only `/main` does this; `/sidebar` ignores the parameter.
- **Reporting its rectangle.** For each `host` tile, `/main` logs with `console.debug`:
  - `devc-desktop:slot <id> <x> <y> <width> <height>` — the content element's
    `getBoundingClientRect()` in CSS pixels relative to the viewport, each rounded to an integer,
    whenever it changes (a `ResizeObserver` on the element, plus Golden Layout's layout-change
    events), at most once per animation frame per tile;
  - `devc-desktop:slot <id> hidden` — when the tile's tab is not the active one in its stack,
    when maximized-away, or when the tile is removed.
- `devc-desktop:drag start` / `devc-desktop:drag end` around every Golden Layout drag (a tab or a
  sidebar row dragged into the tiling area).
- `devc-desktop:overlay open` / `devc-desktop:overlay closed` while any of the page's popup menus
  (`menus.js`, tab and stack context menus) or the command palette is open.
- In a browser these are debug lines no one sees, as `dialog open` is today (`client.js`); they
  are emitted only when not `bundled`, matching the dialog lines.

### Slot views (Step 3)

- **New Host Tile:** app menu **devc web ▸ New Host Tile**, accelerator `Cmd+Shift+J` (macOS) /
  `Ctrl+Shift+` `` (others). Refused with `shell.beep()` when devc web is not showing, when the
  host terminal is refused (the debug-port check that keeps the drawer off), or at `MAX_SHELLS`
  (the limit counts drawer and slot shells together).
- On success the app issues a fresh id (`crypto.randomBytes(16).toString('hex')`), creates a slot
  view (bundled page, the host preload, its own `host` partition like the drawer's), starts its
  shell, and sets `/main`'s hash `host-slot=<id>` the way `loadMainHash` changes `sidebar=` (a hash-only change: the page is not reloaded). The
  view stays hidden until the first valid `slot` line for its id.
- **Inside the slot view:** the shell's xterm.js filling the view, under a 20 px strip reading
  `HOST · <user>@<host>` on the host color. Same paste confirm as the drawer. Right-click opens the
  app's host-tile menu (§ Shell lifetime).
- **Parsing a slot line** (a pure function in `policy.ts`, tested): only from `devcView`'s main
  frame (`e.frame === wc.mainFrame`), never `/sidebar` or `/host-status`. Regex
  `^devc-desktop:slot ([0-9a-f]{32}) (?:hidden|(-?\d{1,5}) (-?\d{1,5}) (\d{1,5}) (\d{1,5}))$`.
  Anything else is ignored.
- **Placing:** CSS px × `devcView.webContents.getZoomFactor()`, offset by `devcView`'s own bounds
  (as last set by `placeDevc` for its _own_ rectangle, not the spread one), then intersected with
  that rectangle. A result narrower than 80 or shorter than 40 DIP is treated as `hidden`.
  `setBounds` at most once per 16 ms per view (the latest rectangle wins).
- **Hidden** (`setVisible(false)`) while any of: its last line said `hidden`; no valid line yet;
  a devc web dialog is open (`devcDialogs` non-empty); between `drag start` and `drag end`;
  between `overlay open` and `overlay closed`; `devcView` started a non-same-document navigation
  (a reload; until the next valid line for that id); devc web not showing (status view up).
  A `drag start` or `overlay open` with no matching end is cleared by the next navigation.
- **Z-order gotcha:** `devcDialog` re-adds `devcView` with `addChildView`, which raises it over
  every view added before. After a dialog closes, re-add every slot view above `devcView` (and
  then `dimView`, `menuView` as today) so slots are never under devc web.
- **Focus:** a slot view gets focus only from a click in it (the existing `mouseDown` →
  `focus()` handler; an ambiguous press mutes it, § Move guard), **New Host Tile** focusing the
  new view once it is first shown, or being shown again after a hide that took its focus
  (§ Move guard). Nothing devc web sends focuses a slot view.

### Move guard (Step 4)

Revised by Step 0: the first design (a guard when the view moves under the cursor, handing focus
back to the previous view) leaked. A page that hides the view, or moves it away, around a click
makes the click land on devc web, and the handback itself picks devc web. The rule below is
symmetric and moves no focus.

- **Coverage changes.** The app records every change of a slot view's shown rectangle: placed,
  moved, resized, shown or hidden, whatever the cause (a hidden view has no rectangle). It keeps
  the last 500 ms of them: `{ old: Rect | null, now: Rect | null, at: ms }`.
- **An ambiguous press** is a `mouseDown` (the `input-event` of any devc web view or slot view)
  at a point that some change in the last **500 ms** moved from covered to uncovered or back
  (`inside(old, p) !== inside(now, p)`, `p` the cursor in window content coordinates from
  `screen.getCursorScreenPoint()` at the press).
- **After an ambiguous press, the view pressed is muted:** its keyboard input (`keyDown`,
  `char`) is dropped (`before-input-event` → `preventDefault()`) until the next press anywhere
  that is not ambiguous. Focus is left wherever Chromium put it: the app never moves focus
  because of a guard.
- **A muted slot view shows** a banner over its terminal: `Input paused: this terminal just
  moved. Click it to type.` (told over IPC, `host-term:guard`, `true` / `false`). A muted devc web
  view shows nothing (the app cannot draw in it); its keys are simply dropped.
- **Keys are never dropped from a view that already had focus** before the change: only a press
  mutes. So a page cannot cut characters out of a command being typed by moving the view.
- **Hidden while focused:** a slot view hidden while it has focus loses it, and keys typed then
  reach no view (Step 0, S5). When that view is shown again and no other view took focus in
  between, the app focuses it again.
- The decision (changes, press point, now → ambiguous) and the trimming are pure functions in
  `policy.ts`, tested.

### Shell lifetime (Step 5)

- A slot whose id gets `hidden` because its tile was removed cannot be told from a tab switch,
  so the app does not try: a hidden slot shell keeps running, whatever the reason.
- **devc web ▸ Restore Host Tiles** (no accelerator): for each live slot shell that has had no
  visible line for 2 s, issues a **new** id for its existing view (the old id is retired) and adds
  it to `/main` the same way as New Host Tile, one hash change per shell, 100 ms apart. Disabled
  when there are none.
- The host-tile right-click menu (built by the main process, as the drawer's is) has the
  drawer's **Split vertically**, **Split horizontally** and **New terminal in this stack** (with
  their shortcuts, which the slot page also handles, `hostShortcut`), the drawer's `cd` items,
  and **End Shell**, which kills the shell. A split or new tab is a New Host Tile that `/main`
  places beside this tile: the hash also carries `host-at=<this slot id>` and
  `host-where=right|below|stack` (devc web's `hostPlacementFromHash`; an unknown or missing
  `host-at` falls back to the focused stack), and `withoutHostSlot` takes all three out. The
  page asks with `host-term:slot-command` (`split-right`, `split-below`, `new-tab` only). The slot view then shows `[exited]` and is destroyed on the next
  `hidden` line for its id.
- A shell that exits on its own: the view shows `[exited <code>]` and stays until its id goes
  `hidden`; then the view is destroyed and the id retired.
- Quitting the app kills every slot shell with the drawer's (`shutdown()`).

## Concept boundaries

- **Slot view vs drawer.** Both run host shells from the same `HostPtys`, with the same preload
  and IPC checks extended to each slot view (`fromView` per view). The drawer keeps its Golden
  Layout, Actions column and toggle; slot views have one shell each and no Actions column.
- **Host tile vs pane tile in devc web.** A `host` tile has no Herdr pane, no agent badge, no
  context, no file or diff. devc web's own tile menu items that act on a pane (Kill pane, rename,
  Ask agent) are absent on it.
- **What devc web learns:** that a slot id exists (it was handed it), and nothing else: not the
  user, host, color, shell output, or whether the shell is still running.

## Validation

- [x] `cd devc-desktop && npm run check && npm test` pass, with new tests in
      `tests/policy.test.ts`: slot-line parsing (valid, `hidden`, malformed ids, extra spaces,
      over-long numbers, negative width), placement (zoom, offset, intersection, the 80×40 minimum),
      the ambiguous-press rule (a point newly covered or uncovered within 500 ms is ambiguous, in
      either direction and for hides; a point covered before and after is not; older changes are
      trimmed), and `hostColor` reading (unknown → `green`).
- [x] `cd devc && deno test -A tests/web_layout_test.ts tests/web_desktop_test.ts` pass, with new
      tests: a `host` tile round-trips through save/restore; a malformed `hostSlot` is dropped;
      `host-slot=` in the hash adds one tile and is removed from the hash; the same id twice adds
      one tile; no hex value from the color table except `#181e27` appears under `devc/web/`.
      (Hash reading/removal is unit-tested; "adds one tile" and "the same id twice" live in
      `openHostTile`, which needs the DOM, and were checked in the real app instead.)
- [x] `deno fmt --check` on every touched file.
- [ ] Linux, real app under Xvfb: **New Host Tile** opens a host tile in `/main`'s layout with the
      host color and `HOST · user@host` strip; it moves with splitters, tab switches, and
      maximize; it hides during a tab drag, a dialog, and a context menu, and comes back after.
      **Done except maximize and a dialog:** a devc web dialog needs a running container, and
      there is no Docker in this environment. Checked: color (green, and blue from the state
      file, drawer too), strip, typing, zen on/off, tab switch, splitter drag, drag-to-split
      (hidden while dragging), the tab menu (hidden while open), the drawer opening (tile resized),
      Restart devc web (tile back with its shell and scrollback).
- [ ] Adversarial (Linux), with a devc web page patched in a throwaway checkout under `--live`:
  - [x] a `slot` line with an invented id shows nothing;
  - [x] focus-stealing calls every 300 ms while typing in a slot view: 0 keys leak (S1 again on the
        real app);
  - [x] moving a slot under the pointer before a click, or hiding it / moving it away around a
        click into it: no key reaches the shell or the page until the next clean click;
  - [ ] removing the tile, reloading the page, and resetting the layout leave the shell running
        (`ps` on the host); **Restore Host Tiles** brings it back with its scrollback;
        **Done except a layout reset** (removing the tab and a devc web restart were checked).
  - [ ] a `slot` line from `/sidebar` is ignored; **not run** (by inspection: `slotLine` is called
        for `devcView` only).
  - [ ] the host color is not readable from the devc view (devtools on `/main`: no hex in the DOM,
        storage or network). **Not run** in devtools; the color goes only over IPC to host views,
        and the `devc/web/` test passes.
- [ ] macOS checks by the user: S1, S2 and the Linux real-app list above; IME input in a slot view.

## Relevant Files

| File                                                               | Change                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devc-desktop/src/main/main.ts`                                    | Slot views, New Host Tile / Restore Host Tiles / Host Terminal Color menu items, slot/drag/overlay console lines from `devcView`, hiding rules, z-order after dialogs, move guard wiring, `hostColor` in saved state, End Shell in the host-tile menu, shutdown |
| `devc-desktop/src/main/policy.ts`                                  | Pure functions: slot-line parse, placement/clamp, move guard, `hostColor` values and reading                                                                                                                                                                    |
| `devc-desktop/src/main/pty.ts`                                     | Only if `HostPtys` needs a per-view owner for its shells                                                                                                                                                                                                        |
| `devc-desktop/src/preload/host.ts`                                 | `onColor`, `onGuard`                                                                                                                                                                                                                                            |
| `devc-desktop/src/renderer/host.ts`                                | Apply the host color to the drawer's terminals                                                                                                                                                                                                                  |
| `devc-desktop/src/renderer/host.css`                               | Host color on tile content and the strip                                                                                                                                                                                                                        |
| `devc-desktop/src/renderer/slot.html`, `slot.ts`, `slot.css` (new) | The slot view's page: strip, one xterm.js, paste confirm, guard shield                                                                                                                                                                                          |
| `devc-desktop/build.mjs`                                           | Bundle the slot page                                                                                                                                                                                                                                            |
| `devc-desktop/tests/policy.test.ts`                                | Tests above                                                                                                                                                                                                                                                     |
| `devc-desktop/README.md`                                           | Host tiles, color, the untrusted tab, what devc web can still do (hide, move, fake a tile with a guessed color), shortcuts table                                                                                                                                |
| `devc/web/static/layout.js`                                        | `host` component type, its placeholder                                                                                                                                                                                                                          |
| `devc/web/static/lib/layout_state.js`                              | `host` state save/restore and validation                                                                                                                                                                                                                        |
| `devc/web/static/tiles.js`                                         | Host-tile mount, rectangle reporting, no pane actions on it                                                                                                                                                                                                     |
| `devc/web/static/main-page.js`                                     | `host-slot` hash handling on `/main` (as `sidebar-corner.js` reads `sidebar=`)                                                                                                                                                                                  |
| `devc/web/static/lib/view.js`                                      | A `host-slot` hash reader beside `desktopSidebarFromHash`                                                                                                                                                                                                       |
| `devc/web/static/client.js`                                        | `drag` / `overlay` lines beside the dialog lines                                                                                                                                                                                                                |
| `devc/web/static/menus.js`, `devc/web/static/palette.js`           | Report `overlay open` / `closed`                                                                                                                                                                                                                                |
| `devc/web/static/style.css`                                        | Placeholder styling                                                                                                                                                                                                                                             |
| `devc/tests/web_layout_test.ts`, `devc/tests/web_desktop_test.ts`  | Tests above                                                                                                                                                                                                                                                     |
| `devc/README.md`                                                   | The `host` tile placeholder as seen in a browser                                                                                                                                                                                                                |
| `.plans/PLAN.md`                                                   | Status entry and phase row                                                                                                                                                                                                                                      |

## Implementation notes (2026-11-05)

- **Validation environment.** Linux under Xvfb, Electron 44.5.0 with `--no-sandbox` (see Step 0
  results), `devc web` run from this checkout with no Docker. Adversarial checks used a scratch
  copy of the repo whose `/main` had an attack script: F7 focus theft every 300 ms, F8 move the
  slot under the pointer, F9 hide/show every 150 ms, F10 a forged slot id. All four: no key
  reached the page or the shell; a clean click then typed normally.
- **Floating controls.** devc web's zen-mode toggle (and the corner toggle that shows the app's
  column) float over a tile's top corners. A host view would cover them, so `host-slots.js`
  starts the reported rectangle below any of them that overlaps (`clearOfControls`), and judges
  "covered" (zen mode, a maximized stack) by the tile's centre alone.
- **Shell ids.** A host tile's shell is `slot-<16 hex>`, never a drawer id (a UUID); each IPC
  sender may use only its own shells (`mayUse`).
- **End Shell** sends the view `host-term:exit` with code `-1` (a closed shell reports no exit
  of its own); the page shows `[exited]`.
