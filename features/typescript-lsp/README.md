# typescript-lsp (devcontainer Feature)

Gives [devc web](../../devc/README.md)'s file editor TypeScript and JavaScript intelligence
(completion, hover, go to definition, diagnostics, formatting) for plain TypeScript, Node, Deno
and Bun projects. It installs `devc-lsp-typescript`, the launcher devc web runs inside the
container, plus a private Node and [vtsls](https://github.com/yioneko/vtsls) 0.3.0.

```jsonc
"features": {
  "ghcr.io/devc-tools/features/typescript-lsp:0": {}
}
```

A bare `{}` needs no options and nothing host-side. Every `.ts`, `.tsx`, `.mts`, `.cts`, `.js`,
`.jsx`, `.mjs` and `.cjs` file devc web opens for editing in this container gets a language
server, picked per project as below. Nothing else in the container changes: the Feature's Node
is private (the image's Node, if any, is untouched and unused), and nothing is ever written into
the workspace.

> The tag tracks **this Feature's own** version line, not the devc-tools release. It is `:0`
> while this Feature is pre-1.0.

## Which server a file gets

The nearest project marker above the file decides its kind: `deno.json` or `deno.jsonc` makes a
**Deno** project, `package.json`, `tsconfig.json` or `jsconfig.json` (without a `deno.json`
beside it) a **Node** one. The project root is the **topmost** directory of that kind, walking
up to the repo's top and stopping before a directory of the other kind. So a monorepo with a
`tsconfig.json` in every package gets one server at its root `package.json`, a Bun app inside a
Deno repo gets a Node root, and a Deno package inside a Node monorepo gets a Deno root. With no
marker at all, the root is the repo's top.

The root then picks the server:

| Root                                                                | Server                                     | devc web shows                           |
| ------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------- |
| a Deno project                                                      | `deno lsp`, from the `deno` on your `PATH` | `deno 2.9.8`                             |
| depends on TypeScript 7 or later (`node_modules/typescript` ≥ 7)    | the workspace's own `tsc --lsp --stdio`    | `TypeScript 7.0.2 (workspace)`           |
| depends on an older TypeScript                                      | vtsls on the workspace's TypeScript        | `vtsls 0.3.0 (TypeScript 5.6.3)`         |
| has no `node_modules/typescript` (from the root up to the repo top) | vtsls on its bundled TypeScript 5.9.3      | `vtsls 0.3.0 (bundled TypeScript 5.9.3)` |

A root holding `bun.lock`, `bun.lockb` or `bunfig.toml` adds `, Bun` to the name
(`TypeScript 7.0.2 (workspace, Bun)`). Bun needs no server of its own: its types come from
`@types/bun` in `node_modules`, and both TypeScript servers read them. A fresh `bun init`
project depends on TypeScript 7, so it gets the workspace's TypeScript 7 server.

**TypeScript 7 is used only when the project depends on it**, never as a faster stand-in for an
older one. TypeScript 7 refuses tsconfig settings 5.x accepts (`baseUrl`,
`moduleResolution: node10`, non-relative `paths`), and its server would check the project under
rules its own build doesn't use. TypeScript 7's `bin/tsc` runs a native binary from
`@typescript/typescript-linux-<arch>`; a `node_modules` installed on a macOS host lacks it, and
the file falls back to vtsls on its bundled TypeScript (`…; no linux-arm64 TypeScript 7 binary`)
until you run `npm install` in the container.

devc web's **Language server settings…** (a file tile's menu) can change the root and the
server per project; the Feature's options are the container-wide defaults.

## Install your dependencies first

The launcher reads `node_modules`; it never runs `npm install`, `bun install` or `deno install`.

- A Node or Bun project needs its `node_modules` installed **in the container** for the
  workspace's TypeScript to be used, and for imports (including Bun's `Bun.*` types) to resolve.
  Before that, the file gets vtsls on its bundled TypeScript and imports show as unresolved.
- A Deno project needs its dependency cache warm (`deno install`), otherwise `jsr:` and `npm:`
  imports show as not installed.

Expect `(loading...)` hovers from vtsls for the first several seconds on a large project (about
10 s on a 37-package monorepo); that is tsserver loading the project.

## Options

| Option     | Default  | Meaning                                                                                                                                                                                                   |
| ---------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server`   | `"auto"` | `auto` (the table above), or `deno`, `workspace-typescript` or `vtsls` to force one. A forced server that can't run (no `deno` on `PATH`, no workspace TypeScript 7) leaves the file a plain editor.      |
| `settings` | `"{}"`   | A JSON object deep-merged into the settings the server gets (`workspace/configuration`). The build fails if it isn't a JSON object. A per-project **settings** value in devc web replaces it, not merges. |

For example, to give vtsls's tsserver more memory on a large monorepo:

```jsonc
"features": {
  "ghcr.io/devc-tools/features/typescript-lsp:0": {
    "settings": "{\"typescript\":{\"tsserver\":{\"maxTsServerMemory\":8192}}}"
  }
}
```

## What it installs

| Path                                                   | What                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `/usr/local/bin/devc-lsp-typescript`                   | The launcher (`describe`, `serve`, `options`), with the options baked in.                         |
| `/usr/local/share/devc-features/typescript-lsp/node/`  | Node 24.22.1, checked against a SHA-256 pinned in `install.sh`. About 140 MB.                     |
| `/usr/local/share/devc-features/typescript-lsp/vtsls/` | vtsls 0.3.0 and its bundled TypeScript 5.9.3, installed by `npm ci` from a lockfile. About 30 MB. |

To bump vtsls, change `vtsls/package.json` and regenerate `vtsls/package-lock.json` with
`npm install --package-lock-only` in that folder, using Node 24.22.1's npm.

## What this is not

- No ESLint or other lint server.
- No `deno`: a Deno project uses the `deno` already on your `PATH`, so the server matches the
  project's Deno.
- No editor integration outside devc web.
