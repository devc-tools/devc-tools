# devc-web-host-tile-tabs

A host tile's tab in devc web said `host` and nothing else: devc web knows only the slot id the
app issued. Without `--live` the page is devc's built-in copy, which already opens host shells and
starts containers unasked, and a container agent cannot read it, so the tab can read like a
terminal tile's.

## Decisions

- **D1: the app tells, devc web never looks.** devc-desktop reads its own Herdr session
  (`listPanes`, `pane.list`) every 2 s while a host tile is open and posts each live slot's facts
  to devc web with the desktop token. devc web never learns the session or a pane id, so it still
  has no way into a shell, and "devc web never connects to this session" stays true.
- **D2: not under `--live`.** The app sends nothing when its `devc web` arguments are live
  (`livePage`), and the server answers 409 while `projectStarts` is off, sending no `host_tiles`.
- **D3: display only, as text.** Controls, bidi overrides and zero-width characters become
  U+FFFD on the server; the page writes every value as text. No action on the tab: only the
  app's menu ends the shell.
- **D4: the tab reads like a terminal tile's.** `paneLabel` on the facts (folder, else the
  title), the muted title, the agent badge; context: the repo whose host folder holds the
  shell's folder, its branch, then `host` where a terminal tile names its container. Tooltip:
  `Host terminal (devc-desktop)`, the label, the folder. No facts: `host`, as before.

## Contracts

`POST /desktop/host-tiles` (desktop token only; added to `desktopTokenPath`):

```json
{
  "tiles": {
    "<32 hex slot id>": {
      "cwd": "…",
      "foreground_cwd": "…",
      "title": "…",
      "agent": "…",
      "agent_status": "…"
    }
  }
}
```

Every field a string (cwd/foreground_cwd ≤ 4096, title ≤ 512, agent ≤ 64, agent_status ≤ 32),
at most 64 tiles, other fields dropped. 204 on success (the whole map replaced), 400 malformed,
409 under `--live`. The page gets `{type: 'host_tiles', tiles}` on connecting and on each change,
never under `--live`.

## Checklist

- [x] `devc/web/host_tiles.ts`: `parseHostTiles`, `hostTilesMessage`
- [x] `server.ts`: the route, `desktopTokenPath`, the message on connect and on change
- [x] Page: `hostTileFacts` (`client.js`), `hostRepoAt` / `hostTilePane` (`lib/sidebar.js`),
      host tabs drawn in `tiles.js`, `hostTileList` (`host-slots.js`), labels (`ui.js`)
- [x] devc-desktop: `PaneInfo` gains `agent`, `agent_status`; `postTileFacts` every 2 s
- [x] Tests; `devc/README.md`, `devc-desktop/README.md`; `deno fmt`; build the Mac apps

## Validation

- [x] `devc/tests/web_host_tiles_test.ts`, `web_desktop_test.ts` (`desktopTokenPath`),
      `web_sidebar_test.ts` (`hostRepoAt`, `hostTilePane`)
- [x] devc-desktop `npm test` (`listPanes`), `npm run check`
- [x] devc web from source: the route answered 204 with the desktop token and 401 without; a
      `/main#…&host-slot=<id>` tile in headless Chromium showed `devc · Fix the host tabs ● work`
      and a plain shell's `me · zsh`, with the tooltip
- [ ] Manual on the Mac (not run): a host tile's tab follows its shell's folder, title and agent
      status; under `--live` it says `host`

## Relevant Files

- `devc/web/host_tiles.ts`, `devc/web/desktop_requests.ts` (`UNSHOWABLE` exported), `devc/web/server.ts`
- `devc/web/static/client.js`, `tiles.js`, `host-slots.js`, `ui.js`, `lib/sidebar.js`
- `devc/tests/web_host_tiles_test.ts`, `web_desktop_test.ts`, `web_sidebar_test.ts`
- `devc-desktop/src/main/herdr.ts`, `devc-desktop/src/main/main.ts`, `devc-desktop/tests/herdr.test.ts`
- `devc/README.md`, `devc-desktop/README.md`
