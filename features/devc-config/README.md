# devc-config (devcontainer Feature)

Two things, on every container create: runs **your own** create-time script if you have
committed one, and adds devc's bash prompt and terminal title to `~/.bashrc`.

```jsonc
"features": {
  "ghcr.io/devc-tools/features/devc-config:0": {}
}
```

No mounts, no options, no host state, no network. It reads your workspace and nothing else.
The project-hook half configures nothing until you add a script; the prompt half is
unconditional.

> The tag tracks **this Feature's own** version line, not the devc-tools release. It is
> `:0` while this Feature is pre-1.0.

## Your side of the contract

Create one of these, `chmod +x` it, and commit it:

- `.devc/devc-post-create.sh`, or
- `.devcontainer/devc-post-create.sh`

Both locations are first-class; `.devc/` is checked first, `.devcontainer/` second, and the
first one that **exists** wins — nothing runs both. It runs with cwd set to your project
root, so it can use paths relative to the repo, and its exit code fails container create: a
script that fails create is doing its job, not misbehaving.

If the file exists but is **not executable** (or is a dangling symlink), create fails naming
the path — it is never silently skipped. A hook that exists either runs or fails the build.

If neither path exists, this Feature does nothing at all, silently. That is the point of a
bare `{}`: safe to enable in a repo that has not written a hook yet.

There is nothing to mount. Your script lives in your own repo, at a path this Feature only
reads.

## Ordering

Your hook runs **before** your own `devcontainer.json`'s `postCreateCommand`, and before
any Feature that declares `installsAfter: ["devc-config"]`. A hook that needs the project's
own create-time setup — `npm ci`, a generated config file — to have already happened is in
the wrong place; it runs first, full stop.

This Feature itself declares `installsAfter: ["…/agents", "…/git-container-config"]`, so if
your config declares either of those alongside `devc-config`, both run first — a hook that
expects `~/.claude` or your git identity to already be set up can rely on it. Declaring
`devc-config` alone is unaffected.

## Bash prompt and terminal title

**Unconditional — no option, no opt-out short of not declaring this Feature.** Every
container gets a `# >>> devc bashrc-additions >>>` block appended to `~/.bashrc`,
marker-guarded so a second create does not double-append:

- A custom `PS1` — folder name, git branch, exit-status coloring.
- The terminal title set to the project name (`$PROJECT_PATH` or `$PWD`), overriding the
  devcontainers base image's own command-title trap.
- On `devc attach` (`DEVC_ATTACH=1` in the environment), a first-prompt clear once
  shell-init output has flushed.

This is devc's own shell customization, and it is fixed — there is no option to change or
disable it. It has no relationship to your `devc-post-create.sh`; the two just happen to run
in the same invocation, hook first.

## devc includes this automatically

**`devc up` contributes this Feature to every container it starts, with no configuration
from you** — a project with its own hand-written `.devcontainer/devcontainer.json` that has
never heard of devc included. It is added dynamically via `--additional-features`, not baked
into any config file.

Two things follow from that:

- **A `devc init`-scaffolded project run with a plain `devcontainer up` and no `devc`
  installed does not get it**, so your `devc-post-create.sh` will not run. That is
  deliberate: what this Feature does — running a script written for devc's own convention —
  is devc-specific, so it is fine for it to be devc-specific about how it arrives. Declare
  `"devc-config": {}` yourself if you want the behavior without devc.
- **A non-devc consumer who declares it gets the bash prompt too**, not just the
  project-hook runner.

**Declaring it yourself replaces devc's entry, it does not add a second one.** devc matches
by this Feature's *name*, not by exact id string, so naming `devc-config` under any tag
(`:0`, a pinned `:0.1.0`, …) makes devc step aside rather than installing both — which
matters, because the devcontainer CLI dedupes `--additional-features` against a config's
`features` by exact id string, and two different tags would otherwise both install and run
your hook twice.

To opt out of this and every other Feature devc contributes on its own, set
`"baselineFeatures": false` in a `devc.json` overlay.

## What this is not

Not a way to configure **what** the hook runs — it runs whatever you put at one of the two
fixed paths, unconditionally. Not a monorepo dispatcher: a repo that wants one hook at the
workspace root dispatching to per-package logic can do that inside its own
`devc-post-create.sh`, which is a shell script's job. Not a `postStartCommand` — this is
create time only; neither the hook nor the bashrc block re-runs on every container start.
