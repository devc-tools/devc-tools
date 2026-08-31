# `project-hook` Feature — run the project's own create-time script

## Goal

Publish `ghcr.io/devc-tools/features/project-hook`: on every container create,
run the project's own `devc-post-create.sh` if it has one. `.devc/` first, then
`.devcontainer/`, first hit wins; existence selects and executability is
enforced.

This is the **cleanest standalone case in the collection**. It reads the
workspace and nothing else — no host state, no mount, no `initializeCommand`, no
option, no network. `"project-hook": {}` is the complete install, and the whole
of what a consumer adds is a committed, executable script in their own repo.

**Copy, don't move.** `devc-core/default/scripts/project-hook.sh` keeps running
exactly as it does today. Nothing in `devc-core/` changes in this plan, and devc
does not learn about this Feature here — that is the separate integration the
Feature has to be published before anyone can write.

## Why this exists

devc's baseline delivers `project-hook.sh` two ways, and both are files it has
to place somewhere: baked into the image by `devc-core/default/Dockerfile` for
the zero-config path, and copied into a project's `.devcontainer/scripts/` by
`installBundledAssets` in `devc config` mode. As a Feature the mechanism is
installed by the Feature rather than shipped by devc, which is what eventually
lets `devc config` stop committing devc plumbing into user repos and lets
`materializeDefaultConfig`'s `postCreateCommand` rewrite
(`devc-core/default_config.ts:307`) go away with it.

None of that happens here. This plan produces one publishable Feature.

## Existing touchpoints

- `devc-core/default/scripts/project-hook.sh` — source material. The fenced
  `devc:project-hook` block is copied **byte-for-byte**; the comments above the
  fence are devc-specific and get rewritten for the Feature.
- `devc/tests/project_hook_test.sh` — already takes the script path as `$1` and
  extracts the fence. It runs against the Feature's copy **unmodified**; if it
  needs a change for one of the two copies, they have drifted. Cited, not
  edited.
- `features/node-nvmrc/` — the shape to follow: manifest with
  `postCreateCommand`, an `install.sh` that only places files, a `test/` with a
  bare-`{}` `test.sh` plus `scenarios.json`, and `run-features-test.sh` copied
  in unchanged.
- `features/README.md` — the Published Features table.
- `features/PUBLISH_ALLOWLIST.txt` — the publish gate.
- `devc/README.md:641-648` — the list of fence harnesses and the copies they run
  against.

## Contracts

### `features/project-hook/devcontainer-feature.json`

```jsonc
{
  "id": "project-hook",
  // Its own version, independent of the repo tag and of the other Features —
  // see .plans/archived/feature-independent-versions.md. A new Feature starts here.
  "version": "0.1.0",
  "name": "Project create-time hook",
  "description": "<non-empty; see the guard below>",
  "documentationURL": "https://github.com/devc-tools/devc-tools/tree/main/features/project-hook",
  "licenseURL": "https://github.com/devc-tools/devc-tools/blob/main/LICENSE",
  "postCreateCommand": "bash /usr/local/share/devc-features/project-hook/post-create.sh"
}
```

`name` and `description` must be non-empty and `id` must equal the directory
name — `bash tests/features_test.sh` fails the collection otherwise, and
`features package` fails much further from the cause.

**No `options`, deliberately.** Two reasons, and the second is the one that
settles it:

1. The candidate paths are hardcoded inside the fenced block. Making them an
   option means rewriting a line inside the fence, which breaks byte-identity
   with devc's copy and therefore breaks the drift guard that
   `project_hook_test.sh` exists to be.
2. A `projectDir` option — the shape `node-nvmrc` and `shell-dirs` both have —
   could not be usefully set by devc anyway. `--additional-features` JSON is
   stored raw from argv and never passes through the CLI's substitution pass
   (measured against the pinned `@devcontainers/cli` 0.88.0: `additionalFeatures`
   reaches `JQ` un-substituted, while a config's own `features` block is
   substituted with the config). So devc could not pass
   `${containerWorkspaceFolder}` through it, and the option would exist for
   nobody.

A monorepo puts one hook at the workspace root and dispatches from inside it —
that is a shell script's job, not an option's. See "Not in this plan".

### `features/project-hook/install.sh`

Runs as root at image build time and does exactly one thing: place the
create-time script.

- `SHARE_DIR="${SHARE_DIR:-/usr/local/share/devc-features/project-hook}"` —
  the Feature namespace, overridable for a test harness. `/usr/local/share/devc/`
  is devc's baseline namespace and no Feature writes into it.
- `cp` `post-create.sh` into `$SHARE_DIR/post-create.sh`, `chmod 0755`. Plain
  `cp` rather than `install -o root`, matching the other Features, so the script
  still runs unprivileged in a harness.
- **No `chown` of anything.** The create-time hook runs as the remote user but
  only ever _reads_ `$SHARE_DIR`. Nothing here is written to at create time, so
  the `dirs/` handover `bash-config` needs has no analogue.
- Nothing appended to `~/.bashrc`, no directories created, no `containerEnv`.
- **No `DEVC_TOOLS_RELEASE` pin.** This Feature fetches nothing; per
  `features/README.md#versions`, a Feature that downloads nothing must not be
  made to invent a release version.

### `features/project-hook/post-create.sh`

A `#!/bin/bash` header, a Feature-specific comment block, then the
`devc:project-hook` fenced region **copied verbatim** from
`devc-core/default/scripts/project-hook.sh`:

```sh
# devc:project-hook (start)
set -e
PROJECT_ROOT="${PROJECT_PATH:-$PWD}"
cd "$PROJECT_ROOT"
for candidate in \
  "$PROJECT_ROOT/.devc/devc-post-create.sh" \
  "$PROJECT_ROOT/.devcontainer/devc-post-create.sh"; do
  ...
done
# devc:project-hook (end)
```

Load-bearing details of that block, none of which may be "cleaned up" in the
copy:

- **`set -e` is inside the fence.** The harness runs the extracted block as its
  own script, and cases 4, 5 and 7 assert a non-zero exit.
- **`${PROJECT_PATH:-$PWD}`.** `PROJECT_PATH` is devc's `remoteEnv`; a non-devc
  consumer has none, and the fallback carries the weight — the CLI runs every
  lifecycle hook, Feature-declared ones included, with cwd at the remote
  workspace folder. Same reasoning `node-nvmrc/post-create.sh` documents, and the
  `with_hook` scenario below is what actually measures it.
- **The explicit `cd`.** In devc's baseline each `post-create.sh` step is its own
  `bash` process, so the block establishes the project cwd itself. It stays for
  the Feature too — case 8 asserts the hook's own cwd is the project root.
- **`[ -e ] || [ -L ]`.** A dangling symlink must reach the not-executable error
  rather than be skipped as absent (case 5).
- **`break` after the first hit.** No fall-through, including from a
  present-but-unrunnable `.devc/` hook to a perfectly good `.devcontainer/` one
  (cases 3 and 4).

The Feature-specific header must say: that the fence is a contract shared with
`devc-core/default/scripts/project-hook.sh` and with
`devc/tests/project_hook_test.sh`; that the CLI runs this **as the remote user**;
and that a Feature-declared `postCreateCommand` runs **before** the one the
consumer's own `devcontainer.json` declares.

### `features/project-hook/README.md`

Must carry, beyond the usual:

- **The project's side of the contract**, which is the entire configuration
  surface: create `.devc/devc-post-create.sh` (or `.devcontainer/`), `chmod +x`
  it, commit it. It runs with cwd at the project root and its exit code fails
  container create.
- **No mount recipe** — and say so explicitly. Every other Feature's README has
  one; this one's absence is a property worth naming rather than an omission a
  reader has to notice.
- **Ordering.** This hook runs before the consumer's own `postCreateCommand`,
  and before any Feature that `installsAfter` it. A hook that needs the project's
  own create-time setup to have happened first is in the wrong place.
- **The double-run hazard, prominently.** During the interim, devc's baseline
  still runs its own copy from `post-create.sh`, so a **devc** container that also
  enables this Feature runs the project's hook **twice**. Unlike `shell-dirs`,
  there is no guard available: the sourcing-idempotence trick
  (`_DEVC_SHELL_DIRS_DONE`) works because both copies run in one shell, while
  these are two separate create-time processes — and the Feature runs _first_, so
  it cannot detect the copy that has not run yet. A project's
  `devc-post-create.sh` is arbitrary and need not be idempotent, so this is
  stated as "do not enable this in a devc container until the swap lands", not as
  a caveat. Mirror the shape of `features/README.md`'s
  `bash-config` supersedes `shell-dirs` note.

## Concept boundaries

- **`project-hook` (the Feature, the runner) vs `devc-post-create.sh` (the
  project's script, the thing being run).** These are not two names for one
  thing and the plan is unreadable if they blur: the Feature is devc's mechanism
  moving out, `devc-post-create.sh` is the project's extension point and is not
  moving anywhere. Nothing in this plan creates, renames, or relocates a
  `devc-post-create.sh`.
- **`features/project-hook/post-create.sh` (this Feature's create-time script)
  vs `devc-core/default/post-create.sh` (devc's baseline orchestrator) vs
  `devc-core/default/scripts/project-hook.sh` (devc's copy of the runner).**
  Three files, similar names, all live at once during the interim. Each file's
  header must say which of the three it is.
- **The `devc:project-hook` fence marker names a _block_, not an owner.** It
  keeps the `devc:` prefix in the Feature's copy — that is what makes
  `project_hook_test.sh` run against both. Do not rename it to
  `project-hook:` for tidiness.
- **`/usr/local/share/devc-features/project-hook/` (this Feature) vs
  `/usr/local/share/devc/scripts/` (devc's baked baseline).** Not sharing the
  prefix is what keeps "did devc put this here, or a Feature?" answerable.

## Checklist

- [x] `features/project-hook/devcontainer-feature.json` — id, `0.1.0`, name,
      description, doc/license URLs, `postCreateCommand`; no `options`
- [x] `features/project-hook/install.sh` — `SHARE_DIR`, place + `chmod 0755`,
      nothing else; no release pin
- [x] `features/project-hook/post-create.sh` — Feature header + the
      `devc:project-hook` fence copied byte-for-byte
- [x] `features/project-hook/README.md` — the project's side of the contract,
      the deliberate absence of a mount recipe, the ordering note, the double-run
      hazard
- [x] `features/project-hook/test/test.sh` — the bare `{}` scenario
- [x] `features/project-hook/test/scenarios.json` — `with_hook`,
      `devcontainer_dir_hook`
- [x] `features/project-hook/test/with_hook.sh`,
      `features/project-hook/test/devcontainer_dir_hook.sh`
- [x] `features/project-hook/test/run-features-test.sh` — copied unchanged from
      another Feature (it derives the id from its own path)
- [x] `features/README.md` — Published Features row, and the double-run note
      alongside the existing `bash-config`/`shell-dirs` one
- [x] `devc/README.md` — add the Feature copy to the fence-harness list, matching
      how `shell_dirs_test.sh`'s two copies are listed
- [ ] `features/PUBLISH_ALLOWLIST.txt` — add `project-hook` (**last**, once the
      validation below is green; the allowlist is the gate, so adding it early is
      the one way to publish a half-finished Feature) — **deferred: the
      container-dependent validation below could not run (no Docker in this
      environment), so the plan's own precondition for this step is not met.
      See the completion note in `.plans/PLAN.md`.**
- [x] `.plans/PLAN.md` — register

## Validation

- [x] `bash devc/tests/project_hook_test.sh features/project-hook/post-create.sh`
      — **the drift guard, and the most important item here.** All 8 cases pass
      against the Feature's copy with the harness unmodified. If the harness needs
      any edit to pass, the copy has drifted and the fix is the copy, not the
      harness.
- [x] `bash devc/tests/project_hook_test.sh devc-core/default/scripts/project-hook.sh`
      — still green, unchanged. Proves the copy did not require a harness change
      that would have broken devc's original.
- [x] `diff` of the two fenced regions is empty — extract with the same `awk`
      the harness uses, and expect byte equality.
- [x] `bash tests/features_test.sh --feature project-hook` — id matches the
      directory, version parses as semver, name and description non-empty.
- [x] `bash tests/features_test.sh` — whole collection still green.
- [ ] (needs Docker, NOT RUN — no Docker in this environment)
      `bash features/project-hook/test/run-features-test.sh` —
      the bare `{}` default scenario: `post-create.sh` is installed at the
      manifest's path, is executable and root-owned; **create succeeded with no
      hook present at all**, which is the inert case; nothing was appended to
      `~/.bashrc`; and running the script by hand in a temp dir with
      `env -u PROJECT_PATH` is a silent no-op that exits 0.
- [ ] (needs Docker, NOT RUN — no Docker in this environment) the `with_hook`
      scenario — its `onCreateCommand` writes an
      executable `.devc/devc-post-create.sh` at
      `${containerWorkspaceFolder}` that touches a marker and records its cwd;
      `onCreateCommand` runs before **every** `postCreateCommand`, which is the
      only way to have a fixture in place before this Feature's hook looks for
      one. Asserts the marker exists and the recorded cwd is the workspace
      folder. **This is what measures the lifecycle-hook cwd question** that
      `.plans/design/devc-feature-split.md` open question 1 has only ever read
      from the CLI source: if the hook did not run with cwd at the workspace
      folder, `${PROJECT_PATH:-$PWD}` resolved somewhere else and the marker is
      absent.
- [ ] (needs Docker, NOT RUN — no Docker in this environment) the
      `devcontainer_dir_hook` scenario — the same, with the
      hook at `.devcontainer/devc-post-create.sh`, proving the second candidate is
      reachable in a real container.
- [x] `deno fmt --check` clean.

The failure paths — non-executable, dangling symlink, hook exits non-zero, no
fall-through — are **not** container scenarios and deliberately so:
`devcontainer features test` has no way to assert that a create _failed_, since a
failing `postCreateCommand` aborts the run it would report from. Those five cases
are exactly what `project_hook_test.sh` covers offline, which is why the first
validation item carries the weight it does.

## Not in this plan

- **Any edit to `devc-core/`.** `default/scripts/project-hook.sh`,
  `default/post-create.sh`, the `Dockerfile` `COPY`, and
  `default_config.ts`'s `postCreateCommand` rewrite all stay exactly as they are.
- **Any devc integration.** devc does not inject this Feature, does not merge it
  into `overlay.additionalFeatures`, and gains no opt-out flag. That plan gets
  written after this one is published, and it has its own open questions —
  version pinning (`:0` vs the exact version devc shipped with), the opt-out
  surface, and the fact that `KQ` in the pinned CLI matches an
  additional-features id by **exact string**, so a differently-spelled id in a
  consumer's own config installs the Feature twice rather than overriding it.
- **A `projectDir` option.** Argued above: it would break the fence's
  byte-identity, and devc could not set it through `--additional-features`
  anyway. If a real monorepo case turns up, it arrives as `0.2.0` with the option
  applied _outside_ the fence — by resolving a root and `cd`-ing to it before the
  block runs — and with an answer to the footgun that the obvious implementation
  (exporting a rewritten `PROJECT_PATH`) hands the project's own hook a
  `PROJECT_PATH` that is not the workspace root.
- **Configurable hook filenames or a hook directory** (`devc-post-create.d/`).
  The two candidate paths are devc's existing contract and stay fixed.
- **Any other lifecycle hook.** No `postStartCommand`, no
  `devc-post-start.sh`. Create time only, matching what devc does today.
- **Retiring devc's copy.** That is the swap, and it cannot land until this
  Feature is published — a baseline referencing an unpublished `ghcr.io` ref
  breaks every `devc up`, the failure
  `.plans/archived/devc-bridge-feature.md` already had to reverse once.
