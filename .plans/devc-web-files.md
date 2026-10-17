# devc-web-files

- [ ] Server: `list_dir` (project files) and `list_host_dir` (folder picker), with path confinement and tests
- [ ] Server: `open_file`: a new shell running `$EDITOR` on the file, built on `createShell`
- [ ] Sidebar: a lazily loaded **Files** node under each project
- [ ] Open a file → editor pane placed in the layout; Copy path; Open shell here
- [ ] "Add project…" uses a host folder picker instead of `prompt()`
- [ ] `.plans/devc-web.md` protocol section updated
- [ ] Verify (below) and ask the user to try it in their open tab

Browse a project's files from the `devc web` sidebar and open them. Opening a file runs an
editor in a new pane: the container's `$EDITOR`, falling back to `vi`. That pane is placed in
the layout like any other, so editing needs no new kind of tile. The same directory-tree
component, pointed at the host, becomes the folder picker for "Add project…".

```
PROJECTS
  ▾ api                    ● working
    ▾ Files
      ▸ src
        package.json
        README.md
      claude   👁
      shell
```

Depends on [devc-web-layout-sidebar](archived/devc-web-layout-sidebar.md) (`createShell`, `addBeside`) and
[devc-web-projects](devc-web-projects.md) (the projects list that confines what can be browsed,
and `add_project`). Read `/workspaces/devc-dev/.claude/skills/devc-web/SKILL.md` first.

**Not in this plan** (possible follow-ons):

- a read-only viewer tile (a second Golden Layout component type);
- an in-browser editor (overlaps with [feature-headless-vscode](feature-headless-vscode.md));
- browsing container paths outside the bind-mounted workspace;
- file watching.

## Concept boundaries

- **Host path vs container path.** `list_dir` reads the **host** side of the bind mount
  (`localFolder`), so it works while the container is stopped and needs no `docker exec`. The
  editor runs in the **container**, so `open_file` translates the path with devc-core's
  `hostToContainerPath(hostPath, mounts)` (`devc-core/mount_paths.ts`), using
  `getContainerMounts(localFolder)`. Never send a host path to Herdr.
- **"Open" means two different things.** An existing `open` message attaches a tile to a pane's
  terminal stream. Opening a file is `open_file`, and it _creates_ a pane. Keep the names apart,
  in code and in UI text: the menu says "Edit" or "Open in editor".
- **Files node vs pane rows.** Under a project row, the Files node comes first and pane rows come
  after it. File rows aren't Golden Layout drag sources, and they aren't kept in `paneRows`.
- **Picker roots.** The host folder picker browses the host filesystem only under `$HOME` (the
  home of the user `devc web` runs as). That is the whole allowlist. Don't add a config key for it in this plan.

## Existing touchpoints

| File                                                 | Role                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `devc/web/protocol.ts`                               | New `ClientMessage` variants.                                                                             |
| `devc/web/server.ts`                                 | `handle()` cases. The projects list (from devc-web-projects) decides which `localFolder`s may be browsed. |
| `devc/web/herdr_bridge.ts`                           | `createShell` (from devc-web-layout-sidebar) and `bridgeRequest`, used for `pane.send_text`.              |
| `devc-core/container.ts`, `devc-core/mount_paths.ts` | `getContainerMounts`, `hostToContainerPath`.                                                              |
| `devc/web/static/app.js`                             | `containerRows` gains the Files node. "Add project…" opens the picker.                                    |
| `devc/web/static/lib/`                               | A new pure module, `files.js`: entry sorting and the path helpers that the page and tests share.          |
| `devc/web/static/style.css`                          | File and dir rows, and the picker dialog.                                                                 |

## Contracts

### Path confinement (server, pure + tested)

```ts
// devc/web/files.ts
/**
 * Resolves `rel` (a '/'-separated path relative to `root`; '' is the root itself) to an absolute
 * host path, or null when it is absolute, contains a `..` segment, or — after `Deno.realPath` —
 * lands outside `realPath(root)` (a symlink pointing out). Async because of realPath.
 */
export function confine(root: string, rel: string): Promise<string | null>;

export interface DirEntry {
  name: string;
  kind: 'dir' | 'file' | 'symlink';
  size?: number;
}
export const MAX_ENTRIES = 2000;
/** Dirs first, then files, each case-insensitively by name. */
export function sortEntries(entries: DirEntry[]): DirEntry[];
```

- **Symlinks** come back as `kind: 'symlink'`, unresolved. Expanding or opening one goes back
  through `confine`, so a symlink that points out of the project fails there.
- **Tests:** `..`, absolute paths, a symlink escaping the root, a symlink staying inside, the
  root itself, and sorting.

### Browser → server

| Message         | Fields                      | Server does                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_dir`      | `id`, `localFolder`, `path` | `localFolder` must be a listed project, else `bad_request`. `confine(localFolder, path)`, then read the directory. Reply `result {ok: true, result: {entries: DirEntry[], truncated: boolean}}`, with the sorted entries capped at `MAX_ENTRIES`. A path outside the project gets `code: "forbidden"`; a missing directory gets `code: "not_found"`.                                                         |
| `list_host_dir` | `id`, `path`                | `path` is absolute, or `''` for `$HOME`; it is confined to `$HOME` the same way. Reply `{entries, truncated, path, parent}`, where `path` is the resolved absolute path and `parent` is `null` at `$HOME`. Directories only, and each entry gains `project: boolean`: true when it contains `.devcontainer/` or `.devcontainer.json`, or is a known project.                                                 |
| `open_file`     | `id`, `container`, `path`   | `path` is relative to that container's `localFolder` and goes through `confine`. Get the mounts, then `hostToContainerPath`; if that returns null (not mounted), use `code: "not_mounted"`. Then `createShell(target, {cwd: <container dir of the file>})` and `pane.send_text {pane_id, text: "exec \"${EDITOR:-vi}\" -- '<file>'\n"}`, with the file name single-quote-escaped. Reply `{pane_id, tab_id}`. |

- **`exec`** means quitting the editor ends the pane. The page then sees `pane_closed`, and the
  tile shows "Pane gone" as it does for any exited pane. That is acceptable. If it feels wrong
  in use, a later change can auto-close such tiles.
- **The editor runs** in Herdr's default shell for the remote user. Don't try to read the
  container's environment from the server.
- **Allowlist:** `pane.send_text` is called server-side only, so it doesn't join `REQUEST_METHODS`.

### Page

- **Files node:** each project row gets a **Files** child, collapsed by default. Expanding a
  directory sends `list_dir`. Children are cached until the node is collapsed and re-expanded,
  or until "Refresh" (in the directory's menu).
  - The expanded paths are saved in `sidebarState.filesOpen: {[localFolder]: string[]}`, under
    the same `SIDEBAR_KEY`. On load, re-list them in order, and drop any that fail.
  - Dotfiles are listed, with dimmed text. `truncated` shows a final row: "… more not shown".
  - The Files node works whether or not the container is running.
- **File row:**
  - click or Enter: **Open in editor** (needs a running container; otherwise a toast "Start the
    container first"). Place the new pane with `addBeside(focusedTile, ref, 'stack')`.
  - menu: Open in editor · Open in editor to the right · Copy path (container path if running, else host path).
- **Directory row** menu: New shell here (`new_shell` with the container dir as `cwd`) · Refresh · Copy path.
- **Folder picker:** "Add project…" opens a modal dialog. It shows a single-column listing of
  `list_host_dir` with breadcrumbs. Rows with `project: true` have a project icon. It has a
  "Pin this folder" button, which sends `add_project`, plus a text field for pasting an absolute
  path. Escape closes it.

## Verify

```bash
cd /workspaces/tools/devc-tools/devc
deno task check && deno task test
cd .. && deno fmt --check
```

Then ask the user to check:

1. Expand Files in a project and drill a few levels. Reload: the same folders are still open.
2. Open a file: the editor appears in a new tile in the focused stack. Quit it: the pane ends.
3. "Open in editor to the right" splits the layout.
4. Stop the container: Files still browses, and Open shows "Start the container first".
5. A symlink pointing outside the project can't be expanded or opened.
6. Add project…: browse into a folder with `.devcontainer/`, pin it, and it appears as "not created".
