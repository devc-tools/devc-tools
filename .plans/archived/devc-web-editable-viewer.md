# devc-web-editable-viewer

## Checklist

- [x] Vendored CodeMirror gains `history`, `historyKeymap`, `indentWithTab` (commands) and `indentOnInput` (language); `VERSIONS` unchanged (same packages)
- [x] `files.ts`: `contentHash(bytes)`; `read_file` and `read_container_file` results gain `hash`
- [x] `container_files.ts`: `writeContainerText` (write with an optional base-hash check), with tests
- [x] Protocol: `write_file` message and its parser case, with tests
- [x] Server: `write_file` handler beside `createFile` (its logic is tested through `writeContainerText`)
- [x] `viewer.js`: editable view (`setEditable`, `getText`, `markClean`, `onChange`, `onSave`), line endings kept
- [x] `app.js`: file tiles edit and save (Ctrl/⌘+S, **Save** menu item), dirty marker, conflict prompt, discard prompts, preview promoted on first edit, `beforeunload`
- [x] `devc/README.md` (devc web, "Files and editing") updated

The file viewer ([devc-web-file-viewer](devc-web-file-viewer.md)) becomes the editor:
the same CodeMirror view with `readOnly` off while the file's container runs, and a `write_file`
message that saves it. "Open in editor" (`$EDITOR` in a terminal) stays as a menu item.

Read `.claude/skills/devc-web/SKILL.md` first if it exists.

## Concept boundaries

- **Which side writes.** Reads stay as they are (`read_file`: host side; `read_container_file`:
  `docker exec`). `write_file` always writes **inside the container** as the remote user
  (`dockerExecArgv`), like `create_file`, so the saved file keeps the container user's owner.
  Never `Deno.writeFile` on the host side. So a file tile is editable only while its project's
  container is `connected`; otherwise it is read-only, as today.
- **Write in place.** `cat > file` (truncate and write): owner, mode and inode are kept, as
  `vi` does. No temp-file-and-rename.
- **Conflict check by content hash, not mtime.** `read_container_file` has no mtime, and the host
  and container clocks are irrelevant to "did the bytes change". `hash` is the lowercase hex
  SHA-256 of the exact bytes read (`crypto.subtle.digest('SHA-256', bytes)`), before UTF-8
  decoding. On `write_file` with `base`, the server reads the file's current bytes in the
  container (`readContainerBytes`, `MAX_READ_BYTES`) and refuses with `conflict` if their hash is
  not `base`. Without `base` it overwrites. The check-then-write window is not atomic; accepted.
- **Dirty is per tile.** Two tiles on the same file are two buffers; each saves with its own
  `base`, so the second save after the first gets `conflict`.

## Contracts

### Browser → server

| Message      | Fields                                              | Server does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `write_file` | `id`, `container`, `root?`, `path`, `text`, `base?` | Addressed like `rename_file`: with `root`, `path` is relative to that repo folder and resolved with `repoContainerPath(…, 'file')` (must exist as a regular file under the repo, confined, mounted); without, `path` is an absolute container path. No session → `not_running`. UTF-8 of `text` over `MAX_READ_BYTES` → `too_large`. `base` given and the current bytes' hash differs (or the file is gone) → `conflict` with message `<path> changed since it was opened`. Else writes and replies `result {ok: true, result: {hash, size}}` for the bytes written. Other failures: `FilesError` code, else `write_failed`. |

Parser: `text` must be a string (may be empty; use the existing `text()` helper), `base` absent or
a 64-char lowercase hex string (`/^[0-9a-f]{64}$/`), else `Invalid`. `path` validated as
`rename_file`'s is (`newEntryPath`).

`read_file` result: `{text, size, mtimeMs, hash}`. `read_container_file` result: `{text, size, hash}`.

### `static/viewer.js`

```js
createViewer(el, { name, text, editable = false, onChange, onSave })
// Viewer gains:
setEditable(on: boolean)   // Compartment swap of readOnly/editable
getText(): string          // state.sliceDoc(): joined with the file's own line break
markClean()                // the current doc is what is on disk
dirty: boolean (getter)    // !doc.eq(cleanDoc)
// setText(text) replaces the content from disk and marks it clean.
// onChange(dirty) after every doc change; onSave() on Mod-s (preventDefault, always handled).
```

- Line endings: if the first line break in `text` is `\r\n`, the state gets
  `EditorState.lineSeparator.of('\r\n')`, so `getText()` saves CRLF back. `setText` diffs
  `state.toText(next).toString()` against `doc.toString()` (positions are in doc units).
- Keymap order: `Mod-s` first, then `searchKeymap`, `foldKeymap`, `historyKeymap`,
  `defaultKeymap`, `indentWithTab`. Extensions add `history()` and `indentOnInput()`.

### Page

- Tab title of a dirty tile: `● <name>`.
- **Save** is in the file tile menu while dirty and editable (first item). Ctrl/⌘+S in the view saves.
- Save while not editable (container stopped) never happens: the view is read-only.
- `conflict` → `confirmDialog('<name> changed on disk since it was opened. Overwrite it with your changes?', {okLabel: 'Overwrite', danger: true})`; OK resends without `base`. Other errors → `toast`.
- **Reload** while dirty → `confirmDialog('Discard your changes to <name>?', {okLabel: 'Discard', danger: true})` first.
- Closing a dirty tile with its tab's ×, or its **Close** menu item / icon → `confirmDialog('Close <name> without saving?', {okLabel: 'Close', danger: true})`. Closing a whole stack/row is not guarded.
- First edit in a preview tile calls `keepOpen(tile)`.
- `beforeunload` with any dirty tile: `e.preventDefault()`.
- Editability follows the container: re-evaluated after every read and every `containers` message.

## Validation

> Manual checks passed (the user, 2026-10-26).

- [x] `deno task test` (or `deno test -A devc/tests/`) passes, including new cases for: `write_file` parsing (missing `text`, bad `base`); `writeContainerText` (`conflict` on a changed or deleted file, in-place save keeping inode and mode, `too_large`, `not_running`); `hash` on both reads
- [x] `deno task check` clean; `deno lint` adds nothing beyond the repo's existing patterns
- [x] `bash scripts/vendor-codemirror.sh` run twice gives byte-identical output
- [x] `grep -c "historyKeymap" devc/web/static/vendor/codemirror/codemirror.mjs` > 0
- [x] Ask the user to try it in their open tab: edit, Ctrl/⌘+S, change the file in a terminal, save again → conflict prompt

## Relevant Files

- `scripts/codemirror-entry.js`
- `devc/web/static/vendor/codemirror/codemirror.mjs` (regenerated)
- `devc/web/files.ts`
- `devc/web/container_files.ts`
- `devc/web/protocol.ts`
- `devc/web/server.ts`
- `devc/web/static/viewer.js`
- `devc/web/static/layout.js` (tab element carries its tile id, for the × guard)
- `devc/web/static/app.js`
- `devc/tests/web_container_files_test.ts`, `devc/tests/web_files_test.ts`, `devc/tests/web_server_test.ts` (protocol parsing)
- `devc/README.md`
- `.plans/PLAN.md`
