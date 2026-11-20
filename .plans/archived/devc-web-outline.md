# devc-web-outline

## Checklist

- [x] Vendored CodeMirror also exports `syntaxTree` and `ensureSyntaxTree` from
      `@codemirror/language` (`scripts/codemirror-entry.js`, rebuilt `codemirror.mjs` via
      `scripts/vendor-codemirror.sh`, `VERSIONS` bundle size line updated)
- [x] `devc/web/static/lib/outline.js` (new, pure): a Lezer tree and its text → outline items,
      per [Extraction](#extraction)
- [x] `devc/tests/web_outline_test.ts` (new), per [Tests](#tests)
- [x] `viewer.js`: a viewer reports its outline and its cursor line, and tells its owner when
      either may have changed
- [x] `lib/view.js`: `ViewState.outline`, the `revealLine` intent, `relayedState` carrying
      `outline`, `VIEW_INTENT_NAMES` gains `revealLine`, per [View contract](#view-contract)
- [x] `tiles.js`: computes the outline tile's outline and publishes it in `viewState()`, per
      [When the outline is computed](#when-the-outline-is-computed); implements `revealLine`
- [x] `remote.js`: relays `revealLine` like the other intents
- [x] `protocol.ts`: `revealLine` in `VIEW_INTENT_NAMES`; `view_state`'s optional `outline`
      checked; `MAX_VIEW_MESSAGE` raised to 512 KiB, per [Protocol](#protocol)
- [x] `lib/sidebar.js`: `outlineZoneHeight` for the Outline zone (the two-level split in
      [Zones](#zones); `settleZones` / `dragZones` unchanged)
- [x] `devc/web/static/outline.js` (new): draws the Outline section, per [Sidebar UI](#sidebar-ui)
- [x] `sidebar.js`: the Outline zone and its divider, fold state and size kept in the sidebar's
      saved state, wired to `onViewState` and the tiling area
- [x] `style.css`: Outline rows, indent, current-item highlight, modifier tags
- [x] Tests for the view contract, protocol checks and zone math, per [Tests](#tests)
- [x] `devc/README.md`: an **Outline** bullet in the devc web section; protocol table in
      `.plans/archived/devc-web.md` is history and is **not** edited
- [x] `deno fmt` every touched file

A VS Code–style **Outline** for TypeScript and JavaScript files: a foldable section in the devc
web sidebar, below **Projects**, listing the focused file's tests (`describe` / `it` / `test`,
`Deno.test`, `t.step`, nested as written) and top-level declarations. Clicking a row moves the
file tile to that line. The row containing the cursor is highlighted as the cursor moves.

The outline is computed **in the page** from CodeMirror's Lezer parse tree, which every file
tile already has. No server, no language server: it works on read-only tiles and in containers
without the `typescript-lsp` Feature. The language server's `documentSymbol` is not used.

**Who runs what.** Everything up to the unit tests, `deno fmt`, check and lint runs in the
devcontainer. Items marked **(human)** need devc web on the host and a browser; hand them to the
user. devc-desktop's window loads devc web's `/sidebar` page, so it needs no rebuild.

## Decisions

- **Languages:** files whose `lib/languages.js` language is `javascript`, `jsx`, `typescript` or
  `tsx` (`.js .mjs .cjs .jsx .ts .mts .cts .tsx`). Any other file tile shows
  `No outline for <basename>`. Markdown headings, pytest and JUnit are later plans.
- **One list, every file:** tests and declarations are listed together in source order. No
  test-file detection, no mode switch.
- **Which file:** the **outline tile** is the open `file` tile (draft tiles included, media tiles
  excluded) with the highest `focusSeq`. Focusing a terminal or diff tile keeps showing the last
  file's outline, as VS Code does. No file tile open → `No file open`.
- **Diff tiles:** not outlined in v1.
- **The sidebar's filter box does not filter the Outline** in v1.
- **No keyboard shortcut** is added.

## Extraction

`lib/outline.js` exports one function taking a Lezer `Tree` (from `@lezer/javascript`, any
dialect) and the document text, returning `{items: OutlineItem[], truncated: boolean}`:

```js
/**
 * @typedef {object} OutlineItem
 * @property {'suite' | 'test' | 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum'} kind
 * @property {string} name      at most MAX_OUTLINE_NAME (120) UTF-16 units; longer is cut to 119 + '…'
 * @property {number} line      1-based line of the node's start
 * @property {number} endLine   1-based line of the node's end
 * @property {number} depth     0 at top level; a child is its parent's depth + 1
 * @property {string[]} modifiers  e.g. ['skip'], ['each'], [] — in the order written
 */
```

Items are a **flat array in pre-order** (a parent comes before its children; a child's
`depth` is its parent's + 1). At most `MAX_OUTLINE_ITEMS` (1000); past that, stop and set
`truncated: true`.

### Test calls

A `CallExpression` is a **test call** when its callee, after stripping modifiers, is one of:

| Callee                                              | Kind    |
| --------------------------------------------------- | ------- |
| `describe`, `suite`, `context`                      | `suite` |
| `it`, `test`, `bench`                               | `test`  |
| `Deno.test`, `Deno.bench`                           | `test`  |
| `<ident>.step` — only inside a test call's callback | `test`  |

**Modifiers** are member names after the root: `only`, `skip`, `todo`, `each`, `concurrent`,
`sequential`, `failing`, `fails`, `ignore`, `skipIf`, `runIf`. A callee chain with any other
member (e.g. `regex.test`, `test.foo`) is not a test call. A modifier that is itself called
(`test.each(table)`, `it.skipIf(cond)`) makes the callee a `CallExpression`: the test call is the
**outer** call, and its name comes from the outer call's arguments. Example:
`describe.each([1, 2])('adds %i', fn)` → `{kind: 'suite', name: 'adds %i', modifiers: ['each']}`.

**Name** from the call's `ArgList`, first match wins:

1. first argument a `String` → its text without the quotes (escapes left as written)
2. first argument a `TemplateString` → its source between the backticks, `${…}` left as written
3. first argument an `ObjectExpression` with a `name` property whose value is a `String` → that
   string (`Deno.test({ name: 'x', fn })`)
4. first argument a `FunctionExpression` with a name → that name (`Deno.test(function foo() {})`)
5. otherwise `(anonymous)`

**Where test calls are found:** walk the whole tree, but do **not** descend into the body of a
function, arrow function, method or class **unless** that function is an argument of a test
call. So `for` loops, `if` blocks and `await t.step(...)` inside a test callback are found;
tests registered from inside a helper function are not. A test call's children are the test
calls found inside its arguments.

### Declarations

Only at the top level of the script (`Script`'s direct statements, and the declaration inside
an `ExportDeclaration`, `export default` included):

| Source                                                                                                                          | Kind        | Name                              |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------- |
| `function f()`, `async function* f()`                                                                                           | `function`  | `f`                               |
| `const f = () => …`, `let f = function () {}` (each declarator whose initializer is an `ArrowFunction` or `FunctionExpression`) | `function`  | `f`                               |
| `class C`                                                                                                                       | `class`     | `C`                               |
| a method, getter, setter or constructor in a class body                                                                         | `method`    | its name (`constructor`, `#priv`) |
| `interface I`                                                                                                                   | `interface` | `I`                               |
| `type T = …`                                                                                                                    | `type`      | `T`                               |
| `enum E`                                                                                                                        | `enum`      | `E`                               |

`export default function () {}` with no name → `default` (`@lezer/javascript` 1.5.6 does not
parse `export default class {}`, so that form is not tested). Other
variables, namespaces, `declare` blocks and class fields are not listed.

**Gotcha — node names.** The names above (`CallExpression`, `ArgList`, `MemberExpression`,
`VariableName`, `PropertyName`, `String`, `TemplateString`, `ObjectExpression`, `Property`,
`ArrowFunction`, `FunctionExpression`, `FunctionDeclaration`, `ClassDeclaration`, `ClassBody`,
`MethodDeclaration`, `InterfaceDeclaration`, `TypeAliasDeclaration`, `EnumDeclaration`,
`VariableDeclaration`, `VariableDefinition`, `TypeDefinition`, `ExportDeclaration`) are
`@lezer/javascript` 1.5.6's as best known. Before writing the walker, print the tree of each
test fixture (`tree.toString()`) and use the names it shows.

**Gotcha — the tree may be partial.** CodeMirror parses lazily, up to the viewport. The viewer
must call `ensureSyntaxTree(state, state.doc.length, 200)`. When it returns `null`, use
`syntaxTree(state)` (what is parsed so far) and mark the outline `partial: true`; `tiles.js`
recomputes once more 1000 ms later and keeps doing so while it stays partial.

## View contract

`ViewState` (`lib/view.js`) gains an optional top-level field:

```js
/**
 * @typedef {object} OutlineState
 * @property {string} tile          the outline tile's id
 * @property {string} title         its tab title
 * @property {boolean} supported    false: not a JS/TS file (items empty)
 * @property {OutlineItem[]} items
 * @property {boolean} truncated    more than MAX_OUTLINE_ITEMS
 * @property {boolean} partial      the file was not fully parsed yet
 * @property {number | null} current  index into items of the deepest item with
 *   line <= cursor line <= endLine; null when none
 */
// ViewState.outline?: OutlineState | null   (null or left out: no file tile open)
```

`ViewIntents` gains `revealLine(id: string, line: number)`: brings tile `id` forward, focuses its
editor and puts the cursor at the start of the 1-based `line`, scrolled to the middle
(`Viewer.revealLine`). An unknown id, or a tile that is not a loaded file tile, is ignored.

`relayedState` copies `outline` when it is an object with an `items` array, and otherwise leaves
it out (as it does `inUse`), so an absent `outline` reads as none.

## When the outline is computed

In `tiles.js`, for the outline tile only:

- when the outline tile changes (another file tile focused, the tile closed), or its file loads
  or reloads
- on document changes, debounced **300 ms**
- on cursor moves, debounced **100 ms**: only `current` is recomputed from the existing items

A recompute calls `viewChanged()` only when the result differs from the last published one
(compare `items` structurally, and `current`), so typing inside a test body sends no
`view_state` until the outline itself changes.

## Protocol

- `VIEW_INTENT_NAMES` (`protocol.ts` and `lib/view.js`) gains `'revealLine'`.
- `view_state` with `tiles`: `state.outline`, when present, must be `null` or an object whose
  `items` is an array of at most `MAX_OUTLINE_ITEMS` (1000). Otherwise
  `'state.outline' must be null or an object with at most 1000 items`. Items are not checked
  one by one (as tiles are not).
- `MAX_VIEW_MESSAGE` goes from `256 * 1024` to `512 * 1024`: 1000 items of 120-character names
  are about 205 KB of JSON.
- Export `MAX_OUTLINE_ITEMS` and `MAX_OUTLINE_NAME` from `lib/outline.js`; `protocol.ts` keeps
  its own `MAX_OUTLINE_ITEMS` (it cannot import browser code), and a test asserts they match.

## Zones

The sidebar's zones become, top to bottom: **Tasks | In use | Projects | Outline**, each scrolling
on its own, with a draggable divider between each two.

- Projects' zone hidden (scoped sidebar, or `containers=external` in devc-desktop): Outline sits
  directly under In use, with one divider.
- Outline folded: its zone is exactly its heading and the divider above it is inert, as Projects'
  is today.
- Outline open: a fixed height whatever its rows, so switching files never moves the divider:
  `outlineZoneHeight(avail, size)` = `size × avail` (`size` 0.3 when never dragged), held between
  `2 × ZONE_MIN_HEIGHT` (a heading and a row) and `avail − 3 × ZONE_MIN_HEIGHT` (a heading for
  each zone above). `avail` is the tree's height less every divider.
- Its size is kept as a fraction, `outlineSize`, and its fold as `outlineOpen` (default `true`),
  in the sidebar's saved state beside `tasksSize` / `inUseSize` / `containersOpen`. Old saved
  state without them gets the defaults.
- Double-click on any divider resets every zone, Outline included.
- The Outline zone is shown in every scope (`all`, scoped, `agents`).

**Two-level split:** the Outline's height is set first, and Tasks, In use and Projects share the
rest with the existing `settleZones` / `dragZones` (unchanged). So when the window shrinks, the
three zones above give first and the Outline last. Projects' zone, when open, keeps at least its
heading (`min-height: 32px`) under the default (never dragged) sizing.

## Sidebar UI

`static/outline.js` draws the section from `ViewState.outline`; `sidebar.js` mounts it in its
zone and hands it each `onViewState` state.

```
OUTLINE   web_outline_test.ts         ⊟
  ▾ ◆ describe outline
      ● finds describe and it
      ● skips helpers                skip
    ▸ ◆ adds %i                      each
  ƒ makeTree
  C OutlineCache
      m constructor
```

- **Heading:** `sectionRow('Outline', …)`, foldable. After the title, the outline tile's title,
  muted. Hover action: **Collapse all** (`iconButton('collapseAll', …)`), which folds every item
  with children.
- **Rows:** indented by `depth`; a chevron on items with children (titled **Fold** / **Unfold**:
  inside a titled row only titled elements take the pointer, `style.css` `.row[title] *`) (unfolded by default; fold
  state kept in memory per tile id + the item's ancestor names path, not saved); a kind marker
  that tells `suite`, `test`, `function`, `class`, `method`, `interface`, `type`, `enum` apart
  (`svgIcon` glyphs or letter badges, at the implementer's choice, using the theme's colours);
  the name; modifiers as small muted tags at the right.
- **Click** a row → `tileArea.revealLine(outline.tile, item.line)`.
- **Right-click** a row → menu **Copy name** (copies `item.name`, toast `Copied name`).
- **Current item:** the row at `current` has the `data-current` attribute (styled as the focused
  tile's rows are); when `current` changes and
  that row is outside the zone's visible area, scroll it into view (`block: 'nearest'`). Folded
  ancestors are not unfolded for it.
- **Empty states** (muted, one row): `No file open`; `No outline for <title>` (`supported` false);
  `Nothing to outline` (no items); `Loading…` while the file loads (`partial`, no items).
  `truncated` adds a last muted row `First 1000 items shown`. `partial` with items shows nothing
  extra.

## Tests

`devc/tests/web_outline_test.ts` parses fixtures with
`npm:@lezer/javascript@1.5.6` (`parser.configure({ dialect: 'ts' })`, and `'jsx'`/`'ts jsx'` for
the JSX case) and asserts the full `items` array of each:

1. Vitest/Jest: nested `describe` / `it` / `test`, `it.skip`, `test.only`, `it.todo('x')` (no
   callback), `describe.each([...])('n %i', fn)`, `test.concurrent.each(t)('x', fn)`,
   template-literal name
2. `node:test`: `describe` / `it` with `{ skip: true }` options object as 2nd arg (no modifier)
3. Deno: `Deno.test('a', fn)`, `Deno.test({ name: 'b', fn })`, `Deno.test(function c() {})`,
   `Deno.test('d', { permissions: {} }, fn)`, `Deno.test.ignore('e', fn)`, and
   `await t.step('f', async (t) => { await t.step('g', …) })` nested to depth 2
4. Not tests: `regex.test(s)`, `test.foo('x')`, an `it('x')` inside a top-level helper
   function body, `t.step('x')` at top level
5. Loops and blocks: a template-literal `it` in a `for` loop, and a `test` in an `if` block,
   inside a `describe`
6. Declarations: every row of the [Declarations](#declarations) table, exported and not,
   `export default function () {}`, plus a nested function inside a function (not listed) and a
   plain `const x = 1` (not listed)
7. `.tsx`: a component `export function App() { return <div/>; }` and `const B = () => <b/>`
8. Name cut: a 200-character test name → 119 characters + `…`
9. Cap: 1100 `it` calls → 1000 items, `truncated: true`
10. Line numbers: `line` / `endLine` of a multi-line `describe`
11. `current`: the helper that picks the deepest containing item (export it from
    `lib/outline.js`), for a cursor in a nested test, between tests, and before the first item
12. `MAX_OUTLINE_ITEMS` in `lib/outline.js` equals the one in `protocol.ts`

Also:

- `web_view_test.ts`: `relayedState` keeps a well-formed `outline` and leaves out a malformed
  one; `VIEW_INTENT_NAMES` includes `revealLine`, which `relayedIntent` passes
- `web_server_test.ts` (where `view_state` parsing is tested): `outline: null`, a valid outline,
  a full 1000-item outline of 120-character names (fits a frame), a 1001-item outline and
  non-object outlines (rejected); the oversized-frame tests use 600 KiB, past the new limit
- `web_sidebar_test.ts`: `outlineZoneHeight`: the default share, dragged to either end, and a
  window too short

## Validation

- [x] `cd devc && deno test --allow-run --allow-read --allow-write --allow-env tests/web_outline_test.ts tests/web_view_test.ts tests/web_server_test.ts tests/web_sidebar_test.ts tests/web_viewer_test.ts`
      passes (all `tests/web_*.ts`: 891 passed)
- [x] `cd devc && deno task test` passes (all tests): 1176 passed, 1 failed —
      `docker_exec_single_path_test` flags `devc-core/dist/container.d.ts`, a git-ignored local
      build output from 2026-11-02, not part of this change
- [x] `cd devc && deno task check && deno lint && deno fmt --check` pass: check and fmt pass;
      `deno lint` reports the same 302 problems as before the change (deno 2.9.8's
      `no-import-prefix` / `no-unversioned-import` and older ones), none in touched files
- [x] `grep -c "ensureSyntaxTree" devc/web/static/vendor/codemirror/codemirror.mjs` is ≥ 1 and
      the bundle's `export {` list names `ensureSyntaxTree` and `syntaxTree`
- [x] Headless Chromium (as earlier devc web UI checks were done): the real `style.css` with
      hand-built Outline markup, dark and light: indentation, current-row highlight, tags
      right-aligned, long names ellipsized, no horizontal scroll at a 240 px sidebar. Done with
      the real `viewer.js` + `outline.js` on a sample test file: rows nested, a click moved the
      cursor to the row's line and marked it current, an inserted test added a row, a chevron
      folded its suite
- [ ] **(human)** devc web `/`: open a `.test.ts` file → Outline lists its suites and tests
      nested; clicking a test moves the cursor there and centres it; moving the cursor
      highlights the enclosing test; typing a new `it('x', () => {})` adds a row within a second
- [ ] **(human)** focus a terminal tile → Outline keeps the last file's; open a `.md` file →
      `No outline for <name>`; close all file tiles → `No file open`
- [ ] **(human)** fold Outline, drag the divider above it, reload → fold and size kept;
      double-click a divider → default sizes
- [ ] **(human)** VS Code embedding (`/main` + `/sidebar`) and devc-desktop: the Outline shows
      and clicking a row jumps in the other page's tile

## Relevant Files

- `scripts/codemirror-entry.js`
- `devc/web/static/vendor/codemirror/codemirror.mjs` (regenerated by
  `scripts/vendor-codemirror.sh`)
- `devc/web/static/vendor/codemirror/VERSIONS`
- `devc/web/static/lib/outline.js` (new)
- `devc/web/static/outline.js` (new)
- `devc/web/static/viewer.js`
- `devc/web/static/tiles.js`
- `devc/web/static/lib/view.js`
- `devc/web/static/remote.js`
- `devc/web/static/sidebar.js`
- `devc/web/static/lib/sidebar.js`
- `devc/web/static/ui.js` (only if new icons are added)
- `devc/web/static/style.css`
- `devc/web/protocol.ts`
- `devc/tests/web_outline_test.ts` (new)
- `devc/tests/web_view_test.ts`
- `devc/tests/web_server_test.ts`
- `devc/tests/web_sidebar_test.ts`
- `devc/deno.lock` (the test's `npm:@lezer/javascript` import)
- `devc/README.md`

## Outcome (2026-11-20)

Implemented; every agent-runnable check above passed. The four **(human)** checks were not run:
the devcontainer has no Docker and no project to open a file tile from, so the wiring between
`tiles.js` and `sidebar.js` (and its relay through `/main` + `/sidebar`) is checked by unit tests
and the harness only, not in a live devc web. Mac apps not rebuilt (devc-desktop loads devc web's
`/sidebar`, served by devc web).

### Follow-up: below Projects in devc-desktop (2026-11-20)

In devc-desktop, Projects is the app's Containers pane, below `/sidebar`, so an Outline drawn by
`/sidebar` sat above it. Now the Outline is drawn wherever Projects is: `/sidebar` with
`containers=external` draws none, and the pane (`devc-desktop/src/renderer/containers.ts`) adds
it below its section, under its own divider. The zone (divider, sizing, drag, fold) moved into
`outline.js` as `mountOutlineZone`, shared by `sidebar.js` and the pane. In the pane, the app is
told the pane is folded only when both sections are, down to the Outline's heading; with
Projects folded the Outline fills the pane (`setFill`). The pane already receives the view state
(outline included) as a `containers` member, and the server accepts its `revealLine`. Checked in
headless Chromium with a pane-like layout (default 30 %, drag, fill, fold, double-click reset),
devc web tests (891) and devc-desktop tests (78) and `tsc` pass, Mac apps built; not checked in
the app.

### Follow-up: diff tiles (2026-11-20)

The outline tile may now be a diff tile too (the file or diff tile focused last). Its Outline is
of the new side: an added file's patch when it is whole (`rest` null), else the text `readHead`
reads (`pr_file_at`, `commit_file_at`, `uncommitted_file_at`), read when the tile becomes the
outline tile and made again on each `renderDiff`; a removed file has none (`Nothing to outline`),
and the Outline is `partial` (`Loading…`) while the text is on its way. `viewer.js`'s
`outlineText(name, text)` parses with the highlighter's parsers, no editor. The current item is
the one at the middle of the diff's view (of its rows, when they end above the foot), followed on
scroll, or an Outline click's line until a scroll by hand. `revealLine` takes an optional
`endLine`: in a diff tile it goes to the new-side row for `line`, else the first drawn row up to
`endLine` (an item whose body changed), scrolled to the middle and flashed
(`.diff-row.outline-flash`); with none, a toast `Line N isn't in this diff` with **Open file**
(`openFileAt`). Checked end to end against a real `devc web` in the devcontainer (no Docker: a
host project with a git repo, `/main` + `/sidebar` driven in headless Chromium): a file tile's
Outline, a commit diff's (changed test's row flashed, current followed the click, unchanged
function's toast), an added file's. Diff tiles of PRs and working-tree changes not checked live.
