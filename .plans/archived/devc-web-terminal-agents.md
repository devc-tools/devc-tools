# devc-web-terminal-agents

- [x] Vendor the four agent marks from Lobe Icons (`static/vendor/agent-icons/`), with `VERSIONS` and `LICENSE`
- [x] Server: `open_tab` takes an optional `agent`: checks the command is installed, creates a tab, runs it there; with tests
- [x] Protocol: `agent` in `protocol.ts` and its tests; `.plans/devc-web.md` protocol table
- [x] Page: the Terminals row's **+** opens a menu: Terminal, Claude, Copilot, Pi, OpenCode, each with its icon
- [x] Page: an icon in front of every terminal row: the agent's mark, or a terminal glyph for a shell
- [x] Page: Layout section tile rows get the same leading icon (terminal tiles), or a file glyph (file tiles)
- [x] Verify (below) and ask the user to try it in their open tab

Start a terminal or a specific coding agent from a container's Terminals row, and see at a glance
which terminal runs which agent. Today the Terminals row's **+** opens a plain shell
(`open_tab`, `reuse: false`, at the project folder), and a terminal row says which agent it runs
only through its badge's tooltip.

Read `/workspaces/devc-dev/.claude/skills/devc-web/SKILL.md` first. Builds on
[devc-web-open-tab-here](devc-web-open-tab-here.md) and
[devc-web-terminals-group](devc-web-terminals-group.md). The server half is a protocol
change, so it needs `devc web --live-yolo` (or an updated `devc`). Save the server side first.

```
▾ devc-dev
  ▾ Terminals                [+]  →  ┌──────────────┐
      ▣ shell                        │ ▣  Terminal  │
      ✳ Roadmap   ● done             │ ✳  Claude    │
      ◉ review    ○ idle             │ ◉  Copilot   │
  ▸ Repos   ↑3                       │ π  Pi        │
                                     │ ▢  OpenCode  │
                                     └──────────────┘
```

**Not in this plan:** agent choices on folder rows ("New terminal here" stays a shell). Icons on
tile tabs (the Golden Layout headers). Agents beyond these four (Herdr detects many more, see
`KIND_TABLE` in `devc/herdr.ts`). Per-agent arguments or flags.

## Deviations (implementation)

- **Icons are inlined, not loaded.** The server serves only `.html`/`.js`/`.mjs`/`.css`/`.png`,
  so a CSS `mask-image` on the vendored `.svg` would 404 under the installed server. The path
  data is copied into `static/lib/agent_icons.js` (`AGENT_MARKS`), and
  `tests/web_agents_test.ts` checks it matches the vendored files byte for byte. The SVGs stay
  vendored as the source of truth.
- **`commandInstalled` lives in `herdr_bridge.ts`** beside the other `docker exec` helpers, so
  `web/agents.ts` stays pure (`protocol.ts` imports it). The "refuses an uninstalled command
  without `createShell`" case is covered by `commandInstalled`'s tests and the handler's order,
  not end to end (the handler is inside the server closure).
- **The + menu is anchored to the Terminals row's right end,** not the button: hover buttons
  can be zero-sized when the click lands.

## Icons

From [Lobe Icons](https://github.com/lobehub/lobe-icons) (MIT), npm package
`@lobehub/icons-static-svg`, pinned at **1.95.1**. These are the products' own marks:

| Agent    | Herdr `agent` | Lobe file           | Mark                       |
| -------- | ------------- | ------------------- | -------------------------- |
| Claude   | `claude`      | `claudecode.svg`    | Claude Code's pixel mascot |
| Copilot  | `copilot`     | `githubcopilot.svg` | GitHub Copilot's goggles   |
| Pi       | `pi`          | `pi.svg`            | pi's pixel π               |
| OpenCode | `opencode`    | `opencode.svg`      | OpenCode's block "O"       |

- **Use the monochrome files** (not `-color`). They are `viewBox="0 0 24 24"` with
  `fill="currentColor"`, so they take the row's text color, muted or not, in both themes, like
  the rest of the sidebar. Note: `copilot.svg` is Microsoft Copilot and `inflection.svg` is a
  different "Pi". Don't use those.
- `static/vendor/agent-icons/`: the four SVGs unmodified, `LICENSE` (Lobe Icons' MIT text), and
  `VERSIONS` naming the package, version and the unpkg URLs they came from. The logos
  themselves are their owners' trademarks; say so in `VERSIONS`.
- **How the page draws them** is the implementer's choice, as long as: the icon inherits
  `currentColor`; it works under the page's CSP (no inline `<script>`; check `img-src` /
  `style-src` if using CSS `mask-image` with a `url()`); and the glyph is 14px, in the slot
  the chevron spacer takes today, so names still line up.
- **The terminal glyph** (shell, and the "Terminal" menu item) is drawn in-house in
  `ICON_PATHS` style (`app.js`), not vendored: a small rectangle with a `>_` prompt. So is the
  **file glyph** (Layout rows of file tiles): a page outline with a folded corner.

## Concept boundaries

- **Agent id = Herdr's `agent`.** The snapshot's `pane.agent` is Herdr's manifest id (`claude`,
  `copilot`, `pi`, `opencode`, …), detected by Herdr itself. The menu's `agent` values and the
  icon lookup use the same ids. A pane whose `agent` is another id (`codex`, `gemini`, …) gets a
  generic agent glyph (in-house, `ICON_PATHS` style). A pane with no `agent` gets the terminal
  glyph.
- **The command comes from the server, never the page.** The page sends an agent **id**. The
  server maps it to a command through a fixed table, and refuses ids it doesn't know. Nothing
  the page sends is ever typed into a shell.
- **Agent terminal vs `devc claude`.** `devc claude` starts the container and attaches a local
  terminal. This runs the same bare command (`claude`, `copilot`, `pi`, `opencode`) in a new
  Herdr tab, without `exec`, so quitting the agent leaves the shell. No extra flags, the same as
  `devc claude` without arguments.
- **`open_tab` with an agent never reuses.** "Open terminal here" (`reuse: true`) matches shells
  only. Starting an agent always creates a tab.

## Existing touchpoints

| File                                            | Role                                                                                                                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devc/web/server.ts`                            | `openTab`: the `open_tab` handler (repo check, `confine`, Herdr state, `createShell`).                                                                                        |
| `devc/web/herdr_bridge.ts`                      | `createShell`, `bridgeRequest` (`pane.send_text`), `runText`.                                                                                                                 |
| `devc/web/protocol.ts`                          | `open_tab` parsing.                                                                                                                                                           |
| `devc/web/static/app.js`                        | `terminalRows` (the + button), `openHerdrTab`, `openMenu` (items gain an optional icon), `paneRow` (the chevron spacer becomes the icon), `ICON_PATHS` / `svgIcon`, `LABELS`. |
| `devc/web/static/style.css`                     | `.agent-icon` and the menu's icon column.                                                                                                                                     |
| `devc/web/static/index.html`                    | The CSP, if the drawing approach needs it adjusted.                                                                                                                           |
| `devc/herdr.ts`                                 | `KIND_TABLE`: reference for Herdr's agent ids. Not changed.                                                                                                                   |
| `devc/tests/web_server_test.ts`, protocol tests | Tests to extend.                                                                                                                                                              |
| `.plans/devc-web.md`                            | Protocol table; "Browser UI" sidebar bullet.                                                                                                                                  |

## Contracts

### Agents table (server, pure, tested)

```ts
// devc/web/agents.ts
export type AgentId = 'claude' | 'copilot' | 'pi' | 'opencode';
/** Agent id → the command typed into the new tab's shell. */
export const AGENT_COMMANDS: Readonly<Record<AgentId, string>>;
export function isAgentId(v: unknown): v is AgentId;
```

### Browser → server

`open_tab` gains one optional field:

| Message    | Fields                                                        | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open_tab` | `id`, `container`, `root`, `path`, `reuse`, `agent?: AgentId` | With `agent`: `reuse` must be `false`, else `bad_request`. An unknown `agent` is `bad_request` (in `protocol.ts`). After the existing checks and the Herdr start (unchanged), check the command is installed: `docker exec -u <user> <id> bash -lc 'command -v "$1"' _ <command>` (a login shell, the PATH `devc claude` gets). Not found → `not_installed`, message `<command> isn't installed in this container`, and no tab is created. Then `createShell(target, {cwd})`, then `pane.send_text {pane_id, text: "<command>\n"}`. Reply `{pane_id, tab_id, reused: false}`. |

Tests: `isAgentId`; the parser rejecting an unknown `agent` and `agent` with `reuse: true`;
the server refusing an uninstalled command without calling `createShell` (stub `runText`).

### Page

- **+ menu.** The Terminals row's **+** opens a menu under the button (not at the pointer), with
  `Terminal`, `Claude`, `Copilot`, `Pi`, `OpenCode`, each with its icon. Terminal sends
  `open_tab` as now. An agent sends `open_tab` with `reuse: false` and `agent`. Placement,
  "Starting Herdr…" and error toasts are as for Terminal (`openHerdrTab`).
  - `openMenu` items gain an optional icon (for example a fourth element, or an object form).
    Existing callers don't change.
  - Labels go in `LABELS` (e.g. `LABELS.agents: {claude: 'Claude', …}`, `LABELS.plainTerminal:
    'Terminal'`).
- **Terminal row icon.** Every terminal row shows, in the chevron spacer's slot: the agent's
  mark for the four ids, the generic agent glyph for other ids, the terminal glyph without an
  `agent`. The shown-in-a-tile mark stays after it. The badge (status) is unchanged.
  - Herdr reports `agent` once it has detected the agent, a moment after it starts. The icon may
    show the terminal glyph first, then switch. That's acceptable.
- **Layout section icons.** Every Layout row has a leading icon, so the section reads like the
  Projects one:
  - **stack / row / column rows** keep their existing `.node-icon` (unchanged);
  - **terminal tile rows** (`layoutTileRow`) get the same icon as that terminal's row in
    Projects, from the same lookup (one function picks the icon for a pane; both call it). A
    tile whose pane is gone or not yet listed gets the terminal glyph;
  - **file tile rows** (`layoutFileTileRow`) get the file glyph;
  - **an empty tile** (no ref) gets the terminal glyph, dimmed like its label.
  - Same size and slot rules as the Projects rows, so labels line up with the `.node-icon` rows
    above them. The icon updates when Herdr reports the pane's agent (the Layout section already
    re-renders when tiles' panes change; check that an `agent` change also triggers it).

## Verify

```bash
cd /workspaces/tools/devc-tools/devc
deno check main.ts && deno task check && deno task test
cd .. && deno fmt --check
```

In a headless page with a fake WebSocket (see the devc-web skill): snapshot panes with `agent`
`claude`, `copilot`, `pi`, `opencode`, `codex` and none. Screenshot the sidebar: each row's
icon in the chevron slot, names aligned, and the icons readable in the dark theme and on a
muted row. Open a tile for the Claude pane, one for the shell and one file tile: the Layout
section shows the Claude mark, the terminal glyph and the file glyph, aligned with the
stack/row icons. Open the + menu: five items with icons, under the button. Choosing Claude sends
`open_tab` with `agent: 'claude'`, `reuse: false`.

Then ask the user, under `--live-yolo`:

1. Hover a Terminals row and click +: a menu with Terminal and the four agents, with their logos.
2. Choose Claude: a new tile opens with Claude running in the project folder. Quit it: the
   shell stays.
3. Choose an agent that isn't installed in that container: a toast says so, and no tab opens.
4. Terminal rows show the right logo per agent, and a terminal glyph for plain shells.
5. The Layout section's tile rows show the same icons, and file tiles a file icon.
