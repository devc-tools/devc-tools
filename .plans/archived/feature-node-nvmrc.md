# `node-nvmrc` Feature — the project's pinned Node, installed and auto-used

## Goal

Publish `ghcr.io/devc-tools/features/node-nvmrc`: given a `.nvmrc` in the
workspace, install that Node at create time and select it in every interactive
shell. One line in any `devcontainer.json`, devc or not.

**Copy, don't move.** `devc/default/scripts/node-setup.sh` and the nvm block in
`bashrc-additions.sh` keep working exactly as they do today. Swapping devc onto
the published Feature is a later plan — see
[devc-feature-split](../design/devc-feature-split.md), "Copy, don't move".

### Why this one is the clean case

It is the only candidate of the four with **no host coupling at all**: it reads
the workspace, writes the container, and needs no mount. Everything it does today
is devc-shaped only because it happens to live in devc.

## Existing touchpoints

- `devc/default/scripts/node-setup.sh` — the whole create-time step. Source
  material; unchanged by this plan.
- `devc/default/scripts/bashrc-additions.sh` lines 13–17 — `NVM_DIR`, sourcing
  `nvm.sh`, the `cd()` wrapper, and the initial `nvm use --silent`. Source
  material; unchanged by this plan.
- `features/devc-bridge/` — the shape a Feature directory takes here
  (manifest + `install.sh` + `README.md` + `test/`).
- `features/README.md` — add a row (created by
  [features-collection](features-collection.md), which lands first).

## Contracts

### `features/node-nvmrc/devcontainer-feature.json`

```jsonc
{
  "id": "node-nvmrc",
  "version": "<the repo's current version — same as every other Feature>",
  "name": "Node from .nvmrc",
  "description": "...",
  "documentationURL": "https://github.com/devc-tools/devc-tools/tree/main/features/node-nvmrc",
  "options": {
    "nvmDir": { "type": "string", "default": "/usr/local/share/nvm" },
    "installOnCreate": { "type": "boolean", "default": true },
    "autoUseOnCd": { "type": "boolean", "default": true },
    "fixNodeModulesOwnership": { "type": "boolean", "default": true }
  },
  "installsAfter": ["ghcr.io/devcontainers/features/node"],
  "postCreateCommand": "bash /usr/local/share/devc-features/node-nvmrc/post-create.sh"
}
```

- Options reach `install.sh` uppercased with non-word characters stripped
  (`getSafeId`): `$NVMDIR`, `$INSTALLONCREATE`, `$AUTOUSEONCD`,
  `$FIXNODEMODULESOWNERSHIP`. Booleans arrive as the strings `true`/`false`.
- **`installsAfter`, not `dependsOn`.** `dependsOn` would install
  `ghcr.io/devcontainers/features/node` with options this Feature picked —
  version, `pnpmVersion`, `nvmVersion` — which is exactly what a consumer wants
  to choose. The README states the prerequisite instead: _something_ must provide
  nvm at `nvmDir`. `installsAfter` only orders us behind it when both are present.
- Nothing here needs nvm to exist at build time, so a consumer who provides nvm
  some other way still works.

### `features/node-nvmrc/install.sh`

Runs as root at build time. Its whole job is to place files; it must not touch
nvm.

1. Write `/usr/local/share/devc-features/node-nvmrc/post-create.sh` (below),
   `0755`, root-owned, with `NVM_DIR` and the two behavioral flags **baked in**
   from the options — the manifest's `postCreateCommand` takes no arguments, so
   the options have to cross into the script at build time.
2. When `autoUseOnCd` is true, append a marker-guarded block to
   `$_REMOTE_USER_HOME/.bashrc`:

   ```sh
   # >>> node-nvmrc >>>
   ...
   # <<< node-nvmrc <<<
   ```

   Guarded by `grep -qF` on the opening marker so a rebuild does not double-append
   — the same shape `devc/default/Dockerfile` uses for `bashrc-additions`. Written
   as `$_REMOTE_USER` (or `chown`ed after) so the file does not become root-owned.

The block's content is the nvm half of `bashrc-additions.sh`, with the fence
markers `# devc:nvm-use (start|end)` around the functional lines so a harness can
extract it (see Validation):

```sh
export NVM_DIR="<nvmDir>"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
cd() { builtin cd "$@" && [ -f .nvmrc ] && nvm use --silent; }
[ -f .nvmrc ] && nvm use --silent
```

Two deviations from devc's copy, both required by a Feature not knowing whose
shell it is in:

- The `cd()` override is **conditional on nvm having loaded**. devc's copy
  redefines `cd` unconditionally; in an image without nvm that leaves a `cd` that
  calls a nonexistent `nvm` on every directory change. A Feature installed into
  an arbitrary image must degrade to plain `cd`.
- The block must not `set -e`-fail a shell: every line stays guarded, and the
  final `[ -f .nvmrc ] && nvm use --silent` must not leave a non-zero `$?` at the
  first prompt (append `|| true`, or make it an `if`). devc gets away with it
  because its PS1 renders `$?` decoratively; a consumer's may not.

### `/usr/local/share/devc-features/node-nvmrc/post-create.sh`

Contract, as a Feature-declared `postCreateCommand` — which the CLI runs **as the
remote user**, **before** any user-provided `postCreateCommand`:

```sh
cd "${PROJECT_PATH:-$PWD}"            # workspace root
[ -f .nvmrc ] || exit 0               # no .nvmrc → no-op, success
. "$NVM_DIR/nvm.sh"                   # missing → warn on stderr, exit 0
[ "$FIX_NODE_MODULES_OWNERSHIP" = true ] && node_modules chown, best-effort
nvm install                           # failure is fatal
```

- **`${PROJECT_PATH:-$PWD}`, exactly as devc's script does.** `PROJECT_PATH` is
  devc's `remoteEnv`; a non-devc consumer will not have it, and `$PWD` for a
  Feature lifecycle hook is _assumed_ to be the workspace folder. **Measure this**
  (`.plans/design/devc-feature-split.md`, open question 1) — if it is not the
  workspace folder, the fallback becomes `$_CONTAINER_WORKSPACE_FOLDER`-style
  baking at build time and this plan is not done.
- **A missing `.nvmrc` is success, not a skip-with-noise.** The Feature is meant
  to be safe to leave enabled in a repo that has no `.nvmrc`.
- **A missing nvm is a warning, not a failure.** The prerequisite is documented,
  and failing create for it turns a misconfiguration into an unbootable
  container. `nvm install` failing _is_ fatal — the `.nvmrc` asked for a version
  that could not be installed, which the consumer must see.
- **The `node_modules` chown**: `sudo chown -R "$(id -u):$(id -g)" ./node_modules`
  guarded by `command -v sudo` and `[ -d node_modules ]`, `2>/dev/null || true`.
  It exists because devc mounts a **named volume** at
  `${containerWorkspaceFolder}/node_modules`, which first mounts root-owned. The
  Feature does not declare that volume (devc keeps it) but the repair is portable
  — anyone who mounts a volume there hits the same thing. Never recursive-chown
  the workspace; only `node_modules`, only when it exists.
- Hardcoded `vscode` from devc's copy is gone — `id -u`/`id -g` is whoever the
  hook runs as.

## Concept boundaries

- **`node-nvmrc` vs `ghcr.io/devcontainers/features/node`.** The upstream Feature
  installs Node and nvm. This one only reads `.nvmrc` and drives the nvm that is
  already there. The README must open with that sentence; a name like
  "node feature" in an issue will otherwise mean either.
- **`NVM_DIR`**: `/usr/local/share/nvm` is the upstream node Feature's location,
  not a devc invention — hence the option rather than a constant.
- **`/usr/local/share/devc-features/`** ≠ `/usr/local/share/devc/`. The latter is
  devc's baseline namespace (`post-create.sh`, `scripts/`, `claude-seed`,
  `gitconfig-identity`, `shell`) and no Feature writes into it.
- **Fence marker `devc:nvm-use`** names a block, matching the existing
  `devc:seed-link` / `devc:shell-dirs` / `devc:project-hook` convention. It marks
  a block, not an owner — devc's `bashrc-additions.sh` keeps its own unfenced nvm
  lines for now and gains this marker only in the swap plan.

## Checklist

- [x] `features/node-nvmrc/devcontainer-feature.json` — id/version/name, four
      options, `installsAfter`, `postCreateCommand`
- [x] `features/node-nvmrc/install.sh` — script placement, option baking,
      marker-guarded `~/.bashrc` append for `$_REMOTE_USER`
- [x] `features/node-nvmrc/post-create.sh` (the file `install.sh` installs) —
      `.nvmrc`-gated `nvm install`, best-effort `node_modules` chown
- [x] `features/node-nvmrc/README.md` — prerequisite (a Feature providing nvm),
      options table, "what this is not" vs the upstream node Feature, the
      `node_modules`-volume rationale
- [x] `features/node-nvmrc/test/test.sh` — `devcontainer features test` scenario.
      The default (autogenerated) scenario is `{}` on a base image with **no nvm**,
      so it doubles as the design doc's bare-`{}` case; `test/scenarios.json` plus
      `with_nvmrc.sh` / `no_nvmrc.sh` add the two where nvm is present
- [x] `features/node-nvmrc/test/run-features-test.sh` — wrapper, per
      [features-collection](features-collection.md). It now stages the
      whole `test/` directory minus itself rather than only `test.sh`, or
      `scenarios.json` would never reach the command; `devc-bridge`'s copy was
      updated identically, since the file is meant to be the same in every Feature
- [x] `features/node-nvmrc/test/nvm_use_test.sh` — offline harness over the
      `devc:nvm-use` block
- [x] `features/README.md` — row for this Feature, plus the wrapper/scenarios
      paragraph the staging change made stale
- [x] `.plans/PLAN.md` — register

## Validation

- [x] `bash features/node-nvmrc/test/nvm_use_test.sh` — extracts the
      `devc:nvm-use` block from the real `install.sh` and runs it against temp
      dirs (the technique `devc/tests/shell_dirs_test.sh` uses): with a fake
      `nvm.sh` on the path it `nvm use`s on `cd` into a dir with `.nvmrc` and not
      otherwise; with **no** `nvm.sh` `cd` still works and nothing errors; `$?` is
      0 after sourcing in both cases. 31 checks, all ok — 7 cases, including two
      the plan did not ask for: a failing `cd` still fails and selects nothing, and
      a _successful_ `cd` into a directory without a `.nvmrc` returns 0 (see the
      third deviation below)
- [x] Also run offline, though the plan lists neither: `install.sh` itself, with
      `SHARE_DIR` and `_REMOTE_USER_HOME` pointed at temp dirs. All four options
      bake through (`nvmDir` into both the create-time script and the `~/.bashrc`
      block, the three flags into their assignments), a second run leaves exactly
      one marker pair, `autoUseOnCd: false` writes no `.bashrc` at all, and the
      installed `post-create.sh` was exercised on all four paths — no `.nvmrc`
      (silent, 0), `.nvmrc` + fake nvm (`nvm install` called), `.nvmrc` + missing
      nvm (three-line warning on stderr, exit 0), `installOnCreate: false` (no-op).
      The appended block was then sourced against the **real** nvm in this
      devcontainer: `$?` 0, `cd` into a directory with a `.nvmrc` selected that
      version and returned 0
- [ ] (needs Docker) `bash features/node-nvmrc/test/run-features-test.sh` — a
      scenario image with the upstream node Feature plus this one, and a `.nvmrc`
      in the workspace: the pinned version is installed, `node -v` in a fresh
      interactive `bash -lic` reports it, and `cd`-ing out and back keeps it.
      **Not run — no Docker in this environment.** Written as the `with_nvmrc`
      scenario, which pins `20` while the node Feature installs `lts` so "the
      pinned version won" is observable rather than coincidental
- [ ] (needs Docker) A scenario with **no** `.nvmrc` creates cleanly and the
      hook exits 0. **Not run.** Written as the `no_nvmrc` scenario
- [ ] (needs Docker) A scenario **without** any nvm-providing Feature creates
      cleanly, warns, and leaves a working `cd`. **Not run.** This is the
      _autogenerated default_ scenario — `{}` on the command's default base image,
      which has no nvm — so `test/test.sh` is that case, and it is the design
      doc's bare-`{}` case at the same time
- [ ] **Measured, not assumed:** the cwd a Feature-declared `postCreateCommand`
      runs in. **Not measured — no Docker.** What was done instead is recorded in
      `.plans/design/devc-feature-split.md` open question 1: the devcontainer CLI's
      own source says `remoteCwd = remoteWorkspaceFolder || homeFolder` for every
      lifecycle hook, Feature-contributed ones included
      (`src/spec-common/injectHeadless.ts`), so the answer is the workspace folder.
      That is a source read, not a measurement. `${PROJECT_PATH:-$PWD}` stays, and
      the `with_nvmrc` scenario is the thing that will actually measure it — its
      first check fails if the hook did not find the `.nvmrc` an `onCreateCommand`
      wrote at the workspace root
- [x] `deno fmt --check` clean — 121 files
- [x] `bash tests/workflow_guards_test.sh` — 10 checks, ALL PASS, now covering
      `features/node-nvmrc` (id equals directory, version `0.1.0` equals the
      collection's)

### A third deviation from devc's copy, not in the plan

The plan specifies two deviations and copies devc's `cd` one-liner verbatim for the
rest. That one-liner is
`cd() { builtin cd "$@" && [ -f .nvmrc ] && nvm use --silent; }`, which **returns 1
from every `cd` into a directory that has no `.nvmrc`** — so `cd somewhere && make`
silently stops before `make`. devc gets away with it for the same reason it gets away
with the `$?` wart the plan _does_ fix: its own PS1 only colors the status. Under the
plan's own stated rationale, a Feature landing in someone else's shell cannot.

Implemented instead:

```sh
cd() {
  builtin cd "$@" || return
  [ -f .nvmrc ] && nvm use --silent
  return 0
}
```

A failed `cd` still fails; a successful one succeeds. Pinned by two checks in
`nvm_use_test.sh` and one in `no_nvmrc.sh`.

## Not in this plan

- Any edit to `devc/default/` — including deleting `scripts/node-setup.sh` or the
  nvm lines in `bashrc-additions.sh`, and including adding this Feature to the
  bundled `devcontainer.json`. Both copies run in parallel until the swap plan.
- Installing Node itself, `corepack`/`pnpm`/`yarn` enablement, or `npm ci` — the
  upstream node Feature and the project's own post-create hook own those.
