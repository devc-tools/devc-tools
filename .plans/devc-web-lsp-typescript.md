# devc-web-lsp-typescript

## Checklist

- [x] `features/typescript-lsp/devcontainer-feature.json`, per [Manifest](#manifest)
- [x] `features/typescript-lsp/install.sh`, per [install.sh](#installsh)
- [x] `features/typescript-lsp/devc-lsp-typescript`, the launcher, per [Launcher](#launcher)
- [x] `features/typescript-lsp/README.md`, per [README](#readme)
- [x] Offline harness `features/typescript-lsp/test/launcher_test.sh`, per [Tests](#tests)
- [x] Offline install test `features/typescript-lsp/test/install_options_test.sh`, per
      [Tests](#tests)
- [x] `features/typescript-lsp/vtsls/package.json` and `package-lock.json`, per
      [install.sh](#installsh)
- [x] Docker scenarios: `test/test.sh`, `test/scenarios.json` plus one script per scenario,
      `test/run-features-test.sh` (copied unchanged from `features/xvfb/test/`)
- [x] `features/README.md`: a row for `typescript-lsp`
- [x] `features/CONTRIBUTING.md`: per-Feature test inventory entry and a `### typescript-lsp` note
- [x] `devc/README.md`: the **Language servers** bullet names `typescript-lsp`
- [x] Run every [Validation](#validation) item an agent can run; hand the **(human)** and
      **(Docker host)** items to the user
- [x] Add `typescript-lsp` to `features/PUBLISH_ALLOWLIST.txt`, **only after** the user reports
      the Docker scenarios pass
- [x] `deno fmt` every touched `.md` and `.json` file

**Depends on [devc-web-lsp-core](devc-web-lsp-core.md)** being complete: this plan ships a
launcher that satisfies its [launcher contract](devc-web-lsp-core.md#launcher-contract). devc
web itself does not change here. It does not depend on the Python or Java plans.

**Who runs what.** Items marked **(Docker host)** need a machine with Docker (the devcontainer
has none; see `docs/maintainers/manual-verification.md`). Items marked **(human)** also need
devc web on the host and a browser. Everything else runs in the devcontainer.

A new Feature, `typescript-lsp`, gives devc web TypeScript and JavaScript intelligence for
plain TypeScript, Node, **Deno** and **Bun** projects. A container may hold several of them.
The nearest project marker above a file decides its runtime, and the server follows from the
project root:

1. **`deno lsp`** for a Deno project (`deno.json` / `deno.jsonc`)
2. **The workspace's own TypeScript 7+** (`tsc --lsp --stdio`) when the project depends on it.
   That includes a fresh `bun init` project: Bun 1.4.4's template pins `typescript` `^7`.
3. **vtsls** on the workspace's TypeScript otherwise, or on vtsls's bundled TypeScript 5.9.3 when
   the project has none

devc web's **Language server settings…** can override the root and the server per project
([core plan](devc-web-lsp-core.md#per-project-settings-lsp_configts)). The Feature's options are
container-wide defaults.

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
- **Bun needs no server of its own.** Measured on a `bun init` project (Bun 1.4.4):
  - both the workspace TS 7 server and vtsls resolved `Bun.file` to
    `node_modules/bun-types/globals.d.ts`
  - both completed 113 `Bun.` members and reported a planted error
  - TS 7 used 82 MB, vtsls 680 MB

  Bun's types come from `@types/bun` in `node_modules`, so a Bun project must be installed
  (`bun install`), like any Node project.
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
    "server": {
      "type": "string",
      "enum": ["auto", "deno", "workspace-typescript", "vtsls"],
      "default": "auto",
      "description": "Container-wide default for which server to run; devc web's Language server settings can override it per project. auto: deno lsp for a Deno root, the workspace's TypeScript 7+ language server when the project depends on it, else vtsls."
    },
    "settings": {
      "type": "string",
      "default": "{}",
      "description": "A JSON object deep-merged into the settings devc web gives the language server (workspace/configuration), e.g. {\"typescript\":{\"tsserver\":{\"maxTsServerMemory\":8192}}}. A per-project value from devc web replaces this one."
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
   - Download `https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-<arch>.tar.gz` and verify
     it against a sha256 baked into `install.sh` (not fetched), then extract to
     `/usr/local/share/devc-features/typescript-lsp/node` (`--strip-components=1`). Mismatch
     is `die "node checksum mismatch"`.
   - Pins, from `https://nodejs.org/dist/v24.22.1/SHASUMS256.txt`:

     ```sh
     NODE_VERSION='24.22.1'
     NODE_SHA256_X64='eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c'
     NODE_SHA256_ARM64='33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3'
     ```
4. **vtsls 0.3.0, fully locked.** The Feature ships `vtsls/package.json`
   (`{"private": true, "dependencies": {"@vtsls/language-server": "0.3.0"}}`) and
   `vtsls/package-lock.json`, generated once by the implementer with the pinned Node's npm
   (`npm install --package-lock-only` in that folder) and committed. `install.sh` copies both to
   `/usr/local/share/devc-features/typescript-lsp/vtsls` and runs
   `PATH=<node>/bin:$PATH npm ci --prefix <that dir> --omit=dev --no-audit --no-fund`. So
   transitive versions (vtsls's `vscode-languageserver ^9.0.1`, for one) can't drift between
   builds. To bump vtsls, change `package.json` and regenerate the lock.
   - Its entry point is `<prefix>/node_modules/@vtsls/language-server/bin/vtsls.js`, and its
     bundled TypeScript is `<prefix>/node_modules/typescript` (5.9.3, a dependency of
     `@vtsls/language-service`).
5. **Launcher.** Install `devc-lsp-typescript` to `/usr/local/bin/devc-lsp-typescript`, mode
   `0755`, with `SERVER` and `SETTINGS` baked in.
   - The launcher source holds exactly these two lines, which run unbaked as "use the
     built-in default":

     ```js
     const BAKED_SERVER = '';
     const BAKED_SETTINGS = '';
     ```

   - `install.sh` has a `bake_js <file> <name> <value>`, adapted from `features/xvfb`'s
     `bake()` (awk with the line passed as `-v`, then `grep -qxF` to confirm, else
     `die "could not bake <name>"`). It replaces the line starting `const <name> =` with
     `const <name> = '<b64>';`, where `<b64>` is `printf %s "$value" | base64 -w0`. Base64 keeps
     quotes and backslashes out of the JS. **Gotcha:** without `-w0`, GNU `base64` wraps at 76
     characters and a long `settings` value breaks the one-line bake.
   - The launcher decodes with `Buffer.from(v, 'base64').toString('utf8')`; `''` means unset.
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
3. **Markers.** A directory is a **Deno** directory if it holds `deno.json` or `deno.jsonc`. It
   is a **Node** directory if it holds `package.json`, `tsconfig.json` or `jsconfig.json` and is
   not a Deno directory. Bun projects are Node directories: Bun has no language server, and
   its types come from `@types/bun` / `bun-types` in `node_modules`.
4. **Root.**
   - **With `--root`:** use it. It must be the file's directory or an ancestor, else exit 3.
   - **Without:** walk up from the file's directory to top. The **nearest** marker directory
     decides the kind. The root is the **topmost** directory of that kind reached by
     continuing up:
     - skip directories with no marker
     - stop before the first directory of the other kind

     With no marker at all, the root is top, or the file's directory when top is `/`.
   - So a Bun or Node package inside a Deno repo gets a Node root, a Deno package inside a
     Node monorepo gets a Deno root, and web-client-ui's 37 per-package `tsconfig.json` files
     roll up to its root `package.json`.
5. **Server**, decided from the **root** alone, so `serve --root` repeats it:
   - The `server` option (per project, or the Feature default) can force one: `deno`,
     `workspace-typescript` or `vtsls`. `auto` (the default) means:
     - **Deno** when the root is a Deno directory
     - otherwise **TS 7** when the workspace TypeScript is ≥ 7
     - otherwise **vtsls**
   - The workspace TypeScript is the first `node_modules/typescript/package.json` walking from
     the root up to top.
   - A forced server that can't run exits 3:
     - `deno` with no `deno` on `PATH`
     - `workspace-typescript` with no workspace TypeScript ≥ 7
6. **Per server:**
   - **Deno:**
     - `deno --version` (first line, second word) is the version. If `deno` is not on `PATH`,
       exit 3 with `deno.json found but deno is not on PATH`.
     - server `deno <version>`
     - `initializationOptions` `{"enable": true, "lint": true}`
     - `settings` `{"deno": {"enable": true, "lint": true}}`, deep-merged with the `settings`
       option
   - **TS 7:**
     - server `TypeScript <version> (workspace)`
     - `initializationOptions` `{}`
     - `settings` = the `settings` option
     - **Native binary check.** TS 7's `bin/tsc` runs a native binary from the optional
       package `@typescript/typescript-linux-<arch>` (`<arch>` = Node's `process.arch`, `x64`
       or `arm64`). A `node_modules` installed on a macOS host, or for another architecture,
       lacks it. Check with
       `createRequire('<tsdir>/package.json').resolve('@typescript/typescript-linux-<arch>/package.json')`,
       which resolves the way `bin/tsc` does (hoisted, nested or pnpm). If it fails:
       - under `auto`: fall back to vtsls on the bundled TypeScript, server
         `vtsls 0.3.0 (bundled TypeScript 5.9.3; no linux-<arch> TypeScript 7 binary)`, and
         print one stderr line naming the missing package
       - forced `workspace-typescript`: exit 3 with
         `@typescript/typescript-linux-<arch> is not installed; run npm install in the container`
   - **vtsls with a workspace TypeScript < 7:**
     - server `vtsls 0.3.0 (TypeScript <version>)`
     - `settings`
       `{"typescript": {"tsdk": "<that typescript dir>/lib"}, "vtsls": {"autoUseWorkspaceTsdk": true}}`,
       deep-merged with the `settings` option
   - **vtsls with none, or with a workspace TypeScript ≥ 7** (only when forced, or the
     fallback below): TypeScript 7 ships no `lib/tsserver.js`, so vtsls can't run on it.
     - server `vtsls 0.3.0 (bundled TypeScript 5.9.3)`
     - `settings` = the `settings` option (no `tsdk`)
   - **Bun:** when `bun.lock`, `bun.lockb` or `bunfig.toml` exists in the root, the server
     string gains `, Bun` (`TypeScript 7.0.2 (workspace, Bun)`). Nothing else changes.
7. Print `{"protocol": 1, root, languageId, server, initializationOptions, settings}` as one line.

**`serve --root <root> [--options <b64>]`** decides the server from `root` and the options with
the same rules, then spawns it with `stdio: 'inherit'`. It forwards `SIGTERM` and `SIGINT` and
exits with the child's code. It never writes to stdout itself.

| Server | Command                                                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Deno   | `deno lsp`                                                                                                                                |
| TS 7   | `<node> <tsdir>/bin/tsc --lsp --stdio`. **Gotcha:** `bin/tsc` is a Node shim that starts the native binary, so it needs the private Node. |
| vtsls  | `<node> <vtsls entry> --stdio`                                                                                                            |

**`options`** prints:

- `server`: enum `auto`, `deno`, `workspace-typescript`, `vtsls`; default the Feature's `server`
  option (`auto`)
- `settings`: json; default the Feature's `settings` option

**Option precedence and invalid options** follow the
[core contract](devc-web-lsp-core.md#launcher-contract): each key, `settings` included, is
replaced (not merged) by the per-project value, then the Feature's baked value, then the
built-in default; the chosen `settings` is deep-merged over the computed settings. Invalid
`--options` (bad base64 or JSON, not an object, `server` not one of the four, `settings` not an
object) exit 1 with a one-line reason.

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

`test/launcher_test.sh` (offline, needs `node` ≥ 18 and `git` on `PATH`). It builds fixtures in a
`mktemp -d` and runs `node features/typescript-lsp/devc-lsp-typescript describe …`, comparing
fields with `node -e`. Fixtures:

| Fixture                                                                                                                                                                    | Expect                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| git repo with root `package.json`, `packages/a/tsconfig.json`, `node_modules/typescript/package.json` `{"version":"5.6.3"}`; file `packages/a/src/x.tsx`                   | root = repo; `typescriptreact`; server `vtsls 0.3.0 (TypeScript 5.6.3)`; `settings.typescript.tsdk` = `<repo>/node_modules/typescript/lib` |
| same, with typescript `7.0.2` and `node_modules/@typescript/typescript-linux-<arch>/package.json`                                                                          | server `TypeScript 7.0.2 (workspace)`; no `tsdk`                                                                                           |
| git repo, `package.json`, no `node_modules`; file `a.js`                                                                                                                   | `javascript`; `vtsls 0.3.0 (bundled TypeScript 5.9.3)`                                                                                     |
| git repo, `deno.json` at top and in `pkg/`; file `pkg/x.ts`; a fake `deno` on `PATH` printing `deno 2.9.8 (…)`                                                             | root = repo (topmost); server `deno 2.9.8`; `initializationOptions.enable` true                                                            |
| same, without `deno` on `PATH`                                                                                                                                             | exit 3                                                                                                                                     |
| a `.py` file                                                                                                                                                               | exit 3                                                                                                                                     |
| `BAKED_SETTINGS` replaced with `{"typescript":{"tsserver":{"maxTsServerMemory":1}}}` in a copy                                                                             | merged next to `tsdk`                                                                                                                      |
| git repo with `deno.json` at top, `tools/bun-app/package.json` + `bun.lock` + `node_modules/typescript` `7.0.2` (with the platform package); file `tools/bun-app/index.ts` | root = `tools/bun-app` (nearest kind Node, stops before the Deno top); server `TypeScript 7.0.2 (workspace, Bun)`                          |
| git repo with root `package.json`, `deno-pkg/deno.json`; file `deno-pkg/mod.ts`; fake `deno`                                                                               | root = `deno-pkg`; server `deno 2.9.8`                                                                                                     |
| directory with both `deno.json` and `package.json`; fake `deno`                                                                                                            | Deno                                                                                                                                       |
| `--root <repo>/packages/a` on the first fixture's file                                                                                                                     | root = `<repo>/packages/a`; still `vtsls 0.3.0 (TypeScript 5.6.3)` (TypeScript found walking up)                                           |
| `--root /elsewhere`                                                                                                                                                        | exit 3, `root does not contain the file`                                                                                                   |
| `--options` = base64 `{"server":"vtsls"}` on the TS 7 fixture                                                                                                              | server `vtsls 0.3.0 (bundled TypeScript 5.9.3)`; no `tsdk`                                                                                 |
| `--options` = base64 `{"server":"deno"}` without `deno` on `PATH`                                                                                                          | exit 3                                                                                                                                     |
| TS 7 fixture without the platform package                                                                                                                                  | server `vtsls 0.3.0 (bundled TypeScript 5.9.3; no linux-<arch> TypeScript 7 binary)`; one stderr line                                      |
| same, `--options` base64 `{"server":"workspace-typescript"}`                                                                                                               | exit 3, message names `@typescript/typescript-linux-<arch>`                                                                                |
| baked `SETTINGS` `{"a":{"b":1}}`, `--options` base64 `{"settings":{"a":{"c":2}}}`                                                                                          | settings has `a.c` = 2 and no `a.b` (per-project replaces baked)                                                                           |
| `--options` = `!!!`, base64 `[1]`, base64 `{"server":"x"}`, base64 `{"settings":3}`                                                                                        | each exits 1 with a one-line reason                                                                                                        |
| `options` subcommand                                                                                                                                                       | `protocol` 1; keys `server` (enum, default `auto`) and `settings` (json)                                                                   |
| a directory that is not a git repo with `tsconfig.json`                                                                                                                    | root = that directory                                                                                                                      |

Docker scenarios (`test/scenarios.json`, image `mcr.microsoft.com/devcontainers/base:ubuntu`):

- **`test.sh`** (default `{}`):
  - `devc-lsp-typescript describe` on a generated TS project returns `protocol` 1.
  - `serve --root` answers an `initialize` frame piped on stdin with a result whose
    `serverInfo.name` is `vtsls`, within 30 s. Use a small `node` script run with the private
    Node.
- **`with_settings`**: the option `{"settings": "{\"typescript\":{\"tsserver\":{\"maxTsServerMemory\":8192}}}"}`
  shows up in `describe`.
  `devcontainer features test` has no expected-failure mode, so build-time refusals are tested
  offline instead, in `test/install_options_test.sh`, following
  `features/xvfb/test/install_options_test.sh` and `features/agents/test/install_options_test.sh`:
  run the real `install.sh` with `SHARE_DIR`-style path overrides into a `mktemp -d`, and `curl`,
  `apt-get`, `tar`, `sha256sum` and `npm` stubbed on `PATH` (the `curl` stub copies a fixture
  file, the `npm` stub records its arguments). `install.sh` therefore reads its install paths
  from overridable variables: `SHARE_DIR` (default `/usr/local/share/devc-features/typescript-lsp`)
  and `BIN_DIR` (default `/usr/local/bin`). The `tar` stub creates `<dest>/bin/node` and
  `<dest>/bin/npm` as wrappers that exec the stubs' `node` (the real one on `PATH`) and the `npm`
  stub. Rows:

- `SETTINGS='[1]'` → non-zero exit, output contains `settings must be a JSON object`, nothing
  under `BIN_DIR`
- `SETTINGS='{"a":"it'"'"'s \"q\""}'` and `SERVER=vtsls` → the installed launcher has both
  `BAKED_` lines rewritten, and its `describe` on a fixture reflects them (proves the bake
  survives quotes)
- a 2,000-character `SETTINGS` → the baked line is still one line
- `uname -m` stubbed to `riscv64` → `unsupported architecture: riscv64`
- the Node tarball stub with different bytes → `node checksum mismatch`
- the `npm` stub is called with `ci` and `--omit=dev`, never `install`

## Validation

- [x] `bash features/typescript-lsp/test/launcher_test.sh` passes every fixture row
- [x] `bash features/typescript-lsp/test/install_options_test.sh` passes every row
- [x] `bash tests/features_test.sh --feature typescript-lsp` passes
- [ ] **(Docker host)** `bash features/typescript-lsp/test/run-features-test.sh` passes every
      scenario
- [ ] **(human)** Setup for the manual items: add the unpublished Feature to a project as a
      local Feature, and undo it afterwards.
  - Project with no `.devcontainer/` (web-client-ui, devc-tools): `devc init` in the checkout,
    then `cp -r <devc-tools>/features/typescript-lsp .devcontainer/` and add
    `"./typescript-lsp": {}` to `.devcontainer/devcontainer.json`'s `features`. Afterwards
    `rm -rf .devcontainer` and `devc build`.
  - Project with a committed `.devcontainer/` (deephaven-core): the same copy and `features`
    entry; afterwards `git checkout .devcontainer && rm -rf .devcontainer/typescript-lsp` and
    `devc build`.
  - `devc build`, then `devc web`. If core's stub launcher was installed by hand, the rebuild
    replaces it; that's expected.
- [ ] **(human)** Manual (core complete), web-client-ui with the Feature added as above.
      Open `packages/iris-grid/src/IrisGrid.tsx`:
  - [ ] `TypeScript: starting…` clears within 15 s
  - [ ] hover on `GridRange` shows `class GridRange`
  - [ ] F12 opens `packages/grid/src/GridRange.ts`
  - [ ] `GridRange.` offers `boundedRanges`
  - [ ] planting `const devcProbe: number = "x";` underlines within 2 s
- [ ] **(human)** Manual: from a terminal, change the return type of `GridRange.boundedRanges` in
      `packages/grid/src/GridRange.ts`. `IrisGrid.tsx` shows the new errors within 5 s.
      Revert.
- [ ] **(human)** Manual (Bun): in the container, `bun init` a project in a scratch git repo. A `.ts` file
      there gets server `TypeScript 7.x (workspace, Bun)`, hover on `Bun.file`, and `Bun.`
      completions. Before `bun install`, `Bun` is unresolved, and the README says why.
- [ ] **(human)** Manual (multi-project): in devc-tools' repo overlay
      (`~/.config/devc/repos/devc-tools-<hash>/devc.jsonc`; `devc status` prints the path) add
      `"mounts": ["type=bind,source=<host path of web-client-ui>,target=/workspaces/web-client-ui"]`,
      with the Feature added to devc-tools as above, then `devc build`. Open
      `devc/web/server.ts` and `/workspaces/web-client-ui/packages/grid/src/GridRange.ts` (from
      **Files**). Two sessions attach, one `deno …`, one `vtsls …` or `TypeScript 7…`. Remove
      the mount afterwards.
- [ ] **(human)** Manual (override): **Language server settings…** on an `IrisGrid.tsx` tile:
  - [ ] Server `vtsls` and Root `packages/iris-grid`, then Save: the session restarts with that
        root, and the status names vtsls
  - [ ] **Reset to detected** restores the repo-root session
- [ ] **(human)** Manual: devc-tools itself with the Feature added. `devc/web/server.ts` gets
      `deno 2.9.x` (status text while starting), hover on `confine`, and `Deno.` completions.
- [ ] **(human)** Manual: a scratch repo in the container with `npm i typescript@7.0.2` and a two-file
      project. Hover, completion, and the planted error (pull diagnostics) all work, and the
      status names `TypeScript 7.0.2 (workspace)`.
- [ ] **(human)** Manual: deephaven-core's
      `web/client-api/src/main/java/io/deephaven/web/public/batch.js` (no `package.json`
      above it) attaches, with server `vtsls 0.3.0 (bundled TypeScript 5.9.3)`, and hover
      works.
- [x] `git status` in every repo used above shows nothing the language server wrote
- [x] `deno fmt --check` passes for every touched `.md` / `.json`

## Relevant Files

- `features/typescript-lsp/devcontainer-feature.json` — new
- `features/typescript-lsp/install.sh` — new
- `features/typescript-lsp/devc-lsp-typescript` — new
- `features/typescript-lsp/README.md` — new
- `features/typescript-lsp/vtsls/package.json` — new
- `features/typescript-lsp/vtsls/package-lock.json` — new, generated
- `features/typescript-lsp/test/launcher_test.sh` — new
- `features/typescript-lsp/test/install_options_test.sh` — new
- `features/typescript-lsp/test/test.sh` — new
- `features/typescript-lsp/test/scenarios.json` — new
- `features/typescript-lsp/test/with_settings.sh` — new
- `features/typescript-lsp/test/run-features-test.sh` — copied from `features/xvfb/test/`
- `features/README.md` — row
- `features/CONTRIBUTING.md` — test inventory and `### typescript-lsp` note (private Node; no
  workspace writes; the topmost-marker rule)
- `features/PUBLISH_ALLOWLIST.txt` — `typescript-lsp`, last
- `devc/README.md` — the **Language servers** bullet names `typescript-lsp` as the Feature for
  TS/JS
- `.plans/PLAN.md` — status
