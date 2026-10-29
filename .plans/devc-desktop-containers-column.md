# devc-desktop: Containers in a trusted pane below devc web's sidebar

Decided with the user on 2026-10-28. Last of six plans (see "Git and the trusted host area" in
`PLAN.md`). After `devc-web-containers-module` and `devc-desktop-host-actions`.

## Checklist

- [ ] The layout: four content views, an app-owned rail, and strips (contract below).
- [ ] devc web's view becomes two: `/sidebar` (with Containers hidden) and `/main`.
- [ ] The Containers pane: `containers.js` bundled into the app, connected with the desktop token.
- [ ] The overlay menu view for the trusted panes.
- [ ] Protocol version check.
- [ ] Remove `devc-desktop/proto/`.
- [ ] Tests, README.

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
