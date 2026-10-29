# devc-desktop: host actions — push and container starts confirmed in the HOST drawer

Decided with the user on 2026-10-28. Fifth of six plans (see "Git and the trusted host area" in
`PLAN.md`). After `devc-git-user-push`.

## Checklist

- [x] devc web: `--desktop-channel`, the desktop token, and its ready line.
- [x] devc web: page requests (`request_push`, `request_project`) and the `/desktop/requests` and
      `/desktop/project` routes.
- [x] devc-desktop: `launch.ts` reads the desktop token; `policy.ts` checks requests.
- [x] devc-desktop: an Actions column in the host drawer (`host.html`), with its IPC.
- [x] Page: Push… and, under `--live`, Start ask devc-desktop.
- [x] Tests, both READMEs (devc-desktop's "Why devc web cannot reach it" gains this).

## Goal

devc web's page can **ask** for a push or a container start, but can never confirm one. The
request shows in the host drawer, where devc web cannot draw. There the app shows what it worked
out itself, and the user confirms. This gives container projects a user push, and gets container
starts back under `--live`.

## Decisions

- **D1: who is trusted.** The app, and devc web's **server** when it is not `--live-yolo`. The
  page is not: anything holding the page token is treated as the page. The server's answers are
  still checked, as `/desktop/active-folder`'s are.
- **D2: a second token.** With `--desktop-channel`, devc web makes a second random 64-hex token
  and prints `devc web: desktop <token>` on stdout, after the ready line. It is never in a URL,
  never sent to a page, never in an environment variable (host projects inherit devc web's
  environment). Without the flag nothing changes.
- **D3: what it unlocks.** Only `/desktop/project` (start, stop, down) accepts the desktop token
  without the page token. It ignores `projectStarts` (`--live`), and is refused with 409 under
  `--live-yolo`. Host projects are not unlocked under `--live`: the host source isn't created
  there, and the page attaching to a host shell is the danger, not the start.
- **D4: push doesn't go through the server.** The app runs `devc git push-plan` and
  `devc git push --sha` itself, with the `devc` that `launch.ts` found. When that is `devc2`
  (from the checkout), the pane says so on every push.
- **D5: no focus stealing.** A request never opens the drawer and never takes focus. It sets a
  badge on the HOST strip (`1 request`). The confirm button is disabled until 1 s after the
  request's content last changed.
- **D6: host projects.** Their push requests use the same flow, for one path. A direct Push button
  for host projects (their page already has a host shell) is a possible follow-up, out of scope here.

## Contracts

devc web, stdout (`launch.ts` adds the regex beside `readyUrl`'s):

```
devc web: desktop <64 lowercase hex>
```

Client messages (`protocol.ts`):

```ts
| { type: 'request_push'; id: string; localFolder: string; folder: string }
| { type: 'request_project'; id: string; action: 'start' | 'stop' | 'down'; localFolder: string }
```

Answered with the existing toast/ack: `asked devc-desktop: confirm in the HOST drawer`, or a
refusal: `needs devc-desktop` (no `--desktop-channel`), an unknown folder, or the rate limit.
`folder` must be one of the project's repo folders. Pending requests: at most 1 per
(kind, folder), at most 20 in all, each dropped after 10 min or when the app dismisses it.

Routes (`server.ts`; `authorize` checks `/desktop/requests` and `/desktop/project` against the
**desktop** token only, still with no Origin; `/desktop/active-folder` keeps the page token):

```
GET  /desktop/requests?after=<seq>    long-poll, at most 25 s
  → { seq: number, requests: { id: string, kind: 'push' | 'start' | 'stop' | 'down',
                               localFolder: string, folder: string | null, at: number }[] }
POST /desktop/requests/<id>/dismiss   → 204
POST /desktop/project  { action: 'start' | 'stop' | 'down', localFolder: string }
  → 200 NDJSON: { line: string }* then { done: true, ok: boolean, problem?: string }
  → 409 { problem: 'live-yolo' } | 404 unknown project
```

devc-desktop:

- `launch.ts`: the desktop token from stdout, kept in memory only. `--desktop-channel` is always
  added to `devc web`'s args, as `--no-open` is.
- `policy.ts` (pure, tested): a type guard for the requests answer, and a folder check reusing
  `cdTarget`'s rules for a host path (absolute, realpath, directory, showable, at most 256 chars)
  without the mount part. A failing request is shown greyed with its reason and cannot be confirmed.
- `host.html` / `host.ts`: an **Actions** column to the left of the terminal, 280 px, hidden when
  nothing is pending. It shows one card per request:
  - **push:** `push-plan`'s result: branch → remote, short SHA, commits (subject and author as
    text), and warnings for `defaultBranch`, `guarded`, `!fastForward` and `lfs`. Buttons:
    **Dismiss** and **Push** (disabled when the plan can't push).
  - **start/stop/down:** the folder, and for start the line `runs its devcontainer.json's
    initializeCommand on this machine`. Buttons: **Dismiss** and the action. Progress lines stream
    in the card.
- IPC (`preload/host.ts`, checked with `fromView` as today): `host-actions:list` (main → host),
  `host-actions:confirm(id)`, `host-actions:dismiss(id)` (host → main), `host-actions:progress`
  (main → host).

## Concept boundaries

- The **page token** (`#token=`, `/ws`, `/desktop/active-folder`) vs the **desktop token**
  (`/desktop/requests`, `/desktop/project`). Never accept one for the other.
- `start_project` (page, refused under `--live`) vs `request_project` (page asks) vs
  `POST /desktop/project` (app does). The refusal text under `--live` points at the request.
- The drawer's **HOST** strip stays the one trust marker. The Actions column is inside it.

## Validation

- devc web tests: `authorize` refuses the page token on `/desktop/requests` and the desktop token
  on `/ws`; `request_*` parsing; queue limits and expiry; `/desktop/project` refused under
  `--live-yolo` and allowed under `--live`.
- devc-desktop `npm test`: the stdout regex; the requests type guard (malformed, oversized, a
  control character in a folder); the folder check.
- Manual on the Mac, with `--live`: **Start** on a stopped container asks; the HOST strip badges;
  the drawer stays shut; confirming starts it with progress. **Push…** on a container repo shows
  the plan; a commit made by the agent after the plan makes Push fail with `the branch moved`.
- Manual: a hostile page that sends `request_push` every 100 ms gets rate-limited, and the
  confirm button never becomes enabled under a click that was already in motion.

## Relevant files

`devc/web/server.ts` (`authorize`, `DESKTOP_PREFIX`, the `/desktop/` handler near line 3299,
`startWeb`'s options), `devc/web/protocol.ts`, `devc/web/projects_view.ts` (`projectRefusal`),
`devc/web/static/sidebar.js` (Start, Push…), `devc-desktop/src/main/{launch,policy,main}.ts`,
`devc-desktop/src/preload/host.ts`, `devc-desktop/src/renderer/host.{html,ts,css}`,
`devc-desktop/README.md`, `devc/README.md`, `devc-desktop/proto/` (the layout prototype, for
look and feel).

## Implementation notes (2026-10-29)

Built as specified, with these choices where the plan left room or didn't fit:

- **The badge needs a visible strip.** A closed drawer had no rectangle, so its HOST strip couldn't
  show a badge. Now, while requests wait, a closed drawer shows **only its strip** (24 px,
  `HOST_PEEK` in `policy.ts`), badged, with `Cmd+J or Ctrl+\` to open`. It doesn't take focus. The
  host page loads for it, but the shell starts only when the drawer first opens (`host-term:shown`,
  main → host, and`info().open`), and the terminal keeps its size while it's that small.
- **`--live-yolo`.** The supervisor mints the desktop token, prints the line, and hands it to each
  child on **stdin** (`readTokenLine`), never in the environment. The child and the built-in
  fallback both refuse `POST /desktop/project` with 409 (`desktopProjects: false`). Requests still
  queue there, because push needs no trust in the server.
- **The queue.** `GET /desktop/requests` returns every pending request (the app reconciles against
  it). Asking again for a pending (kind, folder) answers with that request. The rate limit is 10
  asks per 10 s, repeats included. A folder with a control, bidi or zero-width character is
  refused.
- **Arming, twice.** The host page disables the confirm for 1 s after a card's content changes,
  and a click counts only if its press began after that. Main also refuses (and beeps) a confirm
  within 1 s of the last change, or while the drawer is closed.
- **After a confirm.** The card stays, with its output and outcome, until **Close**. The app
  dismisses the request on the server once it has run, so the page can ask again.
- **The page.** **Push…** is on every repo card's menu while `hello.desktopChannel` is set (on
  container and host projects alike, per D6). Under `--live`, Start (the row's ▶, the menu, and
  Ask agent's Start) sends `request_project`. The page sends no `stop` or `down` requests: it
  still does those itself, which `--live` allows. The server accepts them for later use.

Verified here: `deno check main.ts`, `deno task check`, `deno task test` (914 passed); the
desktop check script (`npm run check`, `npm test`: 41 passed) and `node build.mjs` in its Linux copy;
`deno fmt --check`. A stub-docker `devc web --desktop-channel` printed both lines. The page token
got 401 on `/desktop/requests` and the desktop token 401 on `/desktop/active-folder`.
`request_project` queued, a repeat answered with the same request, the 11th ask in 10 s was
refused, and `/desktop/project` streamed NDJSON. Under `--live-yolo` it gave 409, and the token was
in no process's environment. The host page was served standalone with a stub `window.hostTerm`
(agent-browser): the cards render, the confirm arms after 1 s, a press that began before a content
change is refused, and the strip-only view shows `1 request`.

**Still to check on the Mac** (Electron can't run in this container). Rebuild devcd.app first
(`npm run build:mac` from the container, or `npm run build` on the Mac), then run it with
`desktopWebArgs: ["--live"]`:

- [ ] **Start** on a stopped container: the toast says `asked devc-desktop…`. The drawer stays shut
      and focus stays in devc web, while the bottom of the window shows the HOST strip badged
      `1 request`. Open the drawer (Cmd+J): the card shows the folder and the initializeCommand
      line, Start enables after 1 s, and confirming streams progress and starts it.
- [ ] **Push…** on a container repo's card menu: the card shows branch → remote, the SHA and the
      commits. Make a commit in the container, then confirm: it fails with `the branch moved`.
      Dismiss it and ask again for a fresh plan, then Push works.
- [ ] With `desktopDevc: "devc2"`, the push card says devc runs from the checkout.
- [ ] A hostile page: in devc web's developer tools, send `request_push` every 100 ms. Within 10 s
      it is refused with `too many requests`. The drawer never opens by itself, and a click
      already held down when a card appears or changes doesn't confirm it.
