# devc-web-copy-on-select

- [ ] `web/selection.ts`: pure viewport→content conversion, with tests in `devc/tests/web_selection_test.ts`
- [ ] `protocol.ts` accepts `read_selection`, with tests in `devc/tests/web_server_test.ts` (or wherever message validation is tested today)
- [ ] `server.ts` handles `read_selection` (`pane.get`, then `pane.selection.read`) and replies with `result`; `deno check main.ts` passes and the host restarts
- [ ] Renderer gains `highlight` / `clearHighlight`
- [ ] Page: a plain left-drag that moves at least one cell highlights, sends `read_selection`, and writes the reply to the clipboard
- [ ] Spec tables in `devc-web.md` updated (protocol and "Browser UI → Mouse")
- [ ] Verify (below) and ask the user to try it

When you drag-select text in a `devc web` tile, it is copied to the clipboard automatically, the
way it is in a Herdr TUI. A plain drag is still forwarded to Herdr as `mouse`, exactly as today.
The copy happens alongside it. The existing **Shift+drag** (local xterm.js selection, copied on
mouseup) is unchanged.

Builds on [devc-web](devc-web.md). Read `/workspaces/devc-dev/.claude/skills/devc-web/SKILL.md`
first: the user runs `devc web` in live mode, and protocol changes go **server first**.

## Background: what Herdr 0.9.5 does with a drag (measured 2026-10-16)

These were measured in throwaway `herdr --session <name> server` sessions.

- **No selection over `terminal session control`.** Plain `terminal.mouse` down/drag/up over
  shell output (a pane with no mouse tracking) produced **no frame at all**. Herdr draws no
  highlight and copies nothing for a control client.
- **OSC 52 never reaches the frames.** A pane that ran
  `printf '\e]52;c;%s\a' "$(printf COPIED_TEXT | base64)"` produced frames with no `ESC ] 52`
  in them. Frames are Herdr's own redraw (see devc-web.md § "Frames are Herdr's own redraw").
  An app's own clipboard writes are lost too, and this plan doesn't change that.
- **`pane.selection.read` returns text for client-owned coordinates.** This is the API this
  plan uses:
  - Request: `{"method":"pane.selection.read","params":{"pane_id":"w1:p1","anchor":{"row":21,"col":0},"cursor":{"row":23,"col":3}}}`
  - Reply: `{"result":{"type":"pane_selection","pane_id":"w1:p1","text":"LINE_22\nLINE_23\nLINE"}}`
  - `row` is an **absolute content row**: 0 is the oldest scrollback line. It is _not_ a
    viewport row. `col` is zero-based.
  - Both ends are **inclusive**, and their order doesn't matter: anchor `(23,3)` with
    cursor `(21,2)` returned `NE_22\nLINE_23\nLINE`.
  - Rows past the end give error `selection_unavailable` ("selection text is unavailable").
  - The optional `content_revision` gives `stale_content` when it doesn't match. The pane's
    `revision` field from `pane.get` is **not** that value (passing it gave `stale_content`),
    and no other source was found. **Omit `content_revision`.**
- **The scroll position comes from `pane.get`:**
  `result.pane.scroll = {offset_from_bottom, max_offset_from_bottom, viewport_rows}`.
  - The content row of viewport row `v` is
    `max_offset_from_bottom - offset_from_bottom + v`.
  - Checked: 61 content rows, `max_offset_from_bottom: 21`, `offset_from_bottom: 0`,
    viewport 40. Viewport row 0 is content row 21 (`LINE_22`).
  - The scrolled case (`offset_from_bottom > 0`) follows from the same formula but was
    **not** measured. Check it while verifying.
- Why not use xterm.js's own selection? Frames paint each row with cursor positioning, so the
  browser can't tell soft-wrapped lines from hard newlines. Herdr's text comes from the real
  buffer.

## Concept boundaries

- **`request`** (browser → server) is the allowlisted one-shot Herdr call
  (`REQUEST_METHODS`). Don't add `pane.selection.read` or `pane.get` to that allowlist.
  `read_selection` is its own message, because the server does the viewport→content conversion
  between two Herdr calls.
- **`renderer.selection()`** already exists. It returns xterm.js's _local_ (Shift+drag)
  selection. The new `highlight`/`clearHighlight` only _paint_ a range. Name them that way,
  and leave `selection()` as it is.
- **`pendingRequests`** in `app.js` maps ids to a description for error toasts, and success
  results are ignored. A selection reply carries text the page needs, so it uses its own map of
  ids to resolvers. Either use a distinct id prefix (`s<n>`) or check the selection map before
  falling through to `pendingRequests` in the `result` handler.
- **Cells.** The page's `mouse` messages use `column`/`row` (viewport, zero-based).
  `read_selection` uses the same names and the same viewport space. Only the server talks
  Herdr's `col` and content rows.

## Existing touchpoints

| File (under `devc/`)     | Role                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `web/protocol.ts`        | `ClientMessage` union plus validation. Add `read_selection`.                                                                          |
| `web/server.ts`          | Message dispatch (the `switch` on `msg.type`, next to `case 'request'`). Calls Herdr with `bridgeRequest` from `web/herdr_bridge.ts`. |
| `web/selection.ts` (new) | A pure helper so the conversion is testable without Herdr.                                                                            |
| `web/static/renderer.js` | The only xterm.js importer. Gains `highlight`/`clearHighlight`.                                                                       |
| `web/static/app.js`      | `attachMouse` (plain drag path), the `result` handler, `toast`.                                                                       |
| `.plans/devc-web.md`     | § "Browser ⇄ server WebSocket protocol" (browser → server table), § "Browser UI → Mouse".                                             |
| `tests/web_*_test.ts`    | `web_selection_test.ts` (new), plus the existing protocol validation tests.                                                           |

## Contracts

### Browser → server: `read_selection`

| `type`           | Fields                                                                         | Server action                                                             |
| ---------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `read_selection` | `id`, `container`, `pane_id`, `anchor: {column, row}`, `cursor: {column, row}` | `pane.get`, convert rows, `pane.selection.read`. Replied to with `result` |

- `column` and `row` are integers ≥ 0 in the tile's **viewport**: the same cells as `mouse`.
  `column` ≤ 65535. Anything else is malformed. Reject it the way other malformed messages
  are rejected today.
- An unknown container or pane is handled like `open`/`request`.
- Reply on success: `result {id, ok: true, result: {text: string}}`.
- Reply on failure: `result {id, ok: false, error: {code, message}}`, with Herdr's code passed
  through (`selection_unavailable`, `pane_not_found`, …) or the bridge's (`no_session`,
  `bridge_exited`).

### `web/selection.ts`

```ts
export type Cell = { column: number; row: number };
export type PaneScroll = {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
};
export type TextPoint = { row: number; col: number };

/** A viewport cell → Herdr's content point: row = max_offset_from_bottom - offset_from_bottom + cell.row. */
export function toTextPoint(scroll: PaneScroll, cell: Cell): TextPoint;
```

The server reads `scroll` out of `pane.get`'s `result.pane.scroll`. If it is missing or
malformed, reply `ok:false` with code `bad_reply`. Don't guess.

### Renderer (`renderer.js`)

```js
/**
 * @property {(anchor: {column: number, row: number}, cursor: {column: number, row: number}) => void} highlight
 *   Paints the inclusive range between two viewport cells (either order) as selected.
 * @property {() => void} clearHighlight
 */
```

Use xterm.js's programmatic selection (`term.select(column, row, length)`), so the highlight
uses the theme's selection colors and moves with nothing else. Check xterm 6's `select`
argument semantics against the vendored build before relying on them.

### Page behavior (`attachMouse`, plain path)

- The forwarded `mouse` down/drag/up messages are unchanged.
- **mousedown** (any button, plain): `clearHighlight()`.
- **mouseup**, left button only, when the up cell differs from the down cell:
  1. `highlight(start, end)` using the same cells already computed for `mouse`.
  2. Send `read_selection` with those cells.
  3. Write the reply's text to the clipboard. **Start the clipboard write synchronously
     inside the mouseup handler:**
     `navigator.clipboard.write([new ClipboardItem({'text/plain': textPromise.then(t => new Blob([t], {type: 'text/plain'}))})])`.
     Safari and Firefox drop the user activation across an `await` on the socket, and a
     promise-valued `ClipboardItem` keeps it. If `ClipboardItem` is missing, fall back to
     `navigator.clipboard.writeText(text)` after the reply.
  4. An empty `text` copies nothing. A failed reply or a rejected clipboard write gives one
     `toast` (`Copy failed: <message>`), never a thrown error.
  5. If no reply arrives within 5 s, drop the pending resolver (and reject).
- A click without movement (down and up on the same cell) never copies.
- A right or middle drag never copies.
- **Known limitation, not fixed:** if the pane scrolls or prints output between mouseup and the
  server's `pane.get`, the rows can be off. There is no usable `content_revision` (see
  Background). Write this under "Known limitations" in devc-web.md.

### Spec updates in `devc-web.md`

- Add the `read_selection` row to the browser → server table.
- In "Browser UI → Mouse", add a bullet: a plain left-drag also copies, via `read_selection`.
  Mention the OSC 52 finding.

## Order (live mode)

1. `selection.ts`, `protocol.ts` and `server.ts`, with tests. Run `deno check main.ts` and wait
   for the host restart. The server accepts the message before any page sends it.
2. `renderer.js`, then `app.js`, saved in quick succession.

## Verify

```bash
cd /workspaces/tools/devc-tools/devc
deno check main.ts
deno task check && deno task test
cd .. && deno fmt --check
curl -s http://host.docker.internal:48228/app.js | diff -q - devc/web/static/app.js
```

Then ask the user to:

1. Drag across shell output in a tile, then paste somewhere else: the text should match.
2. Drag across a soft-wrapped long line: it should paste as one line.
3. Scroll up in Herdr's scrollback and drag-select: the rows should be right (this checks the
   unmeasured scrolled case).
4. Click without dragging: nothing is copied.
5. Shift+drag: still copies as before.
