# devc-web-host-terminal-request

A repo card's menu in devc web gets **Open Host Terminal…**. The page cannot open a host
terminal itself. It **asks** devc-desktop, using the same queue as `request_push`. The app
resolves the folder itself and shows a card in the HOST drawer (or the Containers pane), and
when the user confirms it, the app opens a new host tile in `/main`'s layout whose shell starts in
that folder.

**Read first:** [devc-desktop-host-actions](devc-desktop-host-actions.md) (the request queue, the
desktop token, D1–D5) and [devc-desktop-host-tiles](archived/devc-desktop-host-tiles.md)
(“devc web cannot create a host shell”; only the user's own action makes a host tile). Both
still hold. This plan keeps them: the page only asks, and the user confirms in a view the
page cannot draw or focus.

## Checklist

- [x] devc web: the `request_terminal` client message, the `terminal` request kind, and the
      `kinds` filter on `GET /desktop/requests` (§ devc web server)
- [x] devc web page: **Open Host Terminal…** on a repo card's menu (§ devc web page)
- [x] devc-desktop `policy.ts`: the `terminal` kind in `requestsAnswer`, `paneRequest` and
      `actionCard` (§ devc-desktop)
- [x] devc-desktop `main.ts`: the poll sends `kinds`, `check` and `confirm` handle `terminal`,
      `newPane` takes a folder, and the Containers pane's `containers:terminal` IPC
      (§ devc-desktop)
- [x] Tests (§ Validation)
- [x] `devc/README.md` and `devc-desktop/README.md` (§ Docs)
- [x] `deno fmt` on every touched file; build the Mac apps (`npm run build:mac` in
      `devc-desktop/`) for the user's look

## Decisions

- **D1: the page asks, the app confirms.** A click on a page-drawn item proves nothing: a page
  agents can write (`--live`, `--live-yolo`) can send the message without a click. So the
  request goes into `DesktopRequests` and nothing opens until the user clicks **Open** on the
  app's card (armed 1 s after its last change, as for push). The request never takes focus,
  as D5 of host-actions says.
- **D2: the folder is a project's repo, and the app shows its real path.** The server refuses a
  folder that is not one of the listed project's repos (`isProjectRepo`, as `request_push`).
  The app does not trust that check under `--live-yolo`: it resolves the path itself
  (`hostFolder`: realpath, a directory, showable) and shows the real path on the card. The
  user confirms the folder they can see. At confirm time the app calls `hostFolder` again and
  refuses if the real path changed (`The folder moved since it was checked`), so a symlink
  swapped in after the check doesn't change where the shell starts.
- **D3: the card warns about the folder, every time.** A shell that starts in a folder a
  container can write runs what that folder holds without anyone typing: a git-aware prompt
  runs `git status` (and `core.fsmonitor` from `.git/config`), and direnv, mise, nvm or asdf
  read their files. The app can't tell which projects are containers, so the note is always
  shown: `Your shell starts here: its prompt and tools like direnv may run what this folder
  holds`.
- **D4: where it opens.** Always as a new host tile in `/main`'s layout, placed where
  `askForTile` puts it when no `place` is given (no `host-at`). Never the drawer. The new slot
  view gets focus when it is first shown (`focusOnShow: true`, as **New Host Tile**): the user
  has just clicked **Open**.
- **D5: allowed under `--live` and `--live-yolo`.** Unlike `request_project`, opening a
  terminal starts nothing in a container, and D2 holds without trusting the server.
- **D6: old apps.** devc-desktop and devc web can be different versions (`desktopDevc`), and an
  older app's `requestsAnswer` rejects a whole answer that contains an unknown kind, which would
  block its push and start cards. So the app lists the kinds it understands (`kinds=` on the
  poll) and the server leaves the others out of the answer. An old app never sees `terminal`
  requests. They wait and expire after `REQUEST_TTL_MS`, and the page is told
  `asked devc-desktop…` as usual. `PROTOCOL` (`static/lib/protocol_version.js`) is not bumped:
  the Containers pane sends this request over IPC, not `/ws`.
- **D7: in a browser there is no item.** It shows only when the page can reach the app: the
  Containers pane's `appActions` is set, or `desktopChannel` is true. Herdr not running is the
  app's business: the card is refused with the drawer's own refusal text.

## devc web server

`devc/web/protocol.ts`, a new client message, parsed like `request_push` (`folder(m)` for
`localFolder`, `absolute(m, 'folder')`):

```ts
| { type: 'request_terminal'; id: string; localFolder: string; folder: string }
```

`devc/web/desktop_requests.ts`:

- `DesktopRequestKind` = `'push' | 'start' | 'stop' | 'down' | 'terminal'`.
- `folder` is the repo folder for both `push` and `terminal`. The de-duplication key is
  `folder` for both. `push` and `terminal` for the same folder are separate requests (the key
  is kind plus folder, as now).
- `list()` and `wait()` take an optional set of kinds. Leaving it out means
  `push, start, stop, down` (what apps before this plan understand). Requests of other kinds are
  left out of the answer. `seq` still counts every change, so an app that leaves out `terminal`
  is woken by a terminal request and gets the same list back. That is acceptable.

`devc/web/server.ts`:

- `askDesktop` accepts `request_terminal`: `needs_desktop` without the desktop token, and
  `bad_request` / `unknown folder` unless `isProjectRepo(projects, localFolder, folder)`. No
  `desktopProjects` check (D5). It queues `('terminal', localFolder, folder)` and answers
  `{ message: ASKED }`.
- Route the message to `askDesktop` wherever `request_push` / `request_project` are routed
  (line ~3613).
- `GET /desktop/requests?after=<seq>&kinds=<comma-separated>`: `kinds` is split on `,`, and
  names that aren't `DesktopRequestKind`s are dropped. A missing `kinds`, or one with no known
  names, means the default set (D6).

## devc web page

- `ui.js` `LABELS.openHostTerminal = 'Open Host Terminal…'`.
- `menus.js`: `requestTerminal(localFolder, folder)`. With `appActions` set, it calls
  `appActions.terminal(localFolder, folder)`. Otherwise it calls
  `askDesktop({ type: 'request_terminal', localFolder, folder }, LABELS.openHostTerminal)`.
  `appActions`' type gains `terminal(localFolder: string, folder: string): void`. Also export
  a predicate for whether the page can ask the app (`appActions !== null || desktopChannel`).
- `cards.js` `repoCard`'s context menu, for a card with a `repo`: put
  `[LABELS.openHostTerminal, () => requestTerminal(localFolder, repo.folder)]` right after the
  git items' separator and before `dirMenuItems(fr, '')`, followed by its own `null` separator.
  Show it only when that predicate holds (D7). Cards without a repo (`projectMenuItems`) get no
  item.

## devc-desktop

`src/main/policy.ts`:

- `ActionKind` gains `'terminal'`, and so does `ACTION_KINDS`. In `requestsAnswer` and
  `paneRequest`, `terminal` needs a `requestFolder(folder)`, as `push` does.
- `ACTION_TITLES.terminal = 'Open host terminal'`. In `actionCard`, `terminal`'s `folder` comes
  from `req.folder` as for push. Its note is D3's text exactly, and its confirm label is
  `'Open'`, not the title, so the `confirm` field is `'Open'` for this kind.
- `actionCard`'s `confirmable` for `terminal`: `phase === 'ready'` and no refusal.
- A helper, unit-tested: the `kinds` value the app sends,
  `'push,start,stop,down,terminal'`.

`src/main/main.ts`:

- `pollRequests` appends `&kinds=push,start,stop,down,terminal`.
- `check`: for `terminal`, first the Herdr refusal. If the host terminal's `refusal` is
  non-null, the target is `{ ok: false, label: refusal }`. Otherwise it is
  `hostFolder(req.folder)`. Then `ready` or `refused`; nothing else runs (no plan).
- `confirm`: `terminal` → `openTerminal(a)`:
  1. `hostFolder(a.req.folder)` again. If it isn't ok, or its `path` differs from
     `a.target.path`, the outcome is `{ ok: false, text: 'The folder moved since it was checked' }`.
  2. If devc web's view isn't showing (`showingDevc` false), the outcome is
     `{ ok: false, text: "devc web isn't showing" }`.
  3. `newPane(path)`: `newPane` takes an optional folder (default: home) and passes it to
     `createShell`. Its errors (`too many host shells`, Herdr's) become
     `{ ok: false, text: <message> }`.
  4. `makeSlot(<32 random hex>, pane)` and `askForTile(slot.id)` (no place), as `newHostTile`
     does. The outcome is `{ ok: true, text: 'Opened' }`.
- `src/preload/containers.ts`: `terminal(localFolder, folder)` →
  `ipcRenderer.send('containers:terminal', String(localFolder), String(folder))`.
- `main.ts`: `ipcMain.on('containers:terminal', …)`: `fromContainers(e) && paneShown()` →
  `paneAsks('terminal', localFolder, folder)`, as `containers:push` does.
- `src/renderer/containers.ts`: `useAppActions` gains
  `terminal: (localFolder, folder) => pane.terminal(localFolder, folder)`.
  `src/renderer/devc-web.d.ts`: `useAppActions`' type gains `terminal`.
- `src/renderer/actions.ts` needs no change: it draws `title`, `notes` and `confirm`
  generically. Check this by running it, and don't edit the file.

## Docs

- `devc/README.md`, the `--desktop-channel` paragraph (~line 880): add
  **Open Host Terminal…** on a repo card (`request_terminal`), allowed under `--live` and
  `--live-yolo`, and `GET /desktop/requests`' `kinds`.
- `devc-desktop/README.md`, **Host actions** (~line 405): the page may also queue
  `request_terminal`. The app checks the folder's real path itself, shows D3's warning, checks
  the path again on **Open**, and opens a host tile there. Also mention, near the host tiles
  section, that devc web still cannot create a host shell: it can only ask.

## Validation

- [ ] `(cd devc && deno task check && deno task test)` passes
- [x] `(cd devc-desktop && npm ci && npm run check && npm test)` passes
- [x] `devc/tests/web_desktop_test.ts`: `parseClientMessage` accepts
      `{type:'request_terminal', id, localFolder:'/src/a', folder:'/src/a'}` and refuses it
      without `folder`, with a relative `folder`, or without `id`
- [x] `devc/tests/web_desktop_test.ts`: `DesktopRequests` keeps one `terminal` per folder
      (asking again answers with the same id), keeps a `push` and a `terminal` for the same
      folder apart, and `list()` without kinds leaves `terminal` out while
      `list(new Set([...,'terminal']))` includes it
- [x] `devc/tests/web_desktop_test.ts`: a page's `request_terminal` for a folder that isn't one
      of the project's repos is refused `unknown folder`. Without `--desktop-channel` it is
      refused `needs devc-desktop`. With the channel, `GET /desktop/requests?after=-1` (desktop
      token) leaves it out, and `…&kinds=push,start,stop,down,terminal` lists it with
      `kind: 'terminal'` and the repo `folder`
- [x] `devc-desktop/tests/policy.test.ts`: `requestsAnswer` accepts a `terminal` request with a
      folder and returns `null` for one with `folder: null`. `paneRequest('x','terminal',…)`
      likewise. `actionCard` for a ready `terminal` has title `Open host terminal`, confirm
      `Open`, D3's note, and `plan: null`. For a refused target it has `confirm: null` and the
      label as `refusal`
- [ ] Manual, the user on macOS (the Mac build): right-click a container repo's card →
      **Open Host Terminal…** → the toast says `asked devc-desktop: confirm in the HOST drawer`.
      The drawer opens without focus, and its card shows the repo's host real path and D3's note.
      **Open** is disabled for 1 s. Clicking it adds a host tile in `/main`, and `pwd` there
      prints that path
- [ ] Manual, the user on macOS: the same item on a repo card in the Containers pane shows the card
      in the pane, and **Open** opens a host tile
- [ ] Manual, the user on macOS: in a plain browser tab of devc web, the item isn't there
- [ ] Manual, adversarial: from devc web's developer tools, send `request_terminal` every 100 ms.
      The rate limit refuses most of them, the drawer shows at most one card per folder, and no
      host tile appears without a click on **Open**
- [ ] Manual, adversarial: after the card is ready, replace the repo folder's path with a symlink
      to another folder (a host project's worktree on the host is enough). **Open** gives
      `The folder moved since it was checked` and no tile appears

## Implementation notes (2026-11-06)

- **Route checks are tested without a socket.** `web_desktop_test.ts` opens none, so the
  server's check moved into a pure exported `desktopAsk(msg, projects, {channel,
  desktopProjects})`, which `askDesktop` calls. The `unknown folder` and `needs devc-desktop`
  item is tested there. The `kinds` part is tested through `requestKinds` (the route's parser)
  plus `DesktopRequests.list` / `wait` with and without kinds, not through `GET`.
- **`devc` tests: 1051 pass, 1 fails, and the failure isn't this change.**
  `docker_exec_single_path_test` finds `devc-core/dist/container.d.ts:114`. That file is gitignored
  build output from 2026-11-02 that this change didn't touch. `tests/web_desktop_test.ts`
  passes in full (20).
- `npm ci && npm run check && npm test` pass (73), and `npm run build:mac` built both Mac apps.
  As in earlier plans, nothing ran in the real app here. Every manual check is for the user on
  macOS.

## Relevant Files

| File                                      | Change                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `devc/web/protocol.ts`                    | `request_terminal` type and parser                                     |
| `devc/web/desktop_requests.ts`            | `terminal` kind, its key, kinds filter on `list`/`wait`                |
| `devc/web/server.ts`                      | `askDesktop` for `request_terminal`, routing, `kinds` on the long poll |
| `devc/web/static/ui.js`                   | `LABELS.openHostTerminal`                                              |
| `devc/web/static/menus.js`                | `requestTerminal`, `appActions.terminal`, the can-ask predicate        |
| `devc/web/static/cards.js`                | the repo card menu item                                                |
| `devc/tests/web_desktop_test.ts`          | parser, queue and route tests                                          |
| `devc/README.md`                          | `--desktop-channel` paragraph                                          |
| `devc-desktop/src/main/policy.ts`         | `terminal` kind, card title/confirm/note, kinds helper                 |
| `devc-desktop/src/main/main.ts`           | poll `kinds`, `check`/`confirm`/`openTerminal`, `newPane(folder)`, IPC |
| `devc-desktop/src/preload/containers.ts`  | `terminal` IPC                                                         |
| `devc-desktop/src/renderer/containers.ts` | `useAppActions` `terminal`                                             |
| `devc-desktop/src/renderer/devc-web.d.ts` | `useAppActions` type                                                   |
| `devc-desktop/tests/policy.test.ts`       | `requestsAnswer`, `paneRequest`, `actionCard` tests                    |
| `devc-desktop/README.md`                  | Host actions and host tiles sections                                   |
| `.plans/PLAN.md`                          | Pending entry and Development Phases row                               |
