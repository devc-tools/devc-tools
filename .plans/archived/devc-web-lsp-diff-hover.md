# devc-web-lsp-diff-hover

## Checklist

- [x] Host: view documents in `devc/web/lsp_session.ts`, per [Host: view documents](#host-view-documents)
- [x] Vendor: `marked` exported from `scripts/codemirror-entry.js`, bundle rebuilt, `VERSIONS`
      updated, per [Hover rendering](#hover-rendering)
- [x] Pure helper `newColumn` in `devc/web/static/lib/diff.js`, per [Positions](#positions)
- [x] Page: diff tiles share the page's session records (`devc/web/static/lsp.js`), per
      [Page: sessions](#page-sessions)
- [x] Page: hover in diff tiles (`devc/web/static/tiles.js`, `style.css`), per
      [Page: hover](#page-hover)
- [x] Page: Ctrl/Cmd+click go to definition from diff tiles, per
      [Page: go to definition](#page-go-to-definition)
- [x] Tests: `devc/tests/web_lsp_session_test.ts` and `devc/tests/web_diff_test.ts`, per
      [Tests](#tests)
- [x] `devc/README.md`: the **Language servers** bullet and the **Pull requests** section, per
      [Docs](#docs)
- [x] Run every [Validation](#validation) item an agent can run; hand the **(human)** items to
      the user
- [x] `deno fmt` every touched file

**Depends on [devc-web-lsp-core](devc-web-lsp-core.md)** (its code is on main; its manual items
may still be open). It works for every language server, so it needs no language plan, but the
manual items use the `typescript-lsp` Feature.

**Who runs what.** Items marked **(human)** need devc web on a host with Docker, a browser, and
a repo with an open pull request whose checkout is pinned in devc web. Everything else runs in
the devcontainer.

A pull request's diff tile gets **hover** (types and docs) and **Ctrl/Cmd+click go to
definition** on the lines that exist in the PR's head: added and context rows. It uses the same
language server session as the repo's file tiles. Deleted rows get nothing.

## Scope

- In: hover and go to definition on the **new side** (added and context rows) of a diff tile, in
  unified, split and Since viewed layouts, with or without **Hide whitespace**.
- Out: deleted rows (they only exist in the base, and a server holds one text per file), editing
  in the diff, diagnostics, completion, references, signature help, rename.
- A diff tile with no server for its file type, or whose container is not connected, behaves
  exactly as today: no hover, no message.

## Host: view documents

A diff tile's file is opened in the server with the **PR head's text**, so the diff's line
numbers are the document's line numbers. Today `LspSession` merges every page's `didOpen` of a
URI into one document, and a later open's text replaces the earlier one's (`#open` sends a
`didChange`). A diff must never replace an editor's text, and closing a diff must never close a
document an editor still holds. So diff tiles open **view documents** through two host-handled
methods, sent from the page as ordinary JSON-RPC messages inside `lsp_send`. They are never
forwarded to the server.

**Text tracking.** Each document keeps its current full text: `didOpen`'s `text`, then each
`didChange`'s last `contentChanges[].text` (the host already rewrites `textDocumentSync` to full,
so every change is a full text).

**Openers.** Each document has two opener sets: **editors** (today's openers, from
`didOpen`/`didClose`) and **viewers** (from `devc/openView`/`devc/closeView`). Both sets hold
peers (connections). One peer may be in both, for a page with a file tile and a diff tile on the
same file. The server's `didClose` is sent only when both sets are empty.

**`devc/openView`** — a request: `params: {textDocument: {uri, languageId, text}}`. The host
answers it itself, with the page's own id:

| Document state                  | Host does                                                                                  | Result                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| not open                        | `didOpen` (version 1) to the server, peer added to viewers                                 | `{ok: true}`                                                 |
| open, no editors, text equal    | peer added to viewers                                                                      | `{ok: true}`                                                 |
| open, no editors, text differs  | `didChange` to the new text; every **other** viewer peer gets `devc/viewStale`; peer added | `{ok: true}`                                                 |
| open with editors, text equal   | peer added to viewers                                                                      | `{ok: true}`                                                 |
| open with editors, text differs | nothing                                                                                    | `{ok: false, reason: "edited", text: <the document's text>}` |

**`devc/closeView`** — a notification: `params: {textDocument: {uri}}`. Removes the peer from
viewers; `didClose` to the server if both sets are now empty. No answer.

**`devc/viewStale`** — a notification from the host to a peer: `params: {textDocument: {uri}}`.
Sent to every viewer peer of a document whose text changes to something other than what that
peer opened, by an editor's `didOpen` or `didChange` (or by another viewer, row 3 above). The
stale peer is removed from viewers. An editor always wins: an editor's `didOpen` on a document
held only by viewers sends `didChange` to the editor's text, as today.

**Detach.** A detached peer leaves both sets of every document (as it leaves editors today).

**Diagnostics.** View documents get no diagnostics sent to pages: `publishDiagnostics` goes only
to editor peers, and pulls (`#schedulePull`) run only for documents with at least one editor.

## Positions

LSP positions are `{line, character}`, 0-based, `character` in UTF-16 code units (devc web
negotiates no `positionEncoding`, so the default applies; a JS string index is a UTF-16 index).

- `line` = the row's `new` line number (`DiffRow.new`, 1-based) − 1. Only rows with
  `kind === 'context'` or `kind === 'add'` and a non-null `new` take part.
- `character` comes from where the mouse is: `document.caretPositionFromPoint` (fall back to
  `caretRangeFromPoint`) gives a text node and an offset inside the row's `.diff-text` element.
  Sum the lengths of the text before it in that element, giving an offset into the **displayed**
  text.
- The displayed text is not always the row's text: `markedText` (`ui.js`) replaces invisible
  characters with a visible `⟨U+XXXX⟩` marker (`splitMarkers`, `lib/pr_tree.js`). Map the
  displayed offset back with a pure helper in `lib/diff.js`:

  ```js
  /** The UTF-16 offset in `text` of displayed offset `shown` in `markedText(text)`. */
  export function newColumn(text, shown)
  ```

  Walk `splitMarkers(text)`. A string part covers its own length in both. A marker part covers
  the marker's length when displayed and the original character's length (1 or 2 UTF-16 units)
  in `text`. An offset inside a marker maps to the original character's start. An offset past the
  end maps to `text.length`.
- **Hide whitespace** and **Since viewed** change which rows are drawn, never a drawn row's
  `text` or `new` number, so nothing else changes.

## Page: sessions

`lsp.js` keeps one record (client and transport) per session per page, today keyed by the file
tiles on it. A diff tile joins the same records:

- A diff tile that wants hover calls `lsp_attach` exactly as a file tile does for the same
  file: `{container, root, path}` from the diff's ref (`localFolder` → container via
  `containerByFolder`, `root`, `path`). It gets the same session as a file tile of that file,
  and the session's record counts the diff tile as a user (so the record is not dropped while
  the diff tile is open).
- The diff tile never calls the record's `lc.attach` (that is for editors). It sends requests
  with the record's `lc.client.request(method, params)`, and receives `devc/viewStale` by
  subscribing to the record's transport (`subscribers`).
- It attaches **lazily**: on the first hover attempt, not when the tile opens. It releases its
  session when the tile closes (sending `devc/closeView` first if it has a view open).
- A session restart (`lsp_status` `starting` after `ready` or `exited`) loses every view; the
  diff tile treats its view as not open and opens it again on its next hover.

## Page: hover

- **Trigger:** the mouse rests 300 ms (CodeMirror's default hover time) over a `.diff-text` of a
  new-side row (unified: the row's text; split: the right-hand text only). Moving off the text,
  scrolling the tile, pressing Escape or closing the tile hides the tooltip.
- **Text:** before its first hover the tile fetches the head text with the existing
  `pr_file_at {localFolder, root, path, sha: <the PR's headSha>}`, once per head sha (a refresh
  that changes `headSha` fetches again and re-opens the view). It then sends `devc/openView` with
  that text and the `uri` and `languageId` that `lsp_attach` returned.
- **Request:** `textDocument/hover` with `{textDocument: {uri}, position}`.
- **Tooltip:** an absolutely positioned element below the hovered line (above it when there is no
  room below), max 60 ch wide and 40 vh tall, scrolling inside, styled like CodeMirror's hover
  tooltip in the file tile (class `diff-hover`). It shows:

  | Situation                                                                                                              | Tooltip shows                                                                          |
  | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
  | hover result with contents                                                                                             | the rendered contents ([Hover rendering](#hover-rendering))                            |
  | `null` result or empty contents                                                                                        | nothing (no tooltip)                                                                   |
  | session `starting`                                                                                                     | `<Language>: starting…` (or the session's progress detail)                             |
  | `devc/openView` answered `edited`, and the hovered line differs in its `text` ([Open tile text](#open-tile-text))      | `No hover: this line differs in the file open in a tile.` (a jump: `No definition: …`) |
  | `pr_file_at` answered `available: false`                                                                               | `No hover: <its message>`                                                              |
  | session `exited`                                                                                                       | `<Language> language server stopped: <detail>`                                         |
  | file type no server takes, container not connected, no launcher (`unsupported`, `not_connected`, `no_language_server`) | nothing                                                                                |

  `<Language>` is `LSP_LANGUAGE_NAMES[...]` as the file tile's status line uses it.
- After `edited` or `devc/viewStale`, the next hover sends `devc/openView` again (the file may
  have been saved or closed meanwhile), so the state heals itself.

### Open tile text

`edited` means a file tile (on any page) holds the file with text other than the PR head's:
unsaved edits, saved ones, or a checkout not at the PR head. The server keeps that text, so the
diff tile works against it instead: `lineMap(headText, text)` (`lib/diff.js`) maps each PR head
line to the line it is unchanged as in `text` (from `diffTexts` with context as long as the
texts, so every unchanged line is a context row with both numbers). Hover and go to definition
on a mapped line use the mapped line and the same character (the line is identical). An
unmapped line (changed or deleted locally) gets the `this line differs` message. The map is made
again when either text changes.

## Hover rendering

`MarkupContent` `{kind, value}`: `markdown` → HTML from `marked.parse(value, {async: false})`;
`plaintext` → escaped text in a `<pre>`. A legacy `MarkedString` or array of them: strings are
markdown, `{language, value}` objects are fenced code blocks; join with a blank line. Every
rendered HTML string goes through `sanitizeLspHtml` before it is set as `innerHTML`, as the
editors' hovers do. Code blocks are not syntax highlighted. This lives in `viewer.js` as an
exported `lspHoverHtml(contents)` (hover `contents` in, sanitized HTML string out), next to
`sanitizeLspHtml`.

`marked` is already in the vendored bundle (lsp-client's dependency) but not exported. Add
`export { marked } from 'npm:marked@15.0.12';` to `scripts/codemirror-entry.js`, rebuild with
`bash scripts/vendor-codemirror.sh`, and note the export in `VERSIONS` (`marked 15.0.12
(lsp-client's hover Markdown; exported for the diff tile's hover)`). The version must match the
one lsp-client resolves, so the bundle still holds one copy. If `deno bundle` resolves a
different version, pin the entry to the one lsp-client uses.

## Page: go to definition

Ctrl+click (Cmd+click on macOS) on a new-side row's text: `textDocument/definition` at that
position (opening the view first, as hover does). The host already rewrites `LocationLink`s to
`Location`s. With one or more locations, take the first: open (or focus) a file tile on it the
way a file tile's F12 does (`lsp.js`'s `displayFile` path), with the cursor at the location's
`range.start`, scrolled into view. With none, nothing happens. A plain click keeps today's
behavior (text selection), and the cursor over new-side text shows `pointer` only while Ctrl/Cmd
is held.

## Tests

`devc/tests/web_lsp_session_test.ts` (fake `ServerPort`, as the existing tests):

1. `devc/openView` on a closed URI → one `didOpen` (version 1) with the view's text; answer
   `{ok: true}` with the page's id; nothing forwarded under the method name `devc/openView`.
2. Editor open, then `devc/openView` with equal text → `{ok: true}`, no message to the server.
3. Editor open, then `devc/openView` with different text → `{ok: false, reason: "edited",
   text: <the editor's text>}`, no
   message to the server.
4. View open, then an editor `didOpen` with different text → server gets `didChange` with the
   editor's text; the viewer peer gets `devc/viewStale` for that URI.
5. View open, then an editor `didChange` → `devc/viewStale` to the viewer peer.
6. Same peer holds the URI as editor and viewer; `devc/closeView` → no `didClose` to the server;
   then the editor's `didClose` → one `didClose`.
7. Same peer, editor `didClose` first, then `devc/closeView` → one `didClose`, after the second.
8. Two viewer peers; the second opens with different text and no editors → `didChange`; the
   first gets `devc/viewStale`; the second's answer is `{ok: true}`.
9. A view-only document gets no `publishDiagnostics` to its peer, and (for a pull server) no
   `textDocument/diagnostic` pull.
10. Detaching a peer that holds a view → `didClose` to the server when it was the last holder.

`devc/tests/web_diff_test.ts`, `newColumn`:

1. Plain ASCII: `newColumn('abc', 2) === 2`.
2. A surrogate pair before the offset: `newColumn('😀x', 2) === 2`.
3. One invisible character (U+200B) shown as `⟨U+200B⟩` (8 units): `newColumn('a​b', 9)`
   (after `a` and the marker) `=== 2`; an offset inside the marker (`3`) `=== 1`.
4. Past the end: `newColumn('ab', 99) === 2`.

`devc/tests/web_diff_test.ts`, `lineMap('a\nb\nc\nd\ne\n', 'new\na\nc\nD\ne\n')`: line 0 → 1, 1 →
null (deleted), 2 → 2, 3 → null (changed), 4 → 4; identical texts map every line to itself.

## Docs

`devc/README.md`:

- **Language servers** bullet: add one sentence: a pull request's diff tile also gets hover and
  Ctrl/Cmd+click go to definition on added and unchanged lines, from the PR head's text, or,
  while a tile holds the file with other text, on the lines that tile has unchanged.
- **Pull requests** section, where diff tiles are described: the same sentence, linking to the
  Language servers bullet.

## Validation

- [x] `cd devc && deno task check` passes
- [x] `cd devc && deno task test` passes, including the 10 session cases, the 4 `newColumn` cases and the
      `lineMap` case
      under [Tests](#tests)
- [x] After `bash scripts/vendor-codemirror.sh`, `devc/web/static/vendor/codemirror/codemirror.mjs`
      grows by under 5 KB (a second copy of `marked` would add about 40 KB), and
      `grep -c '^function docToHTML' devc/web/static/vendor/codemirror/codemirror.mjs` prints `1`
- [x] `deno fmt --check` passes for every touched file
- [x] **(human)** Setup: a TypeScript repo with the `typescript-lsp` Feature, an open PR whose
      branch is checked out, its PR pinned in devc web's Pull requests panel. Pick a changed
      `.ts` file whose added lines call a function defined in another file.
  - [x] Hovering a called function on an **added** row shows its signature within 2 s of the
        server being ready (first hover may show `TypeScript: starting…`)
  - [x] Hovering on a **context** row works; hovering a **deleted** row shows nothing
  - [x] Split layout: the right side hovers, the left side doesn't
  - [x] **Hide whitespace** on, then hover again: same result
  - [x] Ctrl/Cmd+click the called function opens a file tile at its definition, cursor there
  - [x] Escape and scrolling hide the tooltip
- [x] **(human)** Shared document: open the same file in a file tile (no edits). Hover in the
      diff still works. Add a line near the top of the file tile (saved or not): diff hovers
      below it still work, on the right names. Change a line the diff shows: hovering it shows
      `No hover: this line differs in the file open in a tile.` Undo: it hovers again. The file
      tile's diagnostics and hover keep working throughout.
- [x] **(human)** Local changes: with the file tile closed, change a line of the file from a
      terminal (not committed). Diff hovers still match the PR head (a function renamed only in
      the working tree still hovers under its PR name). Revert.
- [x] **(human)** Closing the diff tile while a file tile of the same file is open: the file
      tile keeps its hover and diagnostics.
- [x] **(human)** A diff tile for a `.md` file (no server): no tooltip, no message, nothing in
      the browser console.
- [x] **(human)** **Restart language server** from a file tile of that repo, then hover in the
      diff: works again after the restart.
- [x] `git status` in the repo used shows nothing devc web wrote

## Relevant Files

- `devc/web/lsp_session.ts` — view documents, text tracking, two opener sets, diagnostics only
  to editors
- `devc/web/static/lsp.js` — diff tiles as users of a session record
- `devc/web/static/tiles.js` — hover trigger, tooltip, go to definition in diff tiles
- `devc/web/static/lib/diff.js` — `newColumn`
- `devc/web/static/style.css` — `.diff-hover` tooltip
- `devc/web/static/viewer.js` — `lspHoverHtml(contents)`: imports `marked` from the bundle and
  returns sanitized HTML, per [Hover rendering](#hover-rendering)
- `scripts/codemirror-entry.js` — export `marked`
- `devc/web/static/vendor/codemirror/codemirror.mjs` — rebuilt
- `devc/web/static/vendor/codemirror/VERSIONS` — note the export
- `devc/tests/web_lsp_session_test.ts`
- `devc/tests/web_diff_test.ts`
- `devc/README.md`
- `.plans/PLAN.md`
