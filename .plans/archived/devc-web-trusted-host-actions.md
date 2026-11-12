# devc-web-trusted-host-actions

Two of devc web's host features wait for a confirmation in devc-desktop's HOST drawer even when
devc web is not `--live`: **Push** on a repo with no usable `gh-push` grant (`request_push`) and
**Open Host Terminal…** (`request_terminal`). The drawer exists because a page served under
`--live` comes from a checkout agents can write, so a click on it proves nothing
([devc-web-host-terminal-request](archived/devc-web-host-terminal-request.md) D1). Without
`--live` the page is the built-in copy and already starts containers and opens host shells (host
projects) with no confirmation, so the drawer adds nothing there.

## Decisions

- **D1: "trusted page" is `projectStarts`.** The server's existing switch (off under `--live`,
  `--source`, `--live-yolo`) decides. Nothing new on the command line.
- **D2: Push without a grant runs on the server, confirmed in the page.** Under a trusted page,
  a repo that has commits to push and no `now` route gets `push: 'user'`. Its Push asks the
  server for the plan (`push_plan`, the same `pushPlan` `devc git push-plan` prints), shows it in
  a page dialog (branch → remote, commits, warnings) and, on **Push**, sends `push_user` with the
  plan's SHA; the server runs the user push (`devc git push --sha`'s recipe run). This works in
  a plain browser too, and for host projects. Under `--live` nothing changes: `confirm` (asks
  devc-desktop) or unavailable.
- **D3: `gh-push` exit 3 under a trusted page opens the same dialog.** A granted push refused for
  something only the user may waive answers `push_result` with `confirm: true` (not `asked`);
  the page opens the plan dialog, whose warnings say what is waived. Under `--live` it still asks
  devc-desktop.
- **D4: the app opens host terminals at once when its devc web is not live.** devc-desktop
  knows the `devc web` arguments it ran. With none of `--live`, `--live-yolo`, `--source`,
  `--source=…` among them, a `terminal` request from the drawer is opened as soon as its folder
  check passes: no card, no drawer. A refused check or a failed open shows its card (and opens
  the drawer) as today. The Containers pane's **Open Host Terminal…** opens the same way (added after the first commit: the pane is the app's own bundled code, and a request from it still showed its card). Under `--live`,
  unchanged.

## Contracts

Client messages (`protocol.ts`), both refused with `result` `{ok: false, error: {code:
'live_refused'}}` while `projectStarts` is off, and `unknown repo` unless the folder is one of
the project's repos (`isProjectRepo`):

```ts
| { type: 'push_plan'; id: string; localFolder: string; folder: string }
// → { type: 'result', id, ok: true, result: PushPlan }   (PushPlan as git_push.ts)
| { type: 'push_user'; id: string; localFolder: string; folder: string; sha: string }
// → { type: 'push_result', id, folder, ok: true, message } | { ..., ok: false, problem }
```

`sha` must match `/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/`. `push_user` shares `push_repo`'s rate
limit (`pushStarts`). `message` is the recipe's last stdout line (`pushed: …` / `up to date: …`);
`problem` its last stderr line without `gh-push:`, else `gh-push exited <code>`.

`RepoView.push`: `'now' | 'user' | 'confirm'`. `push_result` gains `confirm?: true`.

Route order (`pushRoute`): upstream not `origin/<branch>` → unavailable; grant + running + pinned
branch → `now`; trusted page → `user`; devc-desktop → `confirm`; else unavailable as today.

## Checklist

- [x] `git_push.ts`: `userPush`, the user push with its output captured (`{ok, message}` or `{ok: false, code, problem}`) for the server
- [x] `granted_push.ts`: `pushRoute`/`pushRoutes` take `direct`; `escalate` returns `confirm` when direct; `userPushRefusal`
- [x] `protocol.ts`, `projects_view.ts`: `push_plan`, `push_user`, `'user'`, `confirm`
- [x] `server.ts`: handlers, routes with `projectStarts`, escalation
- [x] Page: `'user'` Push and `confirm: true` open the plan dialog (`ui.js` labels, `menus.js`, `cards.js`)
- [x] devc-desktop: `livePage(args)`; drawer terminals opened at once when not live
- [x] Tests; `devc/README.md`, `devc-desktop/README.md`; `deno fmt`; build the Mac apps

## Validation

- [x] `deno test` for `devc/tests/web_granted_push_test.ts` (routes with `direct`, escalate, `userPushRefusal`), `web_push_plan_test.ts` (the dialog's text), `git_push_test.ts` (`userPush`)
- [x] `push_plan` / `push_user` refused with `live_refused` under `--live` (`userPushRefusal`), and parsed with a full SHA only (`web_desktop_test.ts`)
- [x] devc-desktop `npm test` (`livePage`)
- [x] `deno task check`, `npm run check`, `deno lint` of the page files; the push dialog rendered in headless Chromium; `npm run build:mac` in `devc-desktop/`
- [ ] Manual on the Mac (not run): Push on a no-grant repo shows the plan dialog and pushes;
      Open Host Terminal… opens a tile with no drawer card

## Relevant Files

- `devc/git_push.ts`
- `devc/web/granted_push.ts`, `devc/web/protocol.ts`, `devc/web/projects_view.ts`, `devc/web/server.ts`
- `devc/web/static/cards.js`, `devc/web/static/menus.js`, `devc/web/static/ui.js`, `devc/web/static/style.css`
- `devc/tests/web_granted_push_test.ts`, `devc/tests/web_desktop_test.ts`, `devc/tests/git_push_test.ts`, `devc/tests/web_push_plan_test.ts`, `devc/web/static/lib/push_plan.js`
- `devc-desktop/src/main/launch.ts`, `devc-desktop/src/main/main.ts`, `devc-desktop/tests/`
- `devc/README.md`, `devc-desktop/README.md`
