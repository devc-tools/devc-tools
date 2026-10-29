# devc-desktop: host actions — push and container starts confirmed in the HOST drawer

Decided with the user on 2026-10-28. Fifth of six plans (see "Git and the trusted host area" in
`PLAN.md`). After `devc-git-user-push`.

## Checklist

- [ ] devc web: `--desktop-channel`, the desktop token, and its ready line.
- [ ] devc web: page requests (`request_push`, `request_project`) and the `/desktop/requests` and
      `/desktop/project` routes.
- [ ] devc-desktop: `launch.ts` reads the desktop token; `policy.ts` checks requests.
- [ ] devc-desktop: an Actions column in the host drawer (`host.html`), with its IPC.
- [ ] Page: Push… and, under `--live`, Start ask devc-desktop.
- [ ] Tests, both READMEs (devc-desktop's "Why devc web cannot reach it" gains this).

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
