# devc-web-open-in-jira

## Checklist

- [x] `devc-core/config.ts`: `jiraFromConfig(cfg)` reads and validates `"jira"` from `~/.config/devc/config.json`, with tests in `devc-core/tests/global_config_test.ts`
- [x] `devc/web/static/lib/jira.js` (new): `jiraKeys(branch, jira)` and `jiraUrl(jira, key)`, with tests in `devc/tests/web_jira_test.ts` (new)
- [x] `devc/web/server.ts`: a `jira` message sent to each page on connect and broadcast when `config.json` changes
- [x] `devc/web/static/app.js`: handles `jira`; one shared helper builds the **Open `<KEY>` in Jira** group from a branch
- [x] `app.js`: terminal tile menu (tab, Layout row, right-click in the terminal) and pane row menu under Containers
- [x] `app.js`: file tile menu
- [x] `app.js`: repo row menu under Containers, and a new right-click menu on an In use group's folder row
- [x] `devc/README.md`: the devc web **Menus** bullet, and a `"jira"` config example
- [x] `.plans/design/devc-design.md`: "Global user configuration" lists `"jira"`

When the branch devc web shows for a terminal, a file tile or a repo row contains a Jira issue key
(`feature/AB-12345-fix`), that thing's right-click menu offers **Open AB-12345 in Jira**. Which
keys count and which Jira site they open are set in `~/.config/devc/config.json`; with no
`"jira"` there, nothing changes.

Read `.claude/skills/devc-web/SKILL.md` first if it exists.

## Concept boundaries

- **The branch is always one devc web already shows.** No new git read, no new server field.
  Each surface uses the branch it displays today:
  - **Terminal tile / file tile:** `activeRepo(tile).branch` (via `tileRepo`), the branch in the
    tile's tab context (`tile-branch`) and the window title. For a pane that is the repo holding
    `foreground_cwd || cwd`; for a file, the file's repo.
  - **Pane row under Containers** (`paneMenu(rec)`): the same repo lookup as `tileRepo`'s pane
    case, from `rec.c.localFolder` and `rec.pane` (`repoAt(projectRepos(...), cwd)`); factor it
    out of `tileRepo` rather than duplicating.
  - **Repo row under Containers** (`repoRows` → `repoRow(r, …)`, including nested worktree rows):
    `r.git?.branch`.
  - **In use group folder row** (`inUseGroupRows`, the `head` row): `g.repo?.git?.branch`, the
    branch it already renders as `repo-branch`.
    No branch (outside every repo, detached or unread HEAD, `git: null`) → no item.
- **Not covered:** project rows (under Not running and the container rows), Files/folder rows,
  sessions, tasks. Their menus are unchanged.
- **Menus read the branch when they open**, so a branch switch shows on the next right-click with
  no extra wiring. Handlers must compute keys at open time, not capture them at render.
- **Config is host-only and read by the server.** The page never reads files; the server sends the
  validated config. One Jira site (one object), not a list; a second site is out of scope.
- **Opening the URL** uses `window.open(url, '_blank', 'noopener,noreferrer')`, exactly as
  `openLink` does for URLs. In devc-desktop that already goes through `setWindowOpenHandler` →
  `externalUrl` (http/https only) → `shell.openExternal`; devc-desktop does not change.

## Contracts

### `~/.config/devc/config.json`

```json
{
  "jira": {
    "pattern": "AB-\\d+",
    "url": "https://acme.atlassian.net/browse/{key}"
  }
}
```

- `pattern` — a JavaScript `RegExp` source (JSON-escaped, so `\d` is written `"\\d"`) matching one
  issue key. Several projects: `"(?:AB|CD)-\\d+"`. Matching is **case-insensitive** (branches are
  often lower-cased: `ab-12345-fix`) and the key is **upper-cased** for the label and URL.
- `url` — an `http:` or `https:` URL containing `{key}`; every `{key}` is replaced by
  `encodeURIComponent(KEY)`.
- Absent, or `null`: the feature is off. Like every other key, `"jira"` round-trips untouched
  through the config wizard (it lives in `GlobalConfig.extra`; no change to `loadGlobalConfig`
  or `saveGlobalConfig`).

`jiraFromConfig(cfg: GlobalConfig): { pattern: string; url: string } | null`, beside
`webSourceFromConfig` and in its style (errors are prefixed with `displayPath(cfg.path)`):

| Input                                                                          | Result                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `jira` absent or `null`                                                        | `null`                                                                         |
| not a plain object (array, string, …)                                          | throws `<path>: "jira" must be an object`                                      |
| `pattern` not a non-empty string                                               | throws `<path>: "jira.pattern" must be a non-empty string`                     |
| `new RegExp(pattern, 'i')` throws                                              | throws `<path>: "jira.pattern" is not a valid regular expression: <e.message>` |
| the pattern, anchored as `^(?:` + pattern + `)$` with flag `i`, matches `''`   | throws `<path>: "jira.pattern" must not match an empty string`                 |
| `url` not a string, or `new URL(url)` throws, or protocol not `http:`/`https:` | throws `<path>: "jira.url" must be an http(s) URL`                             |
| `url` lacks the substring `{key}`                                              | throws `<path>: "jira.url" must contain {key}`                                 |
| otherwise                                                                      | `{ pattern, url }`, both exactly as stored (no expansion)                      |

Gotcha: check `{key}` on the raw string, not on `new URL(url).href` — `URL` percent-encodes `{`
and `}` in paths.

### Server → page: `jira`

```json
{ "type": "jira", "jira": { "pattern": "AB-\\d+", "url": "https://acme.atlassian.net/browse/{key}" } }
{ "type": "jira", "jira": null }
```

- Computed at startup from `loadGlobalConfig()` + `jiraFromConfig`, kept in memory, sent to each
  client on connect right after `pinned_files`/`tasks` (after `hello`), and re-read and
  **broadcast** when `config.json` changes — use the existing `watchConfigFile(GLOBAL_CONFIG_PATH,
  …)` (debounced, watches the directory; stop it with the others on shutdown).
- `jiraFromConfig` throwing: send `jira: null` and print `devc web: <message>` to stderr once per
  change (not once per client).
- Not added to `protocol.ts` (it parses client messages only).

### `static/lib/jira.js` (pure, no DOM; JSDoc-typed like the other `lib/` modules)

```js
/** @typedef {{pattern: string, url: string}} JiraConfig */

/**
 * @param {string | null | undefined} branch
 * @param {JiraConfig | null} jira
 * @returns {string[]}
 */
export function jiraKeys(branch, jira) {}

/**
 * @param {JiraConfig} jira
 * @param {string} key
 * @returns {string}
 */
export function jiraUrl(jira, key) {}
```

- `jiraKeys`: `[]` when `branch` is empty or `jira` is null, or when the pattern fails to compile
  (try/catch; never throws). Otherwise it compiles, with flags `gi`, the source
  `(?<![A-Za-z0-9])(?:` + `jira.pattern` + `)(?![A-Za-z0-9])` and returns each
  `match[0].toUpperCase()` from `branch.matchAll(...)`, skipping empty matches, de-duplicated,
  in order of first appearance, at most **3**. The lookarounds stop `AB-\d+` matching inside
  `XAB-12` or `AB-12x`; `-`, `/`, `_` and `.` are boundaries.
- `jiraUrl`: `jira.url.replaceAll('{key}', encodeURIComponent(key))`.

| `branch`                     | `pattern`        | `jiraKeys`                 |
| ---------------------------- | ---------------- | -------------------------- |
| `feature/AB-12345-fix-thing` | `AB-\d+`         | `["AB-12345"]`             |
| `ab-12345_fix`               | `AB-\d+`         | `["AB-12345"]`             |
| `AB-1-and-AB-2-and-ab-1`     | `AB-\d+`         | `["AB-1", "AB-2"]`         |
| `AB-1-AB-2-AB-3-AB-4`        | `AB-\d+`         | `["AB-1", "AB-2", "AB-3"]` |
| `XAB-12`                     | `AB-\d+`         | `[]`                       |
| `cd-7/ab-9`                  | `(?:AB\|CD)-\d+` | `["CD-7", "AB-9"]`         |
| `main`                       | `AB-\d+`         | `[]`                       |
| `AB-12`                      | `(` (invalid)    | `[]`                       |

### Menus (`app.js`)

- One helper takes a branch and returns the menu items to splice in: `[]` when `jiraKeys` is
  empty, else a `null` separator followed by one item per key, in order, labeled
  `Open <KEY> in Jira` (e.g. `Open AB-12345 in Jira`). Put the label text in `LABELS` like the
  other menu strings. Every surface below uses it.
- **Terminal tile** (`tileMenuItems`, used by its tab, its Layout row and the right-click inside
  the terminal): for a pane tile with a resolved `pane`, the group goes directly after the
  **Reveal in Containers** group, before Unpin / Keep open / Close.
- **Pane row under Containers** (`paneMenu`): the group after **Show in layout** and before
  **Rename…**.
- **File tile** (`fileTileMenuItems`, used by its tab and its Layout row): when `tile.file` is
  set, the group goes after the copy-path / Pin file groups and before Keep open / Close.
- **Repo row under Containers** (`repoRow`'s `oncontextmenu`, today `dirMenuItems(fr, '')`): the
  group is appended after the `dirMenuItems` items. Worktree rows nested under a repo get it from
  their own `r`.
- **In use group folder row** (the `head` row in `inUseGroupRows`, which today has no
  `oncontextmenu`): gains one. When the helper returns items, it opens a menu of just the Jira
  items (drop the leading separator). When it returns `[]`, the handler does nothing — no
  `preventDefault`, no menu — so the row behaves exactly as today.
- No keys (no config, no branch, no match): no group and no separator — every menu is exactly as
  today.
- `onMessage` gains `case 'jira'`: store `msg.jira` (anything that isn't an object with string
  `pattern` and `url` is stored as `null`). No re-render needed; menus read it when opened.

## Implementation notes

- Since this plan was written the global config may be `config.jsonc` (devc-config-jsonc).
  `loadGlobalConfig()` already picks the file, and the server watches `GLOBAL_CONFIG_PATHS`
  (both names), not `GLOBAL_CONFIG_PATH`. Error messages name whichever file is in use.
- Diff tiles (devc-web-pr-review, landed after this plan) are not covered, like other
  surfaces outside the plan's list.

## Relevant Files

- `devc-core/config.ts` — `jiraFromConfig`
- `devc-core/tests/global_config_test.ts` — its tests
- `devc/web/server.ts` — `jira` state, message on connect, `watchConfigFile(GLOBAL_CONFIG_PATH, …)`, stop on shutdown
- `devc/web/static/lib/jira.js` — new
- `devc/tests/web_jira_test.ts` — new
- `devc/web/static/app.js` — `case 'jira'`, `LABELS`, the shared Jira-items helper, `tileMenuItems`, `paneMenu`, `fileTileMenuItems`, `repoRows`, `inUseGroupRows`, the pane-repo lookup factored out of `tileRepo`
- `devc/README.md` — devc web **Menus** bullet (terminal, file tile, repo row and In use folder row menus); a `"jira"` example after the `webSource` example or in the devc web section
- `.plans/design/devc-design.md` — "Global user configuration": one paragraph on `"jira"`
- `.plans/PLAN.md` — status

## Validation

- [ ] `cd devc-core && deno task check && deno task test` passes, including new `jiraFromConfig` tests covering every row of its table, and that `"jira"` survives a `saveGlobalConfig` round trip
  - 2026-10-21: check passes and the new test passes; the suite has one failure,
    `cliWorktreeMounts matches what the pinned devcontainer CLI computes`
    (`tests/git_dirs_test.ts`), which fails the same way on a clean checkout of the base commit.
- [x] `cd devc && deno task check && deno task test` passes, with `web_jira_test.ts` covering every row of the `jiraKeys` table and `jiraUrl` encoding (`{key}` twice in the URL; a key with a character `encodeURIComponent` changes)
- [ ] `deno fmt --check` passes at the repo root
  - 2026-10-21: every file this plan touches passes; the repo-wide check still fails on 15
    files under `.plans/` it does not touch (archived plans, `design/devc-web-ux/`).
- [ ] Manual (`devc web --live`, a running container): with no `"jira"`, the menus of a terminal tile, a pane row, a file tile and a repo row are unchanged, and right-clicking an In use folder row behaves as before
- [ ] Manual: add `{"jira": {"pattern": "AB-\\d+", "url": "https://example.atlassian.net/browse/{key}"}}` to `~/.config/devc/config.json` without restarting; with a repo on `ab-123-test`, **Open AB-123 in Jira** appears on: right-click inside a terminal in that repo, its tab, its Layout row, its pane row under Containers; a file tile of a file in that repo (tab and Layout row); the repo's row under Containers; its In use folder row. Each opens `https://example.atlassian.net/browse/AB-123` in a new browser tab (and in the default browser from devc-desktop)
- [ ] Manual: a worktree of that repo on `ab-456-other` shows **Open AB-456 in Jira** on its own nested repo row, not AB-123
- [ ] Manual: `cd` the terminal to a folder outside any repo (or a repo on `main`) — the item is gone from its menus on the next right-click; a repo on `main` has none on its rows
- [ ] Manual: set `"pattern": "("` — devc web prints `devc web: …"jira.pattern" is not a valid regular expression…` once to stderr and the items disappear everywhere; fixing the file brings them back without a restart
