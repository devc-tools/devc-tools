# devc-config (devcontainer Feature)

On every container create, runs **your own** create-time script if you have
committed one, and appends devc's own bash prompt/title customization to
`~/.bashrc`. `"devc-config": {}` is the complete install — the project-hook
half configures nothing on its own until you add a script; the bash-prompt
half is unconditional (see [Bash prompt/title](#bash-prompttitle-devcbashrc-additions)).

```jsonc
"features": {
  "ghcr.io/devc-tools/features/devc-config:0": {}
}
```

No mounts, no options, no host state, no network. This is the cleanest
standalone Feature in the collection: it reads the workspace and nothing else.

> The tag tracks **this Feature's own** version line, not the repo's — see
> [../README.md#versions](../README.md#versions). It is `:0` while this
> Feature is pre-1.0.

## No mount recipe

Unlike every other Feature in this collection, there is nothing to mount.
Worth saying explicitly rather than leaving you to notice the absence: your
create-time script lives in your own repo, at a path this Feature only reads —
there is no host state to bring in and no `initializeCommand` recipe to paste.

## Your side of the contract

Create one of these, `chmod +x` it, and commit it:

- `.devc/devc-post-create.sh`, or
- `.devcontainer/devc-post-create.sh`

Both locations are first-class; `.devc/` is checked first, `.devcontainer/`
second, and the first one that **exists** wins — nothing runs both. It runs
with cwd set to your project root, so it can use paths relative to the repo,
and its exit code fails container create: a script that fails create is doing
its job, not misbehaving.

If the file exists but is **not executable** (or is a dangling symlink),
create fails naming the path — it is never silently skipped. A hook that
exists either runs or fails the build; there is no path on which an existing
hook is quietly ignored in favor of the other candidate.

If neither path exists, this Feature does nothing at all, silently. That is
the point of a bare `{}`: safe to enable in a repo that has not written a hook
yet.

## Ordering

This hook runs **before** your own `devcontainer.json`'s `postCreateCommand`,
and before any Feature that declares `installsAfter: ["devc-config"]`. A
hook that needs the project's own create-time setup to have already happened —
`npm ci`, a generated config file, anything a later step depends on — is in
the wrong place if it is written expecting to run first among equals; it runs
first, full stop.

**This Feature itself declares `installsAfter: ["…/agents",
"…/git-container-config"]`** — devc's own choice, made here because devc is
the one consumer of this Feature that also declares those two. It has an
effect only when a consumer's config declares at least one of them alongside
`devc-config`; declaring `devc-config` alone (the common case for a non-devc
consumer) is unaffected. When it does apply, both run first — so a hook that
expects `~/.claude` or git identity already set up (as devc's own does) can
rely on it.

## What it does

At **build time** (as root) it places one file and touches nothing else:
`/usr/local/share/devc-features/devc-config/post-create.sh`. No options
cross into it — there is nothing to bake, since this Feature has none.

At **create time** (as the **remote user**) that one file runs two fenced
blocks in order, `devc:devc-config` then `devc:bashrc-additions`:

1. It looks for your hook, in order, and runs the first one it finds:

   - `${PROJECT_PATH:-$PWD}/.devc/devc-post-create.sh`
   - `${PROJECT_PATH:-$PWD}/.devcontainer/devc-post-create.sh`

   `PROJECT_PATH` is devc's own `remoteEnv`; a non-devc consumer has none,
   and the `$PWD` fallback carries the weight — the devcontainer CLI runs
   every lifecycle hook, Feature-declared ones included, with cwd set to the
   remote workspace folder.
2. It appends devc's own bash prompt/title block to `~/.bashrc`, marker-
   guarded so a second create does not double-append — see
   [Bash prompt/title](#bash-prompttitle-devcbashrc-additions) below.

## Bash prompt/title (`devc:bashrc-additions`)

**Unconditional — no option, no fixture, no opt-out at the Feature level.**
Every container this Feature installs into gets a `# >>> devc bashrc-additions >>>`
block appended to the remote user's `~/.bashrc`, marker-guarded so re-running
`post-create.sh` (or a container restart) does not double-append:

- A custom `PS1` — folder name, git branch, exit-status coloring.
- The terminal title set to the project name (`$PROJECT_PATH` or `$PWD`),
  overriding the devcontainers base image's own command-title trap.
- On `devc attach` (`DEVC_ATTACH=1` in the environment), a first-prompt clear
  once shell-init output has flushed.

This is devc's own shell customization, moved here from a script devc used to
run itself (`devc-core/default/scripts/bashrc-additions.sh`, now retired) —
see [Relationship to devc](#relationship-to-devc). It is not part of "your
side of the contract" above and has no relationship to your
`devc-post-create.sh`; the two run in the same `post-create.sh` invocation,
hook first, purely because this Feature is where both pieces of
devc-specific create-time behavior live.

## No `options`, deliberately

Two reasons:

1. **The candidate paths are hardcoded inside a fenced block**
   (`devc/tests/devc_config_test.sh` extracts and runs it directly against
   this file, so the test cannot drift from the implementation). Making
   either path an option means rewriting a line inside that fence, which the
   test — not a byte-identity requirement against another copy, since this
   Feature no longer has one — would then have to bake and verify itself.
2. **A `projectDir` option — the shape `node-nvmrc` and `shell-dirs` both
   have — could not be usefully set by devc anyway.** Measured against the
   pinned `@devcontainers/cli` 0.88.0: `--additional-features` JSON is stored
   raw from argv and never passes through the CLI's substitution pass, while a
   config's own `features` block is substituted along with the rest of the
   config. So devc could not pass `${containerWorkspaceFolder}` through an
   option here even if one existed, and the option would exist for nobody.

A monorepo that wants one hook at the workspace root dispatching to
per-package logic can do that entirely inside its own
`devc-post-create.sh` — that is a shell script's job, not something this
Feature needs an option for.

## devc includes this automatically — dynamically, not baked in

**`devc up` contributes this Feature to every container it starts, with no
configuration from you.** It adds
`"ghcr.io/devc-tools/features/devc-config:0.1.0": {}` to whatever
`devcontainer.json` is in play via `--additional-features` — a project with
its own hand-written `.devcontainer/devcontainer.json` that has never heard
of devc included. See `devc/README.md`'s [Project post-create hook](https://github.com/devc-tools/devc-tools/blob/main/devc/README.md#project-post-create-hook-devc-post-createsh)
section.

**This is a reach extension, not just for the hook.** Before this Feature
carried the `devc:bashrc-additions` block, devc's prompt/title customization
only ran for configs devc materializes or writes itself (the zero-config
cache, `devc init` output). Because this Feature is injected into _every_
container `devc up` starts — project mode included — a genuinely
project-owned `.devcontainer/devcontainer.json` that devc has never touched
now gets that shell behavior too, for the first time. The same applies in
reverse: a **non-devc** consumer who declares `"devc-config": {}` in their
own config gets devc's bash prompt/title in their container too, not just
the project-hook runner — see [Bash prompt/title](#bash-prompttitle-devcbashrc-additions).

**The injection is dynamic only — devc's bundled `devcontainer.json` does
not declare this Feature itself.** Every other route into a container devc
starts (`devc up`, and the zero-config cache it materializes) still goes
through `devc up`'s own `--additional-features` injection, so nothing is
missed there. What that means concretely: `devc init` scaffolds a project's
`.devcontainer/` from the same bundled config, and that scaffolded output
does **not** carry this Feature — if you then run a plain `devcontainer up`
with `devc` uninstalled, your `devc-post-create.sh` will not run. That is
deliberate rather than an oversight: what this Feature does (running a script
you wrote specifically _for devc's own convention_) is devc-specific, so it
is fine for it to be devc-specific about how it arrives too — unlike the
Features this repo also ships that do something useful for any devcontainer
project. If you want the behavior without `devc` installed, declare
`"devc-config": {}` yourself.

**Declaring it yourself replaces devc's entry, it does not add a second
one.** devc matches by this Feature's _name_, not by exact id string: if your
own `devcontainer.json` `features`, or a `devc.json` overlay's
`additionalFeatures`, already names `devc-config` under any tag (`:0`, a
pinned `:0.1.0`, …), devc steps aside rather than installing both — which
matters because the devcontainer CLI itself dedupes `--additional-features`
against a config's `features` by **exact id string**, so two different tags of
the same Feature would otherwise both install and your hook would run twice.

To opt out of this (and every other Feature devc contributes on its own),
set `"baselineFeatures": false` in a `devc.json` overlay.

## Relationship to devc

**devc no longer carries its own copy of either fence.** The `devc:devc-config`
hook used to run from an identical `devc-core/default/scripts/project-hook.sh`,
retired when devc started injecting this Feature instead (see
`.plans/archived/devc-inject-project-hook.md`) — running both would have run
your `devc-post-create.sh` twice. `devc/tests/devc_config_test.sh` still
extracts the `devc:devc-config` fence from this Feature's `post-create.sh`
and runs it directly, so the historical drift-guard shape of the test
survives even though there is only one copy left to check it against.

The `devc:bashrc-additions` block is the same story, one plan later: it used
to be devc's own `devc-core/default/scripts/bashrc-additions.sh`, run from a
top-level `onCreateCommand` that preceded every Feature's `postCreateCommand`.
`devc-swap-baseline-features` retired that script by moving its body here —
`devc/tests/bashrc_additions_test.sh` extracts and runs the new fence the
same way, plus a whole-file case proving the two fences run in the intended
order (hook first) in one process. See
[`.plans/archived/devc-swap-baseline-features.md`](../../.plans/archived/devc-swap-baseline-features.md).

**Originally published as `project-hook`.** The Feature was renamed before
anything depended on the old id — `ghcr.io/devc-tools/features/project-hook`
was published briefly but is no longer referenced anywhere in this repo;
`devc-config` is the current and only supported id, following the same
directory-plus-every-reference rename this collection already did for
`agents` (see [../README.md](../README.md)).

## What this is not

Not a way to configure **what** the hook runs — it runs whatever you put at
one of the two fixed paths, unconditionally. Not a monorepo dispatcher — see
[No `options`, deliberately](#no-options-deliberately) above. Not a
`postStartCommand` — this is create time only, matching what devc's baseline
does today; neither the hook nor the bashrc block re-runs on every container
start. Not configurable shell customization, either — the
`devc:bashrc-additions` content is devc's own, fixed, with no option to
change or disable it short of not declaring this Feature at all.

## Tests

No Docker needed — the drift guards, and the most important tests for this
Feature:

```sh
bash devc/tests/devc_config_test.sh features/devc-config/post-create.sh
bash devc/tests/bashrc_additions_test.sh features/devc-config/post-create.sh
```

`devc_config_test.sh`, eight cases: a `.devc/` hook running, a `.devcontainer/`
hook running when `.devc/` is absent, `.devc/` winning when both are present
and executable (no fall-through), a non-executable `.devc/` failing the
create without falling through to `.devcontainer/`, a dangling symlink being
graded as a failure rather than an absence, neither path present being a
silent no-op, a hook that exits non-zero failing the block, and the hook's
cwd being the project root regardless of the caller's own cwd.

`bashrc_additions_test.sh`: the marker landing in a fresh `~/.bashrc`,
existing content surviving the append, idempotence across a second run, the
`DEVC_ATTACH` guard carrying over, and a whole-installed-`post-create.sh`
case proving the two fences run in order (hook first) in one process — the
one thing fence extraction alone cannot cover.

Needs Docker and a network:

```sh
bash features/devc-config/test/run-features-test.sh
```

The default scenario is the bare `{}` case with no hook fixture anywhere:
`post-create.sh` installed at the manifest's path, executable and
root-owned, create succeeding with the inert no-hook case, the
`devc:bashrc-additions` block landing in `~/.bashrc` regardless (it is
unconditional — see [Bash prompt/title](#bash-prompttitle-devcbashrc-additions)),
and a manual re-run with `env -u PROJECT_PATH` in a fresh temp dir being a
silent no-op. `test/scenarios.json` adds `with_hook` and
`devcontainer_dir_hook` — each writes an executable
`devc-post-create.sh` at one of the two candidate paths via the scenario's
own `onCreateCommand` (the only way to have a fixture in place before this
Feature's own `postCreateCommand` looks for it, since `devcontainer features
test` generates the workspace folder itself and copies the test directory in
only after the container is created), and asserts the marker file exists and
the hook's own recorded cwd is the workspace folder.

That last assertion is what actually measures the lifecycle-hook cwd
question `.plans/design/devc-feature-split.md` open question 1 has only ever
read from the CLI's source
([`spec-common/injectHeadless.ts`](https://github.com/devcontainers/cli/blob/main/src/spec-common/injectHeadless.ts)):
if a Feature-declared `postCreateCommand` did not run with cwd at the
workspace folder, `${PROJECT_PATH:-$PWD}` would resolve somewhere else and
the marker would be absent.

The five failure paths — non-executable, dangling symlink, a hook that exits
non-zero, no fall-through from a bad `.devc/` hook to a good `.devcontainer/`
one — are **not** container scenarios and deliberately so: `devcontainer
features test` has no way to assert that a create genuinely _failed_, since a
failing `postCreateCommand` aborts the run it would report from. Those five
cases are exactly what `devc_config_test.sh` covers offline above.

## Publishing

Published at `ghcr.io/devc-tools/features/devc-config`, on
[`features/PUBLISH_ALLOWLIST.txt`](../PUBLISH_ALLOWLIST.txt) — see
[../README.md#the-publish-allowlist](../README.md#the-publish-allowlist).
