# devc-desktop: Containers in a trusted pane below devc web's sidebar

Decided with the user on 2026-10-28. Last of six plans (see "Git and the trusted host area" in
`PLAN.md`). After `devc-web-containers-module` and `devc-desktop-host-actions`.

## Checklist

- [x] The layout: four content views, an app-owned rail, and strips (contract below).
- [x] devc web's view becomes two: `/sidebar` (with Containers hidden) and `/main`.
- [x] The Containers pane: `containers.js` bundled into the app, connected with the desktop token.
- [x] The overlay menu view for the trusted panes.
- [x] Protocol version check.
- [x] Remove `devc-desktop/proto/`.
- [x] Tests, README.

## Implementation notes (2026-10-29)

Built as specified, with these choices where the plan left room or didn't fit:

- **Views.** `/sidebar` and `/main` load with `#token=…&view=devcd` (one partition between them,
  both locked down as the devc view was). The Containers pane is
  `build/containers/containers.html#view=devcd`, the rail `renderer/rail.html` and the overlay
  `renderer/menu.html`, each sandboxed in its own partition and locked down by `lockDownBundled`.
  Order: status, `/sidebar`, `/main`, Containers, host, rail, title bar, overlay (last). While
  devc web isn't showing, the status view spans the window above the drawer, and the pane and
  rail are hidden. `layout()` takes `{width, height, sidebarWidth, containers, drawer, peek}`.
  `dragColumn` / `dragContainers` keep what it keeps. `desktop-state.json` adds `sidebarWidth`,
  `containersHeight` and `containersOpen`.
- **Hiding the pane** reloads `/sidebar` without `containers=external` (through `about:blank`,
  since a hash-only load doesn't reload), so the column then shows devc web's own Containers
  section. That is also the way to start and stop containers under `--live-yolo`.
- **The desktop role.** `authorize` takes `/ws?desktop_token=` with no `token`, and an Origin that
  is absent, `null` or **`file://`**: Chromium sends `file://` from a `file:` page (measured
  headless), not `null`. `wsRole(url)` names the role, and each `Client` carries it.
  `projectRefusal(msg, role, {startsAllowed, desktopProjects})`: the desktop role may send
  `start_project`, `add_project`, `set_project_environment`, `list_host_dir`, `stop_project` and
  `down_project` unless `desktopProjects` is off (`--live-yolo`), when each is refused with a
  message pointing to the Layout menu. `hello` (`helloMessage`) carries `protocol` and, for the
  desktop role, `projectStarts: desktopProjects`, so the pane hides Add project under
  `--live-yolo` and shows it under `--live`.
- **Protocol** is `PROTOCOL = 1` in `devc/web/static/lib/protocol_version.js`, imported by
  `server.ts` and bundled into the pane. `client.js`'s `useBundledEndpoint` points the pane's
  connection at devc web's origin with the desktop token, turns off live reload and
  `client_ready`, and checks each `hello`: on a mismatch nothing is applied or sent, and the pane
  shows only the note.
- **Push, Start, Stop and Remove in the pane** go to the app (`menus.js`' `useAppActions`), not to
  `/ws` and not to a dialog: the main process makes the same action card as for a page request
  (`where: 'pane'`, ids `pane-<n>`, checked by `paneRequest`), shown in the pane under its strip,
  armed the same way, and confirmed only while the pane shows. Start/Stop/Remove then run through
  `POST /desktop/project`, as the drawer's do, so the app's own folder check and the
  `initializeCommand` note are the same; the role's `/ws` grants serve Add project, its picker,
  moving a project, and anything else the section sends. Under `--live-yolo` the card says to hide
  the pane. The card code moved from `host.ts` to `renderer/actions.ts` (`.action-card`,
  `actions.css`), shared by both.
- **Menus.** `ui.js`' `useMenuHost` sends the pane's menus to the overlay (labels and `danger`
  only; icons are dropped). Main checks them (`menuRequest`: at most 64, text through
  `showText`, a point inside the pane), the overlay measures itself at its natural size (a hidden
  view has no viewport yet), and `placeMenu` places it. It closes on a pick, Escape, its blur, any
  other view's focus and a window resize; the pick goes back with the menu's sequence number.
- **Permissions.** The pane is granted copying and Chromium's `local-network-access` /
  `loopback-network` / `local-network` (asked before a `file:` page reaches `127.0.0.1`); its CSP
  allows connections to `127.0.0.1` only. Its `window.open` of an http(s) URL (a pull request)
  goes to the system browser.
- **`/sidebar#…&containers=external`** (`containersExternalFromHash` in `lib/view.js`): no
  Containers section is mounted, and its zone and divider stay hidden.

Verified here: `deno check main.ts`, `deno task check`, `deno task test` (919 passed); the desktop
check script (`npm run check`, `npm test`: 47 passed) and `node build.mjs` in its Linux copy;
`deno fmt --check`. Headless (Electron 44.5.0 under Xvfb, a stub `docker`, a scratch `HOME`): the
views land where `layout()` says; `/sidebar` has no Containers section; the pane connects and
lists the projects; a right-click near the pane's foot opens the overlay over `/sidebar` and
`/main`, flipped upwards; Start container from it shows a card, a click before 1 s does nothing,
a click after it runs the start with its progress in the card; Escape and another view's focus
close the menu; the Layout toggle hides the pane and `/sidebar` shows its own section, and back;
the rail and strip IPC resize and save; a pane built for protocol 99 shows only the rebuild note.
Against `devc web --desktop-channel` with a WebSocket client: under `--live` the page is refused
`list_host_dir` and the desktop role is not (and gets `this server cannot run projects in host`
for a move to the host); under `--live-yolo` the desktop role's are refused and its `hello` says
`projectStarts: false`; plain mode allows both.

**Still to check on the Mac.** Rebuild devcd.app first (`npm run build:mac` from the container, or
`npm run build` on the Mac), then open it. From the prototype's "What to try", now with real data:

- [ ] **Dividers.** Drag the vertical rail, the Containers HOST strip and the drawer HOST strip.
      Does the resize keep up, or does it stutter or flicker? Quit and reopen: the sizes are kept.
- [ ] **Menus.** Right-click low in `/sidebar` and near `/main`'s right edge: devc web's own menus,
      kept inside their views. Right-click a Containers card or row: the **overlay** menu, styled
      like devc web's, spreading over `/sidebar` and `/main` and flipping only at the window's
      edges. Use the arrow keys, Enter and Escape; clicking elsewhere closes it.
- [ ] **Drag across views.** Drag a pane row from the Containers pane onto the tiles, and compare
      with a drag from `/sidebar`. Double-click (or click) a Containers row: it opens in `/main`.
- [ ] **Requests.** **Push…** on a repo card's menu in the pane: a card under the pane's HOST strip
      with the app's push plan, its button disabled for 1 s. **Start**, **Stop** and **Remove
      container** on a project: the same, and confirming streams progress. **Push…** on `/sidebar`'s
      In use card still goes to the drawer's Actions column.
- [ ] **Focus.** Click between the panes and note where keyboard focus goes.
- [ ] **Looks.** Does the HOST · Containers strip read as a clear border? Is the 45% split a
      sensible default?
- [ ] **`--live`.** With `desktopWebArgs: ["--live"]`: Start, Add project and its folder picker
      work in the pane. Edit `devc/web/static/containers.js` in the checkout: `/sidebar` reloads,
      the pane does not change until the app is rebuilt.
- [ ] **Layout → Containers Pane** (Cmd+Shift+E): hidden, `/sidebar` fills the column with its own
      Containers section; shown again, the section leaves `/sidebar`.

## Goal

The Containers section runs from code built into the app, so `--live` never changes it. Its
privileged actions (start, stop, remove, push) work under `--live`. The top of the sidebar and
`/main`, the parts the user changes most, stay live. The user tried the arrangement in
`devc-desktop/proto/` (2026-10-28).

## Layout

```
┌──────────── title bar ────────────┐
│ /sidebar (live)   ┃               │
│ In use, pinned…   ┃   /main       │
│━ HOST · Containers┫   (live)      │
│ Containers (app)  ┃━ HOST ━━━━━━━━│
│                   ┃ host drawer   │
└───────────────────┸───────────────┘
```

- `policy.ts`'s `layout()` returns `{ bar, sidebar, containers | null, rail, main, host | null }`,
  pure and non-overlapping, as now. The rail is 6 px. Minimums: sidebar column 220 px, `/main`
  360 px, each pane 120 px.
- The drawer spans `/main`'s width only. (The prototype offered full width as an option. Keep it
  only if the user asks after trying both.)
- The rail and the Containers strip are dragged as the drawer strip is today (`host-term:drag`'s
  pattern). Sizes are saved in `desktop-state.json` beside `drawerHeight`.
- **Layout** menu: toggle the Containers pane (Cmd+Shift+E). Hidden, `/sidebar` takes the column.

## Contracts

devc web:

- `/sidebar` takes `&containers=external` in its hash: the section is not drawn, and Reveal in
  Containers goes out as `containers_intent` (from `devc-web-containers-module`).
- **Protocol version.** The server's first `/ws` message carries `protocol: <integer>`. Add it if
  there is none, and bump it on any change to messages `containers.js` uses. The bundled pane
  shows `This devc-desktop was built for protocol <n>; devc web speaks <m>. Rebuild devc-desktop.`
  and draws nothing else on a mismatch.
- `/ws?desktop_token=<hex>`: the desktop token in the query, since a WebSocket can't set
  headers. The connection gets the **desktop role**: everything a page may do, plus everything
  `projectRefusal` (`projects_view.ts`) refuses a page under `--live` — `start_project`,
  `add_project`, `set_project_environment` and `list_host_dir` (the Add project picker) — plus
  `stop_project` / `down_project`, all refused under `--live-yolo`, plus `push` handed to the app
  (below). Under `--live` the host source doesn't exist, so `environments` is `['container']`:
  the picker doesn't ask where a project runs, and `set_project_environment` to `host` fails as
  it does today. `projectRefusal` takes the role as an argument; it never reads the token. Origin must be absent or
  `null` (a `file:` page).

devc-desktop:

- `build.mjs` bundles `devc/web/static/containers.js` and what it imports (`client.js`,
  `lib/*.js`, `ui.js`, `style.css`) from the checkout into `build/containers/`, with a
  `containers.html` entry. The token comes to it only through its preload (`containersPane.token()`),
  never in the URL.
- The Containers view: sandboxed, its own partition, its own preload, locked down as the host
  view (`lockDownBundled`).
- Push from the pane is the `devc-desktop-host-actions` flow (push-plan, armed confirm), shown in
  the pane instead of the drawer. Start/Stop/Remove confirm inline with the same 1 s arm.
- **Overlay menus.** One trusted `WebContentsView` added last, transparent, shown only while a
  trusted pane's menu is open. The pane sends `{ items, x, y }`; the overlay page measures itself
  and reports `{ width, height }`; the main process places it, flipping and shifting against the
  **window's** edges only. It closes on pick, Escape, blur and window resize. The prototype's
  `main.cjs`, `menu.html` and `preload-menu.cjs` are the reference. devc web's views never get it.

## Concept boundaries

- The **Containers pane** (trusted, bundled) vs devc web's **Containers section** (in the page,
  still used by the browser and VS Code). Same module, two hosts.
- The **desktop role** on `/ws` vs the page's. One server, two roles; a message's handler checks
  the role, not the token again.
- The **overlay menu view** (trusted, app) vs devc web's **in-page menus** (`ui.js`). Never route a
  page's menu to the overlay: it would let the page put text in trusted-looking UI.

## Validation

- `npm test`: `layout()` with every pane open, the Containers pane hidden, the drawer closed, and a
  window too small for all minimums (nothing overlaps; `/main` keeps its minimum first); overlay
  placement (the four corners and a menu taller than the window).
- devc web tests: the desktop role's `/ws` auth (wrong token → 401, an http Origin → 403), the
  role's `start_project` under `--live`, refused under `--live-yolo`; `protocol` in the hello.
- Manual on the Mac: everything in `devc-desktop/proto/README.md`'s "What to try", now with real
  data. Edit `containers.js` in the checkout under `--live`: the pane does not change until the
  app is rebuilt, while `/sidebar` reloads.

## Relevant files

`devc-desktop/src/main/{main,policy,launch}.ts`, `devc-desktop/src/preload/`,
`devc-desktop/build.mjs`, `devc-desktop/proto/` (reference, then deleted),
`devc/web/static/{containers.js,sidebar-page.js,remote.js,client.js}`, `devc/web/server.ts`
(`authorize`, `/ws`), `devc/web/protocol.ts`, `devc-desktop/README.md`.
