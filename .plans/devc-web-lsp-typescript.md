# devc-web-lsp-typescript

## Checklist

- [ ] `features/typescript-lsp/devcontainer-feature.json`, per [Manifest](#manifest)
- [ ] `features/typescript-lsp/install.sh`, per [install.sh](#installsh)
- [ ] `features/typescript-lsp/devc-lsp-typescript`, the launcher, per [Launcher](#launcher)
- [ ] `features/typescript-lsp/README.md`, per [README](#readme)
- [ ] Offline harness `features/typescript-lsp/test/launcher_test.sh`, per [Tests](#tests)
- [ ] Docker scenarios: `test/test.sh`, `test/scenarios.json` plus one script per scenario,
      `test/run-features-test.sh` (copied unchanged from `features/xvfb/test/`)
- [ ] `features/README.md`: a row for `typescript-lsp`
- [ ] `features/CONTRIBUTING.md`: per-Feature test inventory entry and a `### typescript-lsp` note
- [ ] Run all of [Validation](#validation), Docker scenarios included
- [ ] Add `typescript-lsp` to `features/PUBLISH_ALLOWLIST.txt`, **only after** the Docker
      scenarios pass
- [ ] `deno fmt` every touched `.md` and `.json` file

**Depends on [devc-web-lsp-core](devc-web-lsp-core.md)** being complete: this plan ships a
launcher that satisfies its [launcher contract](devc-web-lsp-core.md#launcher-contract). devc
web itself does not change here.

A new Feature, `typescript-lsp`, gives devc web TypeScript and JavaScript intelligence. It
picks the server from the repo, in this order:

1. **`deno lsp`** when the file is under a `deno.json` / `deno.jsonc`
2. **The workspace's own TypeScript 7+** (`tsc --lsp --stdio`) when the project depends on it
3. **vtsls** on the workspace's TypeScript otherwise, or on vtsls's bundled TypeScript 5.9.3 when
   the project has none

Measurements behind each choice are in
[design/devc-web-language-services.md § TypeScript](design/devc-web-language-services.md#typescript).

## Concept boundaries

- **Run the TypeScript the project depends on.** TS 7 rejects tsconfig settings that 5.x
  accepts (`baseUrl`, `moduleResolution: node10`, non-relative `paths`), and its server checked
  web-client-ui under rules its own build does not use. So TS 7 is used only when the
  workspace's `typescript` is ≥ 7, never as a faster substitute.
- **Self-contained runtime.** The Feature brings a private, pinned Node for vtsls, the launcher
  and TS 7's `bin/tsc` shim (a Node script). It never uses or changes the image's Node. `deno`
  is the exception: the project's own `deno` on the login `PATH` is used, since `deno lsp` must
  match the project's Deno.
- **Nothing installed into the workspace.** The launcher reads `node_modules`, it never writes
  it. A project without `node_modules` gets vtsls with its bundled TypeScript. No
  `npm install` is ever run.
- **No lint server** (ESLint): a later plan.

## Contracts

### Manifest

```json
{
  "id": "typescript-lsp",
  "version": "0.1.0",
  "name": "TypeScript language server for devc web",
  "description": "Installs devc-lsp-typescript, the launcher devc web uses for TypeScript and JavaScript intelligence: deno lsp under a deno.json, the workspace's own TypeScript 7+ language server, or vtsls on the workspace's TypeScript (bundled TypeScript 5.9.3 when there is none). Brings its own Node; changes nothing in the image's Node or the workspace.",
  "documentationURL": "https://github.com/devc-tools/devc-tools/tree/main/features/typescript-lsp",
  "licenseURL": "https://github.com/devc-tools/devc-tools/blob/main/LICENSE",
  "options": {
    "settings": {
      "type": "string",
      "default": "{}",
      "description": "A JSON object deep-merged into the settings devc web gives the language server (workspace/configuration), e.g. {\"typescript\":{\"tsserver\":{\"maxTsServerMemory\":8192}}}. Applies to vtsls and TypeScript 7; deno lsp gets it under its own keys."
    }
  }
}
```

### install.sh

Runs as root at build time. `set -e`, `LC_ALL=C`, and a `die()` with the prefix
`typescript-lsp:`, in the style of `features/xvfb/install.sh`.

1. **Validate.** `SETTINGS` (the option, `${SETTINGS:-{}}`) must parse as a JSON **object**.
   Check it with the private Node after step 3, and before anything is installed under
   `/usr/local/bin`.
2. **Fetch tools.** `curl`, `ca-certificates`, `tar` and `gzip` must be present. If `curl` is
   missing and `apt-get` exists, `apt-get update && apt-get install -y --no-install-recommends
   curl ca-certificates`. Otherwise `die "curl is required"`.
3. **Private Node v24.22.1.**
   - Map `uname -m`: `x86_64` → `x64`, `aarch64` or `arm64` → `arm64`; anything else is
     `die "unsupported architecture: …"`.
   - Download `https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-<arch>.tar.gz` and its
     `SHASUMS256.txt`, verify with `sha256sum -c` on the matching line only, and extract to
     `/usr/local/share/devc-features/typescript-lsp/node` (`--strip-components=1`).
   - Pin it in `install.sh` as `NODE_VERSION='24.22.1'`.
4. **vtsls 0.3.0.**
   `PATH=<node>/bin:$PATH npm install --prefix /usr/local/share/devc-features/typescript-lsp/vtsls
   --no-audit --no-fund --omit=dev @vtsls/language-server@0.3.0`. Its entry point is
   `<prefix>/node_modules/@vtsls/language-server/bin/vtsls.js`, and its bundled TypeScript is
   `<prefix>/node_modules/typescript` (5.9.3, a dependency of `@vtsls/language-service`).
5. **Launcher.** Install `devc-lsp-typescript` to `/usr/local/bin/devc-lsp-typescript`, mode
   `0755`, with `SETTINGS` baked in. Use the `bake()` pattern copied from `features/xvfb`: the
   JSON is base64-encoded into a `const BAKED_SETTINGS = '<base64>'` line, so no quoting
   reaches the script.
6. Everything is world-readable (`chmod -R a+rX`), because the launcher runs as the remote user.

### Launcher

`devc-lsp-typescript` is an ES module run by the private Node. Its shebang is
`#!/usr/local/share/devc-features/typescript-lsp/node/bin/node`. Offline tests run it with any
Node ≥ 18 on `PATH`. It uses only Node built-ins.

**`describe <file>`** (absolute path):

1. **Language id** by extension (lower-cased):

   | Extensions       | `languageId`                                  |
   | ---------------- | --------------------------------------------- |
   | `ts` `mts` `cts` | `typescript`                                  |
   | `tsx`            | `typescriptreact`                             |
   | `js` `mjs` `cjs` | `javascript`                                  |
   | `jsx`            | `javascriptreact`                             |
   | anything else    | exit 3, `not a TypeScript or JavaScript file` |

2. **Top.** `git -C <dir of file> rev-parse --show-toplevel`. If that fails (not a repo, or
   unsafe ownership), top is `/`.
3. **Walk.** From the file's directory up to and including top, collect directories holding
   `deno.json` or `deno.jsonc` (Deno markers), and ones holding `package.json`, `tsconfig.json`
   or `jsconfig.json` (Node markers).
4. **Deno.** If any Deno marker exists, root is the **topmost** Deno-marker directory.
   - `deno --version` (first line, second word) is the version. If `deno` is not on `PATH`,
     exit 3 with `deno.json found but deno is not on PATH`.
   - server `deno <version>`
   - `initializationOptions` `{"enable": true, "lint": true}`
   - `settings` `{"deno": {"enable": true, "lint": true}}`, deep-merged with the option settings
5. **Otherwise.** Root is the **topmost** Node-marker directory. With none, it is top, or the
   file's directory when top is `/`. Then find the workspace TypeScript: the first
   `node_modules/typescript/package.json` walking from root up to top.
   - **Version ≥ 7:**
     - server `TypeScript <version> (workspace)`
     - `initializationOptions` `{}`
     - `settings` = the option settings
   - **Version < 7:**
     - server `vtsls 0.3.0 (TypeScript <version>)`
     - `settings` `{"typescript": {"tsdk": "<that typescript dir>/lib"}, "vtsls": {"autoUseWorkspaceTsdk": true}}`,
       deep-merged with the option settings
   - **None:**
     - server `vtsls 0.3.0 (bundled TypeScript 5.9.3)`
     - `settings` = the option settings
6. Print `{"protocol": 1, root, languageId, server, initializationOptions, settings}` as one line.

**`serve --root <root>`** re-derives the server from `root` with the same rules, applied as if
the file were `<root>/x.ts`, then spawns it with `stdio: 'inherit'`. It forwards `SIGTERM` and
`SIGINT` and exits with the child's code. It never writes to stdout itself.

| Server | Command                                                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Deno   | `deno lsp`                                                                                                                                |
| TS 7   | `<node> <tsdir>/bin/tsc --lsp --stdio`. **Gotcha:** `bin/tsc` is a Node shim that starts the native binary, so it needs the private Node. |
| vtsls  | `<node> <vtsls entry> --stdio`                                                                                                            |

**Deep merge** means objects merge recursively, and anything else is replaced by the later
value.

### README

- What it gives you from a bare `{}`.
- The server-selection table and why TS 7 is only used when the workspace depends on it.
- That `node_modules` must already be installed for the workspace TypeScript to be used, and a
  Deno project's dependency cache must be warm (`deno install`), otherwise imports show as
  unresolved.
- The `settings` option, with one example.
- Disk use: Node about 100 MB plus vtsls about 40 MB.

## Gotchas

- **vtsls answers `(loading...)` hovers** until the project loads (about 10 s on
  web-client-ui). Expected.
- **`deno lsp` needs `"enable": true`** in `initializationOptions`, or it serves nothing.
- **TS 7 and Deno use pull diagnostics.** The core converts them; nothing to do here, but the
  validation covers both.
- **Topmost marker, not nearest.** web-client-ui has a `tsconfig.json` in each of its 37
  packages. One server for the repo (its root `package.json`) is what tsserver expects, rather
  than 37 sessions.

## Tests

`test/launcher_test.sh` (offline, needs `node` and `git` on `PATH`). It builds fixtures in a
`mktemp -d` and runs `node features/typescript-lsp/devc-lsp-typescript describe …`, comparing
fields with `node -e`. Fixtures:

| Fixture                                                                                                                                                  | Expect                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| git repo with root `package.json`, `packages/a/tsconfig.json`, `node_modules/typescript/package.json` `{"version":"5.6.3"}`; file `packages/a/src/x.tsx` | root = repo; `typescriptreact`; server `vtsls 0.3.0 (TypeScript 5.6.3)`; `settings.typescript.tsdk` = `<repo>/node_modules/typescript/lib` |
| same, with typescript `7.0.2`                                                                                                                            | server `TypeScript 7.0.2 (workspace)`; no `tsdk`                                                                                           |
| git repo, `package.json`, no `node_modules`; file `a.js`                                                                                                 | `javascript`; `vtsls 0.3.0 (bundled TypeScript 5.9.3)`                                                                                     |
| git repo, `deno.json` at top and in `pkg/`; file `pkg/x.ts`; a fake `deno` on `PATH` printing `deno 2.9.8 (…)`                                           | root = repo (topmost); server `deno 2.9.8`; `initializationOptions.enable` true                                                            |
| same, without `deno` on `PATH`                                                                                                                           | exit 3                                                                                                                                     |
| a `.py` file                                                                                                                                             | exit 3                                                                                                                                     |
| `BAKED_SETTINGS` replaced with `{"typescript":{"tsserver":{"maxTsServerMemory":1}}}` in a copy                                                           | merged next to `tsdk`                                                                                                                      |
| a directory that is not a git repo with `tsconfig.json`                                                                                                  | root = that directory                                                                                                                      |

Docker scenarios (`test/scenarios.json`, image `mcr.microsoft.com/devcontainers/base:ubuntu`):

- **`test.sh`** (default `{}`):
  - `devc-lsp-typescript describe` on a generated TS project returns `protocol` 1.
  - `serve --root` answers an `initialize` frame piped on stdin with a result whose
    `serverInfo.name` is `vtsls`, within 30 s. Use a small `node` script run with the private
    Node.
- **`with_settings`**: the option `{"settings": "{\"typescript\":{\"tsserver\":{\"maxTsServerMemory\":8192}}}"}`
  shows up in `describe`.
- **`bad_settings`**: option `"[1]"`, and the build must fail with the message
  `settings must be a JSON object`. A failing scenario is checked by `run-features-test.sh`
  exiting non-zero; record how in CONTRIBUTING.

## Validation

- [ ] `bash features/typescript-lsp/test/launcher_test.sh` passes every fixture row
- [ ] `bash tests/features_test.sh --feature typescript-lsp` passes
- [ ] `bash features/typescript-lsp/test/run-features-test.sh` passes every scenario (Docker)
- [ ] Manual (core complete), web-client-ui with the Feature added to its devcontainer (copy
      the Feature folder into `.devcontainer/` and reference it as `"./typescript-lsp": {}`),
      `devc build`, `devc web`. Open `packages/iris-grid/src/IrisGrid.tsx`:
  - [ ] `TypeScript: starting…` clears within 15 s
  - [ ] hover on `GridRange` shows `class GridRange`
  - [ ] F12 opens `packages/grid/src/GridRange.ts`
  - [ ] `GridRange.` offers `boundedRanges`
  - [ ] planting `const devcProbe: number = "x";` underlines within 2 s
- [ ] Manual: from a terminal, change the return type of `GridRange.boundedRanges` in
      `packages/grid/src/GridRange.ts`. `IrisGrid.tsx` shows the new errors within 5 s.
      Revert.
- [ ] Manual: devc-tools itself with the Feature added. `devc/web/server.ts` gets
      `deno 2.9.x` (status text while starting), hover on `confine`, and `Deno.` completions.
- [ ] Manual: a scratch repo in the container with `npm i typescript@7.0.2` and a two-file
      project. Hover, completion, and the planted error (pull diagnostics) all work, and the
      status names `TypeScript 7.0.2 (workspace)`.
- [ ] Manual: a `.js` file in deephaven-core (no `package.json` above it) attaches, with server
      `vtsls 0.3.0 (bundled TypeScript 5.9.3)`, and hover works.
- [ ] `git status` in every repo used above shows nothing the language server wrote
- [ ] `deno fmt --check` passes for every touched `.md` / `.json`

## Relevant Files

- `features/typescript-lsp/devcontainer-feature.json` — new
- `features/typescript-lsp/install.sh` — new
- `features/typescript-lsp/devc-lsp-typescript` — new
- `features/typescript-lsp/README.md` — new
- `features/typescript-lsp/test/launcher_test.sh` — new
- `features/typescript-lsp/test/test.sh` — new
- `features/typescript-lsp/test/scenarios.json` — new
- `features/typescript-lsp/test/with_settings.sh` — new
- `features/typescript-lsp/test/bad_settings.sh` — new
- `features/typescript-lsp/test/run-features-test.sh` — copied from `features/xvfb/test/`
- `features/README.md` — row
- `features/CONTRIBUTING.md` — test inventory and `### typescript-lsp` note (private Node; no
  workspace writes; the topmost-marker rule)
- `features/PUBLISH_ALLOWLIST.txt` — `typescript-lsp`, last
- `devc/README.md` — the **Language servers** bullet names `typescript-lsp` as the Feature for
  TS/JS
- `.plans/PLAN.md` — status
