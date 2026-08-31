# Plan Status

> Reading archived plans: they are history, not current behavior. In particular,
> plans named `devc-tui-*` describe the predecessor tool in `devc-tui/`, which
> became `devc/` — its config dir is `~/.config/devc/`, it no longer mirrors
> selections into a `.code-workspace`, and the sidebar/step wizard those plans
> built has been replaced (see `.plans/design/wizard/` for the current screens).
> Current behavior lives in `.plans/design/devc-design.md` and `devc/README.md`.

## Status

### Pending

Nothing pending right now.

### Standing rules for Feature work

Not a plan group — these are the conventions every Feature plan in this file
has inherited, kept here because they still bind new ones. The
baseline-splitting plans they were written to introduce are all complete and
archived. Read [design/devc-feature-split.md](design/devc-feature-split.md)
first: it settles, once, which pieces **can** be a Feature (a Feature can
declare no `initializeCommand`, no read-only mount, and no string mount).

- **A Feature with a host-coupled half is still not devc-only.** A host bind
  mount and an `initializeCommand` belong to the **consumer's
  `devcontainer.json`**, which every devcontainer project has; devc is one
  consumer and writes those lines for you. `devc-bridge` works exactly this way
  (it declares no mounts; non-devc projects copy one line from its README).
  Hence the rule every plan proves with a scenario: **`"<feature>": {}` must
  install cleanly and do something useful**, and no option may default to a
  devc path.
- **Copy, don't move.** A plan that extracts something out of `devc-core/default/`
  leaves it running exactly as it does today. A baseline referencing an
  unpublished `ghcr.io` ref breaks every `devc up` — the failure
  [devc-bridge-feature](archived/devc-bridge-feature.md) already had to reverse
  once. The swap onto the published Features has now landed — see
  [devc-swap-baseline-features](archived/devc-swap-baseline-features.md) in
  Completed below — but the rule still holds for anything not yet swapped.
- **A new Feature starts at its own `0.1.0`**, not the repo's version —
  [feature-independent-versions](archived/feature-independent-versions.md)
  unpinned Features from the `v*` tag. Bump a Feature's `version` in the commit
  that changes it; a push to `main` under `features/` publishes it from its own
  matrix job, gated by `features/PUBLISH_ALLOWLIST.txt`.
- **Adding a Feature is just adding a directory.**
  [features-collection](archived/features-collection.md) made `features/` a real
  collection: no edit to `publish-feature.yml`, and `features/README.md` gains a
  row.
- **Break a Feature before devc consumes it, not after.** Once devc's bundled
  config declares a Feature at the floating `:0` tag and that config is baked
  into a released binary, `:0` floats forward into every already-shipped binary
  on its users' next container create — so a breaking change then needs a
  coordinated release or a deprecation window. `agents` `0.2.0` took this
  window; `feature-git-container-config-fixed-identity` above is sequenced to
  take it too.

### Completed

- [devc-merged-config](archived/devc-merged-config.md) — ✅ Done, code
  complete and offline-tested; the nine Docker-needed items in
  [docs/manual-verification.md §11](../docs/manual-verification.md) are unrun
  (no Docker in this environment), same standing as other entries below.

  The `devc.json` overlay is no longer translated into `devcontainer up` flags.
  devc merges four layers — `devc → base config → user devc.json → project
  devc.json` — into one effective `devcontainer.json`, writes it to
  `~/.cache/devc/projects/<key>/`, and hands that to the CLI: as
  `--override-config` in project mode (which keeps relative paths and both
  container-identity labels anchored to the project's own config, so nothing
  churns) and as `--config` in zero-config mode. Nothing is written into the
  project; the standalone invariant is untouched.

  New `devc-core/merge.ts` (objects recurse, arrays append, `mounts` dedupe by
  target, `null` deletes, `$replace` opts out) and `devc-core/merged_config.ts`
  (`ensureMergedConfig`, atomic `0600` write, per-project stable path). An
  overlay may now set **any** `devcontainer.json` key, `readonly` mounts
  included, and can replace or delete what the base config declares.

  It deletes more than it adds: `overlayArgs`, `MOUNT_SPEC_RE`,
  `isEmptyOverlay`, `computeContainerWorkspaceFolder` (a hand-port of the CLI's
  worktree-path algorithm — the CLI resolves `${containerWorkspaceFolder}`
  itself inside a config file), `resolveOverlayRemoteEnv`,
  `loadDeclaredFeatureIds`, `injectBridgeMount` and its fence, and the
  per-project `bridge` flag on the config cache key. The devc-bridge token mount
  became a merge layer, which makes it work in **project mode** for the first
  time — those users used to copy the line into their own `devcontainer.json`.

  **No backward compatibility, by decision**: no migration for the one-time
  zero-config container recreate, no `additionalFeatures` alias (the key is
  `features`), no fallback when a base config cannot be parsed — that is a hard
  error naming the file. `devc up --print-config` is new, and is how you read
  the effective config now that it lives in a cache rather than in the project.

- [herdr-agent-sidecar](archived/herdr-agent-sidecar.md) — ✅ Done, code
  complete and offline-tested; the six Docker+Herdr-needed items in the
  plan's own Validation list are unrun (no Docker, no Herdr pane in this
  environment), same standing as other entries below.

  A `devc attach`/`devc claude` running in a [Herdr](https://herdr.dev) pane
  now shows the agent actually running _inside_ the container, with Herdr's
  own idle/working/blocked status, and shows none when the container shell
  is at a bare prompt — gated entirely on environment (`HERDR_ENV=1`,
  `HERDR_AGENT` unset, `DEVC_HERDR_AGENT` not `off`), no new CLI flag. New
  `devc/herdr.ts` holds the gate (`herdrMode`), the command-line → Herdr-kind
  mapping (`herdrAgentKindFor`, 18 kinds), `sidecarArgv` (mirrors
  `devcontainerArgv`'s self-exec shape), the watcher script builder, and the
  spawn/rotate/kill lifecycle (`startHerdrSidecar`). `main.ts` dispatches the
  hidden `__herdr-sidecar` subcommand beside `__devcontainer`; `attach.ts`
  emits the `DEVC_HERDR_WATCH` marker env var, starts the watcher + sidecar
  seeded from `options.command`, and tears both down in its existing
  `finally` alongside `resetColors()`.

  **One deliberate deviation from the plan's literal watcher script**: the
  plan's pseudocode reads the marker id via `id=$1` on a `sh -c '<script>'
  <id>` invocation, but a single trailing operand to `sh -c` becomes `$0`,
  not `$1` (verified empirically here — `sh -c 'echo $0 $1' foo` prints
  `foo` with `$1` empty). `herdrWatcherScript` bakes the id directly into
  the `grep` pattern at build time instead (it's a `crypto.randomUUID()`,
  always shell-safe to splice in unquoted), sidestepping the off-by-one
  entirely while keeping every other parsing detail — `tpgid` via
  `cut -d')' -f2-`, reading `/proc/<tpgid>/cmdline` never `ps -g`, the two
  `exit 0` self-termination arms — verbatim from the plan.

  New `devc/tests/herdr_test.ts` (22 cases): the gate's three modes, every
  `herdrAgentKindFor` case the plan's Validation section names (interpreter
  re-take, `gh copilot`, a kind whose manifest id differs from its command
  name, shell/empty/unlisted → `null`), `sidecarArgv`'s both branches with a
  test that fails if `--allow-env` is dropped, the watcher script containing
  the marker and both `exit 0` arms, the rotator's kill-before-spawn
  ordering (below), and the sidecar body actually exiting 0 on stdin EOF
  (spawns the real `__herdr-sidecar` subcommand with closed stdin — provable
  without Docker).

  **Same-day follow-up, user-reported**: "notable lag" in a real Herdr pane
  when an agent showed up or switched. Root cause was a deviation from the
  plan's own "Rotation and teardown" section — kill the current child and
  _await its status_ before spawning the new one, sequential — that the
  first pass got backwards: it spawned the new sidecar immediately and
  killed the old one asynchronously in the background, so for a brief
  window two sidecars asserted different `HERDR_AGENT` values in the same
  process group, exactly the "undefined, resolves unpredictably" double-
  assertion case the plan's own measurement #3 warns about. Fixed with
  `createSidecarRotator`, which chains every kind change onto one pending
  promise so a kill is always fully awaited before the next spawn. 5 of the
  22 test cases above are regression tests for this ordering (fake
  spawn/kill functions, an artificially slow kill, and the `stop()`-races-a-
  fresh-transition edge case). See the plan doc's own follow-up note for the
  full account.

  Verified here, offline: `cd devc && deno task check && deno task test`
  (113 passed, up from 91 — **red → green**); `deno fmt --check` (169 files,
  clean).

  **Not verified here (no Docker, no Herdr):** all six Docker+Herdr-needed
  items in the plan's own Validation list — the main case (agent appears/
  disappears with a live Claude session), rotation between two agents, the
  `HERDR_AGENT=claude` deference regression guard, the `DEVC_HERDR_AGENT=off`/
  `=<kind>` switches, no leaked `__herdr-sidecar`/watcher process after
  ctrl+c or `SIGKILL`, and the pane staying clean under a full-screen agent.
  All added to `docs/manual-verification.md` §10 for the next Docker+Herdr
  session.

  `devc/README.md` gained a "Herdr integration" subsection under
  `## How it works`, documenting the three env vars and that state still
  comes from Herdr's own manifests.

- [devc-swap-baseline-features](archived/devc-swap-baseline-features.md) —
  ✅ Done, code complete and offline-tested; six Docker-needed items in the
  plan's own Validation list are unrun (no Docker in this environment), same
  standing as the other entries below.

  Three of `devc-core/default/scripts/`'s four remaining baseline steps are
  gone as devc's own scripts. `agents-setup.sh` and `git-setup.sh` are
  retired onto the already-published `agents`/`git-container-config`
  Features, declared statically in the bundled `devcontainer.json`
  (`agents:0` with `installCopilotCli: true`; `git-container-config:0` bare
  `{}`) — the same treatment `bash-config`/`node-nvmrc` already get.
  `bashrc-additions.sh` does **not** retire the same way: its content (the
  custom `PS1`, terminal-title trap, `DEVC_ATTACH` first-prompt clear) moved
  _into_ `devc-config`'s `post-create.sh` as a second fence
  (`devc:bashrc-additions`, project-hook fence first), since `devc-config` is
  the one Feature devc dynamically injects into every container it starts —
  this is what makes devc's prompt/title behavior reach a project-mode repo
  for the first time. `devc-config` bumped to `0.2.0` (`installsAfter`
  gained, plus the new fence), with `overlay.ts`'s `DEVC_CONFIG_FEATURE`
  moved in step. With all three scripts gone, `devc-core/default/scripts/`,
  `post-create.sh` and the bundled config's `onCreateCommand` are removed
  outright, along with the Dockerfile's Claude/Copilot CLI install steps
  (the `agents` Feature's `install.sh` does that now) — the Dockerfile
  itself survives, holding only the base image and the `ripgrep` install,
  per the plan's own explicit instruction not to remove it here.

  This reopens the ordering question `devc-inject-project-hook` deferred:
  with all three baseline steps now Features running in the same phase as
  the injected `devc-config`, the phase-level `onCreateCommand`-before-
  `postCreateCommand` trick no longer has anything to apply to.
  `devc-config`'s manifest instead gains
  `"installsAfter": ["…/agents", "…/git-container-config"]`, restoring the
  same guarantee via Feature-to-Feature ordering. The `claude-json-*` volume
  is dropped outright (not retargeted) — `agents` `0.2.0`'s fold of
  `~/.claude.json` into `~/.claude` left nothing for it to back — at the
  cost of one re-login per workspace, accepted deliberately; the orphaned
  volumes are left for `docker volume prune`. The `claude-seed` and identity
  binds retarget onto the two Features' fixed mount points.

  **"Move the content" was not "paste the file."** The `devc:bashrc-additions`
  fence differs from `bashrc-additions.sh`'s body in the four ways the plan's
  Contracts demanded: no `#!/bin/bash` shebang, the `grep -qF … && exit 0`
  short-circuit converted to an `if … ; then … fi` guard (an `exit 0` inside
  a fence that is no longer a script's own would have silently ended
  `devc-config`'s whole `post-create.sh`), `BASHRC="$HOME/.bashrc"` kept as a
  bare start-of-line assignment (the harness re-points it exactly like
  `seed_link_test.sh` re-points `SEED=`/`CLAUDE_DIR=`), and no second
  `set -e` in the new fence — `set -e` now sits once at the top of the file
  plus once more inside the pre-existing `devc:devc-config` fence (kept
  there so the fence-extraction test, which runs the block as its own
  process with nothing else providing it, keeps working unmodified — proven
  by running `devc_config_test.sh` unchanged against the edited file, still
  8/8).

  New offline harness `devc/tests/bashrc_additions_test.sh` (5 cases):
  fresh-`$HOME` append, existing-content preservation, second-run
  idempotence, the `DEVC_ATTACH` guard surviving the move, and — the one
  case fence extraction alone cannot cover — running the **whole installed**
  `post-create.sh` (via a real `install.sh` run into a temp `SHARE_DIR`,
  same shape `git_config_test.sh` uses) against a temp `$HOME` with a
  project hook that asserts the bashrc marker is _not yet_ present when it
  runs, proving the project-hook-first, bashrc-additions-last order in one
  process rather than two independently-passing fragments. **Deliberately
  broken to confirm it has teeth**: swapping the two fences' order in
  `post-create.sh` fails exactly that case (`exit 0`/`project hook ran`),
  restored to green.

  Verified here, offline: `cd devc-core && deno task check && deno task test`
  (245 passed, 19 steps — **red → green**, the pre-existing 3 `node-setup.sh`
  failures the plan's own Validation section named as not-this-plan's-fault
  are fixed for free by the same file-list edits this plan needed anyway);
  `cd devc && deno task check && deno task test` (91 passed, unaffected);
  `bash devc/tests/seed_link_test.sh features/agents/post-create.sh` (6
  cases, now the only copy — devc's own `agents-setup.sh` is deleted);
  `bash devc/tests/devc_config_test.sh features/devc-config/post-create.sh`
  (8 cases, unmoved fence, still green); `bash
  devc/tests/bashrc_additions_test.sh features/devc-config/post-create.sh`
  (new, 5 cases, all green, deliberate-break proof above);
  `bash tests/workflow_guards_test.sh` (the existing `devc_config_pin_agrees`
  guard confirms `overlay.ts` and the manifest agree at `0.2.0`, ALL PASS);
  `bash tests/features_test.sh` (6 Features in scope, ALL PASS); `deno fmt
  --check` (166 files, clean).

  **Not verified here (no Docker):** all six Docker-needed items in the
  plan's own Validation list — whether `agents` derives `~/.claude` as
  `/home/vscode/.claude` for this base image/remote user, the zero-config
  end-to-end round trip, the `installsAfter` ordering claim against a real
  daemon, `devc init` output still provisioning standalone with no `devc` on
  `PATH`, the bashrc-additions reach extension actually showing up in a
  project-mode container's interactive shell, and rebuild churn being
  one-time rather than recurring. All added to `docs/manual-verification.md`
  §9 for the next Docker-host session, alongside a correction to that doc's
  own pre-existing baseline block (it pointed `seed_link_test.sh` and
  `shell_dirs_test.sh` at paths under `devc/default/scripts/` that never
  existed in this repo's current layout — not this plan's regression, fixed
  for the two commands this plan's own changes made current; `shell_dirs_test.sh`
  has no working copy left to run against at all, since the `shell-dirs`
  Feature it tested was superseded by `bash-config` in an earlier plan, so
  that line is dropped with a note rather than pointed at a fiction).

  Docs updated alongside the code: `devc/README.md` (Claude config / Git
  setup prose repointed at the two Features, the `~/.claude.json` fold and
  its one-re-login cost documented, the fence-harness list updated),
  `features/agents/README.md` and `features/git-container-config/README.md`
  (their "Relationship to devc" sections rewritten from "not yet swapped" to
  past tense, since this plan is what they were waiting on), and
  `.plans/design/devc-design.md` (the "Bundled default" section rewritten
  for the Feature-based baseline — this repo's own master index names it an
  authoritative current-behavior doc, so it could not be left describing a
  `post-create.sh`/`scripts/` orchestrator that no longer exists).

- [feature-git-container-config-fixed-identity](archived/feature-git-container-config-fixed-identity.md)
  — ✅ Done, code complete and offline-tested; the two Docker-needed items in
  the plan's own Validation list are unrun (no Docker in this environment),
  same standing as [devc-embedded-devcontainer-cli](archived/devc-embedded-devcontainer-cli.md)
  below.

  `git-container-config` `0.2.0` drops `identityIncludePath` for a fixed
  `identity/gitconfig` mount point, the same change `agents` `0.2.0` made to
  `seedDir`/`claudeJsonDir` and the `bash-config` `dirs/user` shape: mount onto
  a known path rather than tell the Feature where you mounted. Its four
  remaining options (`lfsFilters`, `lfsSkipSmudge`, `worktreeRelativePaths`,
  `safeDirectory`) are all behavior switches, none naming a path. Landed
  before [devc-swap-baseline-features](archived/devc-swap-baseline-features.md), as
  required — devc consumed neither Feature yet, so the breaking change was
  free. That plan's Contracts and mounts section were amended in the same
  pass to declare a bare `{}` and retarget the identity bind.

  `install.sh` now creates `identity/` empty at build time instead of baking
  the option; `post-create.sh`'s step 1 collapsed to a single `-f` test
  against the fixed path, and the named-but-missing-file warning is gone (a
  fixed mount point can't distinguish "nothing mounted" from "mounted empty").
  `test/git_config_test.sh`'s identity cases re-key onto placing a file at
  `$SHARE/identity/gitconfig` via a sed-rewritten hook copy, the same
  technique `agents`' `claude_json_test.sh` uses for `SEED`; all 42 checks
  pass. `test/test.sh` and `test/scenarios.json`/`mounted_identity.sh` (both
  Docker-only) were updated to match but not run here.

- [devc-embedded-devcontainer-cli](archived/devc-embedded-devcontainer-cli.md) —
  ✅ Done, code complete; two items in the plan's own Validation list need a
  real Docker host and are unrun, the same standing
  [devc-inject-project-hook](archived/devc-inject-project-hook.md) below is
  filed under. (It sat in **Pending** for a while on the stricter reading that
  those two items had to clear first — moved here on 2026-08-26 to match how
  every other Docker-blocked plan in this file is filed.)

  `devc` depends on `@devcontainers/cli` as a pinned npm package embedded by
  `deno compile` (`devc/deno.json` pins `0.88.0`; `devc/devcontainer_selfexec.ts`
  is the hidden `__devcontainer` subcommand that re-execs the binary, since the
  CLI ships no programmatic API) instead of shelling out to a `devcontainer` on
  `PATH` — `docker` becomes the only prerequisite. Landed in
  `27130c2 devc: embed the devcontainer CLI instead of finding one on PATH`.

  The from-source path is tested and green, and — as of 2026-08-24, in an
  environment with `deno compile` and npm registry access — so is the compiled
  one: `./devc __devcontainer --version` prints the pinned `0.88.0` from a real
  compiled binary, and a zero-config `devc up` / `devc init` round-trips through
  the embedded CLI with `node`, `npm`, `devcontainer` and `deno` all off `PATH`,
  failing only where a Docker daemon would be needed. **Still unrun:** the same
  round trip against a real Docker daemon, and one cross-compiled target.

  It also widens devc to an unscoped `--allow-run`, forced by the host
  `initializeCommand`'s `/bin/sh -c` moving inside devc's own sandbox; the plan
  argues that trade, and reverses a note in `install.sh` that had refused it.

- [devc-inject-project-hook](archived/devc-inject-project-hook.md) — ✅ Done,
  code complete and unit-tested; the Docker-host items in the plan's own
  Validation list are unrun (see below). Its blocking precondition —
  `project-hook` being published — had already cleared by the time this plan
  was picked up: confirmed with an anonymous `ghcr.io` tag-list pull returning
  `["0","0.1","0.1.0","latest"]`, and `agents`, `bash-config` and
  `git-container-config` had likewise been published and added to
  `features/PUBLISH_ALLOWLIST.txt` since [feature-project-hook](archived/feature-project-hook.md)'s
  own entry below was written — `features/README.md` is corrected accordingly.
  devc now contributes the Feature (pinned at an **exact** `0.1.0`, not the
  floating `:0` every other bundled Feature uses — guarded by a new
  `tests/workflow_guards_test.sh` check against the manifest's own `version`)
  to every `devcontainer up`, via `overlay.ts`'s new
  `withBaselineFeatures(overlay, declaredInConfig)`, called from
  `startContainer` once the in-play config is resolved. It skips injecting
  when the overlay already names a Feature of the same name
  (`declaresFeatureNamed`, generalized out of `declaresBridgeFeature`, which is
  now a one-line wrapper over it) at **any** tag, or when the in-play config's
  own `features` already does (`loadDeclaredFeatureIds`, mirroring
  `loadResolvedRemoteEnv`'s forgiving-parse-degrades-to-`[]` shape) — closing
  the double-install hazard the pinned CLI's exact-string
  `--additional-features` dedupe would otherwise open. `DevcOverlay` gains a
  fourth key, `baselineFeatures` (default `true`), the one key where
  `mergeOverlays` is a **veto** (`user.baselineFeatures && project.baselineFeatures`)
  rather than project-wins, stated in both the doc comment and
  `devc/README.md`. This is also the swap:
  `devc-core/default/scripts/project-hook.sh` is deleted, `post-create.sh`
  drops its line, and the bundled `devcontainer.json`'s `postCreateCommand`
  becomes `onCreateCommand` so devc's baseline (agents-setup, git-setup,
  bashrc-additions) still precedes the Feature-declared `postCreateCommand`
  the CLI would otherwise run first.

  **Two corrections made on user review, before this landed on `main`, both
  folded into this same entry rather than left as a separate follow-up.**
  First: the plan's own contract said the bundled `devcontainer.json` should
  _also_ declare the Feature directly in its own `features` (not redundant
  with the dynamic injection, the plan argued, because it is what keeps
  `devc init` output standalone once `devc` is uninstalled). **Reversed.** The
  bundled config does **not** declare it — injection via
  `--additional-features` is the _only_ delivery route now, deliberately,
  because what this Feature does (running a `devc-post-create.sh` a project
  committed for devc's own convention) is devc-specific to begin with, unlike
  every other Feature this repo bundles for a plain devcontainer project. The
  cost is accepted explicitly: a `devc init`-scaffolded project run later with
  `devc` uninstalled no longer runs the hook. Second: **the Feature is renamed
  `project-hook` → `devc-config`**, following the same
  directory-plus-every-reference move this collection already made twice for
  `agents` (see [feature-claude-config](archived/feature-claude-config.md)) —
  directory, manifest `id`/`name`, the `SHARE_DIR` namespace
  (`/usr/local/share/devc-features/devc-config/`), the fence marker
  (`devc:project-hook` → `devc:devc-config`), the pin constant
  (`PROJECT_HOOK_FEATURE` → `DEVC_CONFIG_FEATURE`), the shared test harness
  (`devc/tests/project_hook_test.sh` → `devc_config_test.sh`), and every doc
  reference moved together. `project-hook` was already published to ghcr.io
  at the time of the rename (unlike `agents`' earlier renames, which happened
  pre-publish) — those tags are orphaned rather than un-published, since
  nothing can retract an OCI tag; `devc-config` is the current and only
  supported id, and `features/PUBLISH_ALLOWLIST.txt` swaps the name rather
  than adding a second one.

  **The named trap has its own test, and it caught a real design gap in its
  own first draft.** `isEmptyOverlay` must be called on the user's own
  overlay, never the post-injection effective one — after injection the
  overlay is (almost) never empty, so testing the effective one would make the
  `computeContainerWorkspaceFolder` skip branch dead and pay for its git
  subprocesses on every `up`/`exec` forever, silently.
  `devc-core/tests/start_container_trap_test.ts` proves it with no Docker: a
  fake `DevcontainerRunner` stands in for `devcontainer up`, and a fake `git`
  shim on `PATH` turns "did `computeContainerWorkspaceFolder` run" into an
  observable — `--show-cdup` is the one flag only it asks for, while
  `isGitWorktree` (which always runs) never does. **The first version of the
  test silently passed for the wrong reason**: it exercised the zero-config
  path, where the bundled config (at that point) declared the Feature in its
  own `features`, so `withBaselineFeatures` always skipped injecting it there
  and `effective` never diverged from `overlay` — the trap would go
  undetected. A project config that says nothing about the Feature is the
  only case where injection actually adds something, which is what makes
  `overlay` and `effective` different enough for the test to tell apart —
  still true, and now the _only_ case that does, since the bundled config
  never declares it at all post-correction. Confirmed both directions with a
  deliberate revert (`isEmptyOverlay(effectiveOverlay)`): the test failed,
  naming the unwanted `--show-cdup` call; restored, green again.

  Verified here, offline: `cd devc-core && deno task check && deno task test`
  (242 passed — new cases cover baseline injection under a user's
  `additionalFeatures`, name-match suppression at any tag, config-declared
  suppression, the `baselineFeatures: false` veto surviving a project's
  `true`, a non-boolean warning and defaulting rather than failing, and
  `withBaselineFeatures` not mutating its argument; 3 pre-existing
  `node-setup.sh` failures unrelated to this plan, confirmed via `git stash`
  against `main` before this branch's changes); `cd devc && deno task check &&
  deno task test` (91 passed, unaffected); `bash devc/tests/devc_config_test.sh
  features/devc-config/post-create.sh` (8 cases, now the only copy — devc's
  own copy is deleted); `bash tests/workflow_guards_test.sh` (the new pin
  guard confirmed to fail, naming both values, when a deliberate break set
  `overlay.ts`'s `DEVC_CONFIG_FEATURE` to `0.2.0` while the manifest stayed
  `0.1.0`; restored, ALL PASS); `bash tests/features_test.sh`; `deno fmt
  --check`.

  **Not verified here (no Docker):** every Docker-dependent item in the
  plan's own Validation list — project mode end-to-end (a repo with its own
  `.devcontainer/devcontainer.json` and an executable
  `.devc/devc-post-create.sh`, `.devcontainer/` byte-identical afterward),
  zero-config running the hook exactly once, the ordering proof (a hook
  seeing git identity and `~/.claude` already set up), the double-install
  case (a project pinning `:0.2.0` while devc injects `:0.1.0`, hook running
  once), `baselineFeatures: false` emitting no `--additional-features` arg,
  and — **inverted from the plan's original claim by the correction above** —
  confirming `devc init` output does **not** run the hook once `devc` is
  uninstalled. Also unmeasured, per the plan's own open questions: whether an
  existing container picks up the injected Feature without `--rebuild`,
  one-time rebuild churn on first upgrade, and offline-build behavior with
  `baselineFeatures: false` as the air-gapped escape hatch. All added to
  `docs/manual-verification.md` §8 for the next Docker-host session.

- [feature-project-hook](archived/feature-project-hook.md) — ✅ Done, split
  but not published. `features/project-hook/` runs the project's own
  `devc-post-create.sh` on every container create — `.devc/` first, then
  `.devcontainer/`, first hit wins, existence selects and executability is
  enforced. The smallest Feature in the collection: no options, no mounts, no
  host state, no network — `{}` is the entire configuration surface, and
  `install.sh` (root, build time) does nothing but `cp` + `chmod 0755` one
  file, with no `DEVC_TOOLS_RELEASE` pin since nothing is fetched. The
  `devc:project-hook` fence in `post-create.sh` is copied byte-for-byte from
  `devc-core/default/scripts/project-hook.sh` (confirmed with a real `diff`
  of the two `awk`-extracted regions — empty), and
  `devc/tests/project_hook_test.sh` runs **unmodified** against both copies:
  8 cases each, all green (`.devc/` running, `.devcontainer/` running when
  `.devc/` is absent, `.devc/` winning with no fall-through when both are
  present, a non-executable `.devc/` failing without falling through, a
  dangling symlink graded as failure not absence, neither-present as a
  silent no-op, a failing hook failing the block, and cwd = project root
  regardless of the caller's own cwd). `devc-core/` is untouched, per
  copy-don't-move; `devc/README.md`'s fence-harness list now cites both
  copies, matching how `shell_dirs_test.sh`'s two copies are listed.

  **Not added to `features/PUBLISH_ALLOWLIST.txt`, deliberately** — the
  plan's own checklist says to add it "last, once the validation below is
  green," and it is not: every container-dependent item
  (`run-features-test.sh`'s bare `{}` scenario, `with_hook`,
  `devcontainer_dir_hook`) needs Docker, which this environment does not
  have (`docker` not on `PATH`). Given the plan's own precondition is
  unmet, the allowlist addition was withheld rather than added early — the
  same reasoning `features/README.md` already gives for holding back
  `devc-bridge`, `bash-config`, `shell-dirs`, `git-container-config` and
  `agents`; `project-hook` is now a sixth name on that list, with the
  offline drift guard (the item the plan itself calls "the most important
  item here") green and recorded above.

  Verified here, offline: `bash devc/tests/project_hook_test.sh` against
  both copies (16 checks total, unmodified — the drift guard), the fence
  `diff` (empty), `bash tests/features_test.sh --feature project-hook` and
  the whole-collection run (7 Features in scope — the collection walk
  picked up the new directory with no edit), and `deno fmt --check` (166
  files, one markdown emphasis-style fix applied by `deno fmt` itself in
  the new README).

  **Not verified here (no Docker):** all three `devcontainer features test`
  scripts are written but none has run — the default `test.sh` (the bare
  `{}` inert case: install path, executable and root-owned, nothing
  appended to `~/.bashrc`, a manual re-run with `env -u PROJECT_PATH`
  staying a silent no-op) and `test/scenarios.json`'s `with_hook` and
  `devcontainer_dir_hook` (each writes an executable
  `devc-post-create.sh` at one of the two candidate paths via the
  scenario's own `onCreateCommand`, since the command generates the
  workspace folder itself and copies the test directory in only after
  create). `with_hook`/`devcontainer_dir_hook` are also what would measure
  [design/devc-feature-split.md](design/devc-feature-split.md) open
  question 1 (the cwd of a Feature-declared `postCreateCommand`) against a
  real container rather than the CLI's source — still unmeasured. What
  remains open before this can publish: running those three scenarios
  under Docker, then adding `project-hook` to
  `features/PUBLISH_ALLOWLIST.txt` once they are green.

- [feature-git-config](archived/feature-git-config.md) — ✅ Done.
  `features/git-container-config/` re-applies, on every container create, the
  user-scope git settings a devcontainer needs and cannot keep: LFS filters for
  the remote user, `worktree.useRelativePaths`, `safe.directory`, and an
  `include.path` to a mounted identity file. A bare `{}` applies the first
  three — pure container scope — and the fourth, `identityIncludePath`, is a
  dumb path option the Feature never reads or parses; `install.sh` (root,
  build time) bakes all five options into `post-create.sh`, which the
  manifest's `postCreateCommand` runs **as the remote user** at create time —
  never root, since `git config --global` writes `$HOME/.gitconfig` and the
  whole bug class here is settings landing in `/root/.gitconfig`. Copied from
  `devc-core/default/scripts/git-setup.sh` (the plan's cited
  `devc/default/scripts/git-setup.sh` had already become
  `devc-core/default/` by the time this was implemented; the Feature's README
  and this entry use the real path), which keeps running unchanged, per
  copy-don't-move. Not added to `features/PUBLISH_ALLOWLIST.txt` — this
  Feature does not publish yet.

  **A real bug was found and fixed while verifying the README's
  `initializeCommand` recipe** (the one a non-devc consumer pastes) against a
  throwaway `$HOME`: as first written, it piped `git config --get user.name`
  into `xargs -I{}`, and `xargs` applies its own quote parsing by default — a
  name containing an apostrophe (`O'Brien`, not an edge case) or a `"`
  silently lost everything from that character onward
  (`xargs: unmatched single quote`), with the recipe's own `exit 0` masking
  the failure. Fixed to `git config --null --get ... | xargs -r -0 -I{} ...`,
  which passes the value through with no shell-style interpretation at all;
  re-verified against `Jane "JD" O'Brien #1`, a bare `\`, and a `;`, each read
  back byte-for-byte, plus the plain-identity and no-identity cases, all
  exiting 0. devc's own `initialize-command.sh` never had this bug — it
  captures into a shell variable instead of piping through `xargs` — so the
  README now says "equivalent", not "identical", for the two extractions.

  Verified here, offline: `test/git_config_test.sh` (new — the real
  `install.sh` installs the real `post-create.sh` into a temp `SHARE_DIR`,
  then the installed hook runs against a temp `HOME` with `GIT_CONFIG_GLOBAL`
  isolating every read and write, plus `GIT_CONFIG_NOSYSTEM=1` and a `cd`
  away from this repo's own working tree — necessary because the hook's
  identity check deliberately has no `--global` flag and would otherwise
  resolve this repo's own local git identity instead of the case's isolated
  one). 12 cases, 40 checks: the bare hostile default (no identity, no
  git-lfs on `PATH`, both warnings on stderr, exit 0); git-lfs present via a
  stub (filters land, `--skip-smudge` on by default); `lfsSkipSmudge=false`;
  `lfsFilters=false` (git-lfs never invoked, no warning — an opt-out, not a
  misconfiguration); `worktreeRelativePaths=false` (key left unset, not set
  to `false`); `safeDirectory=""` (setting omitted entirely) and a non-default
  value passed through as-is; an identity file that exists (included first,
  the container's own settings still win, no missing-identity warning); a
  name containing `#`, `"` and `'` surviving the include verbatim; a missing
  identity file warning by name and still exiting 0; and idempotence across a
  second run and five runs (no duplicate `include.path` or `safe.directory`).
  **A deliberate break was run to prove the idempotence checks are checks, as
  this repo's convention asks**: swapping `safe.directory`'s `--replace-all`
  for a plain `--add` reintroduces duplicates across reruns and fails exactly
  those 2 checks. `tests/features_test.sh` (5 Features in scope — the
  collection walk picked the new directory up with no edit) and
  `deno fmt --check` (160 files) both pass.

  **Not verified here (no Docker):** every `devcontainer features test`
  scenario as a real container. All three are written — the default `test.sh`
  is the bare `{}` case (asserting the baked defaults and, via a manual
  second invocation of the already-run hook, both warning paths and
  `safe.directory` idempotence against the **remote user's** real
  `~/.gitconfig`), and `test/scenarios.json` adds `with_git_lfs` (the
  upstream `ghcr.io/devcontainers/features/git-lfs` Feature installed
  alongside; asserts `filter.lfs.clean`/`smudge`/`process` for the remote
  user, `--skip` present) and `mounted_identity` (an identity file written
  directly into a fixed container path by the scenario's own
  `onCreateCommand` — the same technique `shell-dirs`' `both_layers` scenario
  uses to stand in for a mount a Feature cannot declare — asserting the
  include resolves **and** that the container's own `safe.directory` wins
  over the value the identity file also sets, which is the whole reason the
  include runs first). None has been run, so what remains open is the image
  build itself (the `chown`-free root/remote-user split has never been
  exercised against a real container), whether `git-container-config` reaches
  its manifest options as documented CLI env-var names in practice, and
  whether a scenario `features` option value actually substitutes
  `${containerWorkspaceFolder}`-style expressions the way `onCreateCommand`
  strings do (side-stepped here by writing the `mounted_identity` fixture to
  a fixed absolute path instead of a workspace-relative one, so the scenario
  does not depend on the answer).

- **`agents` 0.2.0 — no path options; `~/.claude.json` folds into `~/.claude`**
  (2026-08-25). ✅ Done, no plan file — a review-driven simplification of an
  already-published Feature, small enough to implement directly. Supersedes
  much of the [feature-claude-config](archived/feature-claude-config.md) entry
  immediately below, which describes the `0.1.0` shape.

  All three path options (`claudeDir`, `seedDir`, `claudeJsonDir`) are removed.
  `~/.claude` is derived from the remote user's `$HOME` — the Claude Code CLI
  resolves its own state directory as `$CLAUDE_CONFIG_DIR` or, unset,
  `$HOME/.claude` (read out of the installed CLI's own resolver), so any other
  value pointed the Feature at a directory Claude Code never reads. The seed is
  fixed at `/usr/local/share/devc-features/agents/claude-seed`, created empty
  at build time, the `bash-config` `dirs/user` shape: a consumer mounts onto it
  rather than naming it. And `~/.claude.json` — a _sibling_ of `~/.claude` by
  the same resolver, and the one piece of state a volume mounted there would
  miss — is now unconditionally symlinked to `~/.claude/.claude.json`, so one
  volume captures everything and the second volume plus the option naming it
  are both gone. A pre-existing real file is **moved**, not deleted (the step
  is unconditional now, so an `rm` would be data loss); a symlink left by an
  older version is repointed by comparing its target, which costs one re-login.

  With no path options left, `install.sh`'s `bake()` rewriting and its
  path-option injection guard are deleted outright — nothing to bake, nothing
  to guard. Two `grep`s in `install_options_test.sh` replace the bake guard by
  asserting `install.sh` and `post-create.sh` still name the same seed path.
  The `devc:seed-link` fence is byte-identical apart from its two
  parameterizing assignments, so `devc/tests/seed_link_test.sh` runs against it
  unmodified — 20 checks, green.

  Verified here, offline: `seed_link_test.sh` (20), the rewritten
  `install_options_test.sh` (28) and `claude_json_test.sh` (27),
  `tests/features_test.sh`, `tests/workflow_guards_test.sh`, `deno fmt --check`.
  **Not verified (no Docker):** the two `devcontainer features test` scenarios,
  rewritten but unrun — `test.sh` (bare `{}`) and `with_seed` (renamed from
  `with_seed_and_json`, now passing **no** options, differing from the default
  scenario only by what its `onCreateCommand` writes into the fixed seed).

  `devc-core/default/` is deliberately untouched — devc's own `agents-setup.sh`
  still runs against its own `/usr/local/share/devc/` paths, per the
  copy-don't-move rule. Retargeting devc's seed bind and deleting its
  `claude-json-*` volume belongs to
  [devc-swap-baseline-features](archived/devc-swap-baseline-features.md), whose
  Contracts and open questions were amended in the same commit.

- [feature-claude-config](archived/feature-claude-config.md) — ✅ Done, safe
  path. **Describes `0.1.0`; see the entry above for what `0.2.0` changed.** **Renamed twice after landing, both on user feedback**: published
  first as `claude-config` per the plan's own id — the plan already installs
  a second vendor's CLI (Copilot) and says so in its own concept boundaries
  ("named for Claude specifically" vs. `agents-setup.sh`'s agents-plural
  naming) — then to `agents-config` to match `agents-setup.sh`, then
  shortened once more to plain **`agents`**. The directory, manifest `id`,
  `name`, `SHARE_DIR` namespace, and every doc/test reference moved together
  across both follow-up commits; nothing had published or depended on either
  old id. `features/agents/` installs the Claude Code CLI (and optionally
  the GitHub Copilot CLI) at build time, as the remote user into
  `~/.local/bin` — copied from `devc-core/default/Dockerfile`'s two RUN lines
  (the plan's cited `devc/default/Dockerfile` had already become
  `devc-core/default/` by the time this was implemented, same rename
  `feature-git-config` already recorded) — and at create time wires
  `~/.claude`/`~/.claude.json` to whatever persistence and seed the consumer
  has mounted. A bare `{}` installs the Claude CLI and does nothing else: no
  seed linking (`seedDir` empty), `~/.claude.json` untouched (`claudeJsonDir`
  empty), Copilot absent (`installCopilotCli` defaults false). The
  `devc:seed-link` block is copied verbatim from
  `devc-core/default/scripts/agents-setup.sh`, parameterized by SEED/CLAUDE_DIR
  exactly as it is there, so `devc/tests/seed_link_test.sh` runs against both
  copies unmodified.

  **The plan's one must-measure item could not be measured — no Docker in this
  environment either** — so the safe path it specifies for that case was
  taken rather than guessed: **no `mounts` are declared.** Whether
  `${localWorkspaceFolderBasename}` substitutes inside a Feature's own
  `mounts` (open question 2) decides whether devc's two per-workspace
  volumes (`claude-code-config-*`, `claude-json-*`) can move into the Feature
  self-sufficiently, or would instead give every project **one shared** Claude
  auth/history volume if the answer turns out to be no — worse than declaring
  nothing. The README carries the exact two-volume recipe as a paste instead
  of a default. Open question 3 (whether a first-use empty named volume
  mounted over a build-time-created, user-owned `claudeDir` inherits that
  ownership) is likewise unmeasured; `post-create.sh` keeps the
  belt-and-braces `sudo chown` regardless, per the plan's own instruction that
  this step is required independent of the answer. Both recorded as an
  explicit unmeasured note in
  [design/devc-feature-split.md](design/devc-feature-split.md) rather than
  guessed at or silently dropped.

  Verified here, offline: `devc/tests/seed_link_test.sh` against both copies
  (18 checks each, unmodified — the drift guard); new
  `test/install_options_test.sh` (40 checks: the real `install.sh` run
  repeatedly with `curl` and `runuser` stubbed on `PATH`, covering option
  baking including `claudeDir`'s empty-default resolution to
  `$_REMOTE_USER_HOME/.claude`, the path-option injection guard across all
  three path options, the already-installed idempotent skip via a real
  `command -v claude` guard — which needed the test's own `PATH` scrubbed of
  this devcontainer's real `claude`/`copilot`, since this Feature's own test
  suite runs inside a container that already has both — and that a failed
  download fails the build); new `test/claude_json_test.sh` (24 checks: the
  real, installed `post-create.sh` run against a temp `HOME` with `stat` and
  `sudo` stubbed, covering the ownership-repair step and the
  `~/.claude.json` seed/symlink/idempotence, including both with and without
  `sudo` on `PATH`). `tests/features_test.sh` (6 Features in scope — the
  collection walk picked up the new directory with no edit) and
  `deno fmt --check` (163 files) both pass. **A deliberate break was run to
  confirm the idempotence checks have teeth**: removing claude.json's
  create-only guard so every run re-seeds `{}` fails exactly the 2 checks
  that assert a prior run's own edits survive a second one.

  **Not verified here (no Docker):** every `devcontainer features test`
  scenario as a real container. All three are written — the default `test.sh`
  is the bare `{}` case (asserting the baked defaults, `claude` on `PATH`
  and executable, `~/.claude` owned by the remote user, nothing linked,
  `~/.claude.json` untouched, `copilot` absent), and `test/scenarios.json`
  adds `with_seed_and_json` (a seed and a claude.json directory written into a
  fixed container path by the scenario's own `onCreateCommand` — the same
  technique `git-container-config`'s `mounted_identity` scenario uses to
  stand in for a mount a Feature cannot declare — asserting top-level seed
  files land as symlinks, a seed subdirectory does not, and `~/.claude.json`
  becomes a symlink reading back `{}`) and `with_copilot`
  (`installCopilotCli: true` puts `copilot` on `PATH` alongside `claude`) —
  but none has been run. What that leaves unmeasured, specifically: the image
  build itself (the root/remote-user CLI-install split, and whether a real
  `su`/`runuser` behaves the way the offline harness's stub only approximates),
  the two open questions above, and — if a future measurement adds the two
  volumes — whether two containers from different workspace folders actually
  get different ones. `version` is `0.1.0` and `PUBLISH_ALLOWLIST.txt` is
  untouched, so this publishes nothing; `devc-core/default/` and
  `features/git-container-config/` are unchanged, per copy-don't-move.

- [devc-core-consumer-prep](archived/devc-core-consumer-prep.md) — ✅ Done.
  Four changes to `devc-core/`, all falling out of its first out-of-tree
  consumer (a pi coding-agent extension calling `startContainer` in-process
  inside a TUI), with `devc`'s own behavior as the bar. The real bug is closed:
  the zero-config default config is no longer `rm -rf`'d and rewritten into one
  shared `~/.cache/devc/default/` on every start, but content-addressed into
  `~/.cache/devc/default-<key>/`, keyed on a `sha256` over the bundled tree, the
  `~/.config/devc/templates` overlay and the per-project bridge flag. A hit
  writes nothing (a hash and a `stat`, cheaper than what it replaced); a miss
  stages into a sibling `.tmp-…/` and `rename`s it into place, and losing that
  `rename` to another process is treated as success. That closes the
  per-project bridge flip-flop, the version skew between two copies of core,
  and the write-under-a-reader race at once. The split the plan insisted on —
  `materializeDefaultConfig` writes unconditionally where it is told,
  `ensureDefaultConfig` is the cache — held: `tests/default_config_test.ts` is
  byte-for-byte unchanged and its 189 tests still pass, with 24 new ones
  alongside (213 in `devc-core`, 91 in `devc`). The plan's named trap was real
  and is tested directly: the `initializeCommand` path baked into the config is
  absolute, so the rewrite resolves against a new `finalDir` option naming
  where the tree will _end up_, not the staging directory it is written to —
  reverting that one expression makes exactly the trap test fail, so the test
  earns its place. The other three: a module-level `setLogger` seam (`notice` →
  `console.log`, `warning` → `console.error` by default, so the CLI sets
  nothing) replacing seven direct `console.*` sites across three modules;
  `createNodeDevcontainerRunner({ onStderr })` plus an exported
  `devcontainerJsPath()`, with `nodeDevcontainerRunner` rebound as the
  no-options instance so no importer changes, built on new optional
  `onStdout`/`onStderr` chunk callbacks in `exec.ts`'s `output()`; and the
  packaging fix — `devc-core/LICENSE` and a `repository` field with
  `"directory": "devc-core"`.

  **Byte-identical was checked the hard way**, since the stdout/stderr split is
  the whole risk in the logger change: two `deno compile` binaries (`main` and
  the branch), six invocations each (`up`, `exec`, `status`, `mounts`, `down`,
  and a second `up` for the hit path), stdout, stderr and exit code each to
  their own file, identical fresh `HOME` and project. `diff -r` is clean
  throughout once the `deno compile` VFS root and the CLI's ISO timestamp are
  normalized; the one residue is _line numbers_ inside a Deno
  uncaught-exception stack trace on `status`/`mounts`/`down`, which moved
  because `exec.ts` and `container.ts` gained lines — same frames, same
  message, same exit code. The seed-dir notice is confirmed still alone on
  stdout and the build-output dump still on stderr. The compiled binary's hash
  walk reads the bundled `default/` out of the `deno compile` VFS through
  `node:fs` and produces the same key the npm-installed tarball computes on the
  same tree, which is the cross-host stability the sorted walk exists for.
  `npm pack` + a scratch project under `env -i` confirmed `LICENSE` ships and
  that `ensureDefaultConfig` (miss, hit, and 8-way concurrent), `setLogger` and
  both runner shapes work from the installed package.

  **Two deviations from the plan, both deliberate.** The optional 30-day prune
  of stale `default-*` directories was **not** implemented, taking the plan's
  own "or do nothing; either is defensible": a hit writes nothing, so a keyed
  directory's mtime is its creation time and never advances, meaning "untouched
  for 30 days" would fire on a _live_ cache dir — and the cache dirs whose key
  differs from ours are precisely the ones belonging to the other copy of core
  this plan exists to coexist with. Pruning would `rm -rf` that copy's config
  out from under its `devcontainer up`, reintroducing the exact race the
  content-addressing removes, to reclaim ~30 KB. Second, the `setLogger`
  validation drives `overlay.ts`'s unknown-overlay-key warning and
  `default_config.ts`'s templates-`devc.json` warning (one real site per
  module) rather than the seed-dir notice, which is emitted from inside
  `startContainer` and would need a Docker daemon or surgery on a module-level
  constant to reach from a unit test; the `notice` level is covered directly,
  and the seed-dir notice's stream is proven by the byte-identical capture.

  **Not verified:** the full round trip against a real Docker daemon — this
  sandbox has none, and no `docker` binary either. Everything before the Docker
  spawn is exercised and byte-identical to `main`, but the plan's one
  user-visible claim (existing zero-config users take exactly one container
  rebuild when the cache path moves, and none on the second run) has not been
  observed against a daemon. It is documented as an upgrade note in
  `devc/README.md`.

- [devc-core-npm-library](archived/devc-core-npm-library.md) — ✅ Done.
  `devc`'s lifecycle logic (start/rebuild/stop/down, status, mounts, exec, the
  `devc.json` overlay, the config wizard's pure helpers) moved to a new
  top-level `devc-core/`, written against `node:` builtins so the exact same
  source runs on Deno and Node — verified via `deno task test` (189 tests) and
  a real `npm pack` + scratch-project `node` smoke run (`npm run smoke`), no
  Deno/`devcontainer`/`devc` on `PATH`. Publishes to npm as `@devc-tools/core`.
  `devc` itself is unchanged — same `deno compile` binary (280 tests total
  across both packages, matching the pre-split count exactly), same
  `install.sh`, same Docker-only prerequisite, consuming `devc-core` from
  source via one `@devc-tools/core/` import-map entry. The split follows the
  TTY: `main.ts`/`tui/` and the new `attach.ts` stay Deno-only CLI;
  `container.ts` was cut in half at `attachToContainer`, and the devcontainer
  CLI now runs through a `DevcontainerRunner` seam (a plain Node child process
  by default, a hidden self-exec subcommand in the CLI's compiled binary — see
  `devc/devcontainer_selfexec.ts`).

- [feature-node-nvmrc-container-wide](archived/feature-node-nvmrc-container-wide.md)
  — **not a split; a rework of a published Feature, and a breaking one.**
  `node-nvmrc` 0.1.0 selected the pinned Node in every _interactive bash_ shell,
  which is measurably the wrong audience: the `~/.bashrc` block it appended sits
  below the stock `case $- in *i*) ;; *) return;; esac` guard, so `bash -lc`,
  `sh -c`, `docker exec`, task runners and editor extension hosts got nothing
  from it, and a coding-agent CLI's tool shell is non-interactive zsh inheriting
  a PATH frozen when the CLI launched — one Node version for the whole session
  regardless of `cd`. What had been carrying the Feature was an accident:
  `nvm install` runs `nvm use` implicitly, repointing `$NVM_DIR/current`, which
  the _upstream node Feature's_ `containerEnv` happens to put on PATH. That
  symlink is container-global, so the `cd` hook actively fought the primary goal.
  0.2.0 keeps the create-time half and replaces the shell half with this
  Feature's **own** `containerEnv` PATH entry (`<share>/pin/bin`, a user-owned
  subdirectory beside a root-owned `post-create.sh`, the same split `bash-config`
  uses for `dirs/`) plus a symlink the create hook points at `$NVM_BIN` — nvm's
  own exported variable, so no version string is parsed anywhere. `autoUseOnCd`,
  the `devc:nvm-use` fence, the `cd` override and `nvm_use_test.sh` are
  **removed, not deprecated**; per-directory switching is dropped as a goal
  rather than half-served, and `projectDir` replaces it for the case that comes
  up — **one** pin, just not necessarily at the workspace root, with the whole
  hook relocating (the `.nvmrc` lookup _and_ the `node_modules` repair, one `cd`,
  both halves following one option). That makes the existing `[ -f .nvmrc ]`
  guard load-bearing rather than belt-and-braces: `nvm install` otherwise walks
  _up_ the tree and would pin the workspace root's version while appearing to
  honor the option. Two long-standing defects went with it — `nvmDir` **and**
  `projectDir` are now validated before baking (unvalidated,
  `nvmDir='/opt/n"; touch /tmp/PWNED; :"'` injected into the baked assignment
  _and passed the verify grep_, because the grep was built from the same
  unescaped value), and the bake moved from `sed` to `awk -v` + `grep -qxF`, the
  fix `shell-dirs` had already made after copying this Feature. `devc/` is
  untouched, devc's own unconditional `cd` override included.
  **One correction to the plan, recorded rather than worked around silently.**
  Its validation list claims an empty `projectDir` pins the `${VAR-}` vs
  `${VAR:-}` distinction and "fails if written the other way". It does not, and
  cannot: `projectDir`'s default is the **empty string**, and with an empty
  default the two forms are behaviorally identical — both yield `""` whether the
  variable is unset or set-but-empty. Confirmed by rewriting `install.sh` to
  `${PROJECTDIR:-}` and re-running the harness: ALL PASS. (`shell-dirs`, the
  precedent the plan cites, has a **non-empty** default, where the forms really
  do differ — that is what was carried over without re-checking.) Both forms are
  still written as specified, because the form documents the intent and survives
  someone later giving the option a default; what pins it is two checks instead
  of one — a source-form assertion that `${…-}` is literally used, plus the
  behavioral assertion that an empty value bakes as `PROJECT_DIR=""`, which is
  the one with teeth and fails the moment a non-empty default appears (confirmed:
  `${PROJECTDIR:-.}` fails 3 checks).
  Verified here, offline: the two new harnesses —
  `test/install_options_test.sh` (102 checks: every option through to the baked
  hook, the ten refusal cases across both path options, the injection case, a
  bake that cannot take, the four-file agreement on the `SHARE_DIR` literal with
  the manifest's `containerEnv` and `postCreateCommand` included, and that **no**
  startup file is created or appended to under any option combination) and
  `test/post_create_test.sh` (65 checks against a temp `SHARE_DIR`, a fake
  `nvm.sh` that exports `NVM_BIN` and logs its cwd, and a stubbed `sudo` that
  logs the cwd it was called from — the symlink and its second-run idempotency
  including the `pin/bin/bin` nesting `ln -sfn` prevents, every `projectDir`
  resolution, and the grading of all five failure paths). Plus
  `tests/features_test.sh` (18 checks, 4 Features) and `deno fmt --check` (131
  files). `bash-config`'s and `shell-dirs`' own harnesses still pass unchanged,
  which is the copy-don't-move rule holding. **Three deliberate breaks were run
  to prove the tests are tests**, as the plan demands: reverting the bake to
  `sed` + `grep -q` fails 3 checks (the `&` and `|` cases), leaving the
  `node_modules` repair at the workspace root while the `.nvmrc` lookup moves
  fails the both-directories-exist case, and — unasked for — weakening the
  `[ -f .nvmrc ]` guard so nvm could walk up fails 6.
  **Not verified here (no Docker):** every `devcontainer features test` scenario
  as a real container. All five are written — the default is the bare `{}` case
  on a base image with no nvm (the hostile one, and where the **inert** PATH
  entry is asserted), and `scenarios.json` carries `with_nvmrc` (rewritten to
  assert through `bash -c`, `sh -c`, `bash -lc` and `env -i PATH=…` rather than
  `bash -lic`), `no_nvmrc` (`pin/bin` absent, a dangling PATH entry shadowing
  nothing), `project_subdir` (`packages/app/.nvmrc` pinning 20 with **no root
  `.nvmrc`**) and `pin_outranks_current` — but none has been run. What that
  leaves unmeasured, specifically: **the image build itself** (nothing has run
  `install.sh` as root into a real `/usr/local/share`, so the `chown` of `pin/`
  to `$_REMOTE_USER` — the step that lets an unprivileged hook create a symlink
  there at all — is untested against a real remote user); **the `containerEnv`
  merge ordering**, which is the whole precedence claim and cannot be measured
  offline — whether `installsAfter` really lands this Feature's `ENV` line after
  the node Feature's, so `pin/bin` sits ahead of `…/nvm/current/bin`; and **the
  CLI's option plumbing** — that `projectDir` reaches `install.sh` as
  `PROJECTDIR`, that `""` survives as an empty string rather than being dropped,
  and that `${containerWorkspaceFolder}` substitutes inside each scenario's
  `onCreateCommand`. `pin_outranks_current` is the only scenario that can isolate
  the ordering: it moves nvm's global symlink to the other installed version
  after create and asks a fresh `bash -c 'node -v'`, because every other scenario
  would pass by accident — `nvm install` leaves `current` on the pinned version
  at create time, so both PATH entries agree until something disturbs one.
  Also still open, and still what `with_nvmrc` measures: the cwd of a
  Feature-declared `postCreateCommand` (`design/devc-feature-split.md` open
  question 1). `docs/manual-verification.md` needs no change — nothing about
  publishing moves. **`node-nvmrc` is on `features/PUBLISH_ALLOWLIST`, so the
  push that merges this to `main` publishes 0.2.0 to ghcr.io**, breaking any
  consumer pinned to `:0` who passes `autoUseOnCd` or relies on the `cd` hook;
  `:0` is the documented license for that while the Feature is pre-1.0.
- [feature-bash-config-bashrc-only](archived/feature-bash-config-bashrc-only.md)
  — **not a split; a narrowing of an unpublished Feature, and a 0.2.0.**
  `bash-config` 0.1.0 sourced both `bashrc_*.sh` from `~/.bashrc` and
  `profile_*.sh` from the login profile, but the login-profile half was never
  reaching the audience it was meant to cover: measured in this container,
  the coding-agent tool shell is non-interactive zsh, and `bash-config`'s own
  table already said a plain `bash -c` gets neither block regardless. Real
  terminals in a devcontainer are plain interactive bash, so `bashrc_*.sh`
  was already the only pathway reached day to day. 0.2.0 deletes
  `profile_*.sh`, `_bash_config_kind`, and the
  `~/.bash_profile`/`~/.bash_login`/`~/.profile` chain-detection in
  `install.sh` — the one piece of this Feature its own comments called
  genuinely destructive to get wrong — leaving a Feature that is explicitly
  cosmetic-scope only (prompt, aliases, functions), with behavior-critical
  needs still pointed at `containerEnv`/`remoteEnv` as the README already
  said. The appended `~/.bashrc` block shrinks from two lines to one; the
  once-per-shell dedup guard's key shrinks from `kind@path` to `path` alone,
  keeping only its real remaining job (`dirs/user` and `dirs/project`
  resolving to the same physical directory). Not on
  `features/PUBLISH_ALLOWLIST`, so no external consumer existed to break, and
  `version` moved to `0.2.0` anyway, on this repo's usual rule of bumping in
  the commit that changes a Feature's shape.
  Verified here, offline: `test/init_test.sh`, `test/install_options_test.sh`
  and `test/post_create_test.sh` (rewritten to drop every profile-kind case
  and the `dash` re-run, which existed only because `~/.profile` used to be
  dash-read), plus `tests/features_test.sh` and `deno fmt --check`, all
  passing. **Not verified here (no Docker):** `test/run-features-test.sh` and
  its scenarios — `test.sh` (the default scenario) was rewritten too, and one
  bug was caught by inspection rather than by running it: a first draft
  asserted `~/.profile` does not exist, which would have failed against the
  real base image, which ships `~/.profile` regardless of this Feature;
  fixed to assert the file carries no `bash-config` block instead. The
  `login_shell` scenario is deleted outright, with no replacement — the
  ceiling it used to assert under Docker (a login shell gets nothing) is now
  asserted offline instead.
- [feature-bash-config](archived/feature-bash-config.md) — **Supersedes
  `shell-dirs`**, and the one plan here that is not a split of devc's baseline:
  `ghcr.io/devc-tools/features/bash-config` sources every `bashrc_*.sh` from
  `~/.bashrc` and every `profile_*.sh` from the login profile, out of **two fixed
  container directories**. `shell-dirs` keeps its whole sourcing loop _inside_
  `~/.bashrc`, parameterized by two assignments in the middle of it, so both halves of
  that Feature rewrite lines within the block — `bake()`, two `awk` passes, four
  verification `grep`s, marker scoping, and the empty/absolute/relative policy written
  twice. **Nothing here rewrites anything.** The block is four static lines naming one
  fixed path, identical in every container the Feature is ever installed into, and all
  configuration lives in files the Feature owns outright: `config.sh` for the option
  (written by `install.sh`, sourced by the hook — not a `sed` bake, so there is no
  rewrite that can silently stop matching and no replacement-side `&`/`|` hazard),
  a **symlink** for the workspace, `env.sh` for the environment. The symlink is
  load-bearing rather than tidy: a symlinked directory globs live, which is what lets a
  constant block keep `shell-dirs`' liveness property with no path baked anywhere.
  `dirs/user/` is created empty and **never written to again** — a mount target the
  Feature never learns the origin of, so this Feature has no devc awareness at all and
  no option defaults to a devc path. Deliberately **not** pinned to
  `devc/tests/shell_dirs_test.sh`: that shared harness is precisely what forced
  `shell-dirs`' shape, so `bash-config` gets its own tests and shares none.
  Three things the plan measured rather than assumed, all of which shaped the code.
  **The login profile is whichever file bash will actually read** — the first existing
  of `~/.bash_profile`, `~/.bash_login`, `~/.profile`, with `~/.profile` created only
  when none exists. Creating `~/.bash_profile` is destructive, not additive: bash reads
  only the first of the three, so inventing it shadows the `~/.profile` the image ships
  and takes `~/.bashrc` down with it (`~/.profile:14` is what sources `~/.bashrc`). All
  four states of that chain are covered by a test. **`~/.profile` is read by dash**, so
  `init.sh` is POSIX `sh` and the offline harness runs every case a second time under
  `dash`. And **a login profile does not "fix the non-interactive case"**: it widens
  coverage to `bash -lc`/`bash -ilc` and nothing more, since plain `bash -c` reads no
  startup file at all. The README states that ceiling as a table with three
  **neither** rows and points at `containerEnv`, and both the offline harness and the
  `login_shell` scenario assert it, so the docs cannot quietly overclaim it.
  **One correction to the plan, made deliberately rather than silently.** Its contract
  for the once-per-shell guard says "keyed on the resolved path"; the implementation
  keys on **kind + resolved path**. Path alone is wrong here: in an interactive login
  shell `~/.profile` sources `~/.bashrc` partway through, so the `bashrc` pass runs
  first over these same two directories, marks them done, and would silently disable
  every `profile_*.sh` in the container — the exact
  two-audiences-not-two-ordered-layers property the plan's own measurement 4 records.
  The guard still does what the plan wanted it to do (a re-sourced `~/.bashrc`, or a
  second block over the same directory, sources each file once), and the correction is
  pinned by a test that fails when the kind is removed from the key. The path is
  resolved physically (`cd -P`), so the same directory reached through the symlink and
  by name counts once.
  One test seam beyond the plan: `init.sh` cannot discover its own location (a sourced
  file has no `$0`), so it names `dirs/` outright with a `_BASH_CONFIG_DIRS` override,
  the same shape `SHARE_DIR` is for `install.sh`. Because three files then have to
  agree on one literal path, `install_options_test.sh` asserts that agreement across
  `install.sh`, `post-create.sh`, `init.sh` and the manifest's `postCreateCommand` —
  nothing else would catch a rename.
  Verified here: `test/init_test.sh` (40 checks, the second half of them under `dash`),
  `test/install_options_test.sh` (56 checks), `test/post_create_test.sh` (42 checks),
  `tests/features_test.sh` (18 checks, 4 Features in scope — the collection walk picked
  the new directory up with no edit), `tests/workflow_guards_test.sh` (9 checks) and
  `deno fmt --check` (129 files). `shell-dirs`' and `node-nvmrc`'s own harnesses still
  pass unchanged, which is the copy-don't-move rule holding. Beyond the plan, **all
  five `devcontainer features test` scripts were executed offline** — the real
  `install.sh` run as root into the real `/usr/local/share/devc-features/bash-config`
  against a throwaway `$HOME` seeded from `/etc/skel`, the real hook run as the remote
  user with the workspace as its cwd, the test lib stubbed, and the share directory
  removed afterwards. That covers their `bash -ic`, `bash -lc`, `bash -ilc` and
  `bash -c` probes, which is what turns "the block is in the file" into "a new shell
  actually has it", and it exercised the `chown` of `dirs/` to `$_REMOTE_USER` — the
  step **open question 2** is about — by having an unprivileged hook create the symlink
  under a root-owned `/usr/local/share`.
  **Not verified here (no Docker):** every `devcontainer features test` scenario as a
  real container. All five are written — the default is the bare `{}` case, and
  `scenarios.json` adds `bare_no_env` (no `remoteEnv`, a committed fixture),
  `login_shell` (all four shell shapes), `both_dirs` (user-then-project ordering, with
  the user fixture written straight into the fixed path) and `live_edit` (a non-default
  `projectDir`, plus add/delete through the symlink) — but none has been run under
  Docker. What that leaves unmeasured is the image build itself, the CLI's `PROJECTDIR`
  option plumbing, `${containerWorkspaceFolder}` substitution inside each scenario's
  `onCreateCommand`, and the cwd a Feature-declared `postCreateCommand` is actually
  given — the assumption the create-time symlink rests on, guarded rather than assumed
  (an unset `PROJECT_PATH` plus a cwd equal to the home folder is the CLI's
  `|| homeFolder` branch, and there the hook declines, names the two things that would
  fix it, and exits 0). **Open question 1 is still open and deliberately undocumented:**
  whether `userEnvProbe` picks `dirs/env.sh` up on a _first_ create. `bare_no_env.sh`
  clears `PROJECT_PATH` before every probe rather than asserting either answer.
  `version` is `0.1.0` and `PUBLISH_ALLOWLIST` is untouched, so this publishes nothing;
  `features/shell-dirs/`, `devc/` and `devc/default/scripts/bashrc-additions.sh` are
  unchanged, per copy-don't-move. Retiring `shell-dirs` and swapping devc onto this
  Feature are later plans.
- [feature-shell-dirs](archived/feature-shell-dirs.md) — Publish
  `ghcr.io/devc-tools/features/shell-dirs`: every `*.sh` in one or two directories
  sourced by every interactive shell, in a defined order, **live** — sourced from
  `~/.bashrc` rather than appended into it, so a file added after the build is
  picked up by the next shell. A bare `{}` is the project layer (the repo's own
  `.devcontainer/shell/`), which is the layer most consumers want; the optional
  personal layer needs a read-only bind the Feature cannot declare, so `userDir` is
  a slot the consumer fills and the README ships the three lines with **no devc
  path in them**. `devc/default/` is untouched, per the copy-don't-move rule.
  The plan's real contract is the **test**: `devc/tests/shell_dirs_test.sh` now runs
  against `features/shell-dirs/install.sh` **unmodified**, so the fence markers, the
  two `*_SHELL_DIR` assignment names, the helper's name and the no-leaks property are
  all pinned in both copies at once — the only thing keeping them from drifting.
  Everything the two copies **do not** share went into siblings, because that harness
  has to keep passing against devc's copy: `test/shell_dirs_guard_test.sh` for the
  `_DEVC_SHELL_DIRS_DONE` skip-guard (confirmed to fail when the skip is neutered,
  which the mere presence of the variable would not have caught), and
  `test/install_options_test.sh` for the half neither block harness reaches — both
  options through to both assignments, the marker guard against a double-append, and
  the refusal path. Two decisions worth the words. `${VAR-default}`, not
  `${VAR:-default}`: an explicitly empty option **disables** its layer, and falling
  back to the default there would be invisible until someone set `projectDir` to `""`
  and got `.devcontainer/shell` anyway. And an option containing `"`, `` ` ``, `$` or
  `\` **fails the build** naming the option, rather than being escaped — the values
  are pasted into a shell assignment, and a silently mangled block sources something
  other than what was asked for. Substitution goes through `awk -v` rather than `sed`
  so a `&` in a path is data, and it is verified with `grep -qxF` afterwards, the same
  fail-loudly shape `node-nvmrc` uses.
  **The ordering hazard is recorded, not papered over.** Features install after the
  Dockerfile, so this block lands _after_ devc's `DEVC_ATTACH` `PROMPT_COMMAND`
  snapshot — a layer that assigns `PROMPT_COMMAND` would clobber `devc attach`'s
  first-prompt clear, where today it is merely overwritten before the snapshot. Not
  fixable from a Feature and not a regression for anyone without a `DEVC_ATTACH`
  block; **the swap plan must move that block after the Feature's append, or make it
  re-assert at the first prompt.** The interim guard is one-sided by construction and
  happens to work (devc runs first and sources; this copy skips), so the README says
  plainly not to enable this Feature in a devc container until devc's own block is
  gone.
  Verified here: both harness invocations (12 checks each, the Feature's copy and
  devc's), the guard harness (10 checks), the options harness (35 checks),
  `tests/features_test.sh` (12 checks, 3 Features in scope — the collection walk
  picked the new directory up with no edit), `tests/workflow_guards_test.sh` (8
  checks) and `deno fmt --check` (125 files). Beyond the plan, **all four
  `devcontainer features test` scripts were executed offline** — against a real
  `~/.bashrc` written by `install.sh` into a temp `HOME`, with the test lib stubbed —
  including their `bash -ic` interactive-shell checks, which is what turns "the block
  is in the file" into "a new shell actually has the alias".
  **Not verified here (no Docker):** every `devcontainer features test` scenario as a
  container. All four are written — the default is the bare `{}` case, and
  `scenarios.json` adds `project_layer` (`remoteEnv.PROJECT_PATH` + a real workspace),
  `both_layers` (user-then-project ordering) and `no_project_layer` (`""` disables) —
  but none has been run under Docker. What that leaves unmeasured is the image build,
  the CLI's `PROJECTDIR`/`USERDIR` option plumbing, and `${containerWorkspaceFolder}`
  substitution inside each scenario's `onCreateCommand`.
  **One decision was reversed immediately after it landed** (see the archived plan's
  Superseded section): "no lifecycle command" became "no mounts". The plan treated
  `PROJECT_PATH` as an unavoidable prerequisite — its own concept boundaries called it
  "the Feature's sharpest usability edge" — and then shipped the edge: a bare `{}`
  with no `remoteEnv` sourced **nothing**, failing the collection's rule that
  `"<feature>": {}` must install cleanly _and do something useful_. The reasoning
  conflated two times. `install.sh` runs at image **build** time, where the workspace
  is genuinely unmounted and its path unknowable — that half was right. A **lifecycle
  hook** runs at create time, where the CLI hands every hook
  `remoteWorkspaceFolder || homeFolder` as its cwd, so the path is simply there; the
  plan never weighed it because it had already ruled out a lifecycle command. So
  `post-create.sh` (the same install-copies-a-script-into-`/usr/local/share` pattern
  `node-nvmrc` uses) resolves a workspace-relative `projectDir` at create time and
  rewrites the block's `PROJECT_SHELL_DIR=` line; `PROJECT_PATH` remains an override,
  preferred when set, so devc and anyone who already wrote the `remoteEnv` line are
  unaffected. **The drift contract survives** — those two assignment lines were
  already the defined parameterization slot, so the block is still verbatim devc's and
  `shell_dirs_test.sh` still passes unmodified against both. Liveness survives too:
  only the path is resolved, contents are still read per shell. The rewrite is scoped
  between this Feature's own markers, because devc's block carries an identically
  named assignment and an unscoped rewrite would edit it. The assumption it rests on
  is **still open question 1** — guarded rather than assumed, since an unset
  `PROJECT_PATH` plus a cwd equal to the home folder is exactly the `|| homeFolder`
  branch, and there the hook declines, names the two things that would fix it, and
  exits 0. The default scenario now **measures** that cwd. Added with it:
  `test/post_create_test.sh` (33 checks, offline) and a `bare_no_env` scenario — one
  line, no `remoteEnv`, a real committed fixture. `version` stays `0.1.0`; nothing had
  been pushed, so nothing had published.
- [feature-independent-versions](archived/feature-independent-versions.md) — **Reversed a
  stated decision**, `design/devc-feature-split.md`'s "One repo, one tag" (now
  struck through there, with a pointer here): every Feature republished at the
  repo's version on every `v*` tag. The
  decision that was borrowed from ([release-and-installer](archived/release-and-installer.md)
  decision 8) is about the **installer** resolving one version across the eight
  tarballs it fetches, and it never mentions Features — nothing in the repo
  needs the coupling, since `devc` detects devc-bridge by Feature name at any tag
  (`default_config_test.ts:857-860` pins bare, `:0`, `:1` and `:0.1.0` all
  matching). What it costs is churn (a byte-identical `node-nvmrc` gets a new
  digest because devc's tmux handling changed), misleading semver (`:0.1` freezes
  forever when devc goes 0.2.0, so anyone pinned to it silently stops getting
  fixes), and a one-line Feature fix needing a full four-runner binary release.
  Each Feature gets its own `version`, and publishing moves to a push on `main`
  under `features/` — measured safe: `@devcontainers/cli@0.88.0` skips a version
  already in the registry and only advances the floating tags when the new
  version is the max satisfying one, so a run that changes nothing publishes
  nothing. **Nothing is published yet, so there is no migration** — both Features
  keep `0.1.0` and stop moving in lockstep from here. The 40-line inline version
  guard leaves YAML for `tests/features_test.sh`, which takes most of
  `tests/workflow_guards_test.sh` with it: the `awk` that scrapes the guard's
  `run:` block out of the workflow by indentation, and the checks asserting the
  extracted bash iterates a glob and names no Feature, exist only because the
  guard was not callable. `guards_both` stays — whether a publish step is gated
  on both the ref and `!inputs.dry_run` can only be read off the YAML, and it
  guards the one mistake here that cannot be walked back. One guard is **added**,
  covering a hazard the tag trigger was accidentally handling: `devc-bridge`'s
  `FEATURE_VERSION` becomes `DEVC_TOOLS_RELEASE` (it names a release to download
  from, not a Feature version — the two were only ever equal because the rule
  forced it), and publishing checks that release exists. That guard is **why the
  workflow publishes one Feature per matrix job** rather than the collection in
  one command: `features publish ./features` is all-or-nothing, so devc-bridge's
  unmet pin would block `node-nvmrc` — which downloads nothing and pins nothing —
  until a devc release was tagged, reintroducing in CI the exact coupling this
  plan removes. Measured to make that possible: `features publish` accepts a
  single Feature directory and lands on the identical `ghcr.io/<ns>/<id>` ref.
  The cost is recorded, not hidden — every run also pushes a
  `devcontainer-collection.json` describing only what that run packaged, which
  nothing here reads. Explicitly **not** adopted from
  `devcontainers/feature-starter`: `generate-docs` and its documentation PR — its
  table would be generated from the manifest `description` paragraphs and read
  worse than the hand-written ones, and it commits docs _after_ publishing, so
  the README in the published artifact would sit permanently one release behind.
  Verified here: `tests/features_test.sh` (8 checks on this tree, plus a
  synthesized collection covering an empty glob, an `id`/directory mismatch, a
  non-semver `version` and a missing `name` — **all three offenders reported in
  one run**, not just the first), `tests/workflow_guards_test.sh` (5 checks, and
  confirmed to fail when the `Publish` gate is edited down to the ref alone), the
  installer harness (ALL PASS), `install_download_test.sh` against the renamed
  constant, both other Feature harnesses, and `deno fmt --check` (122 files). The
  workflow was parsed as real YAML and its `Discover Features` step **executed**
  against this tree, emitting `["devc-bridge","node-nvmrc"]`; a throwaway
  `features/zz-throwaway/` appeared in both the matrix and the guard with no edit
  to either, which is the walk-don't-enumerate property. Both Features were
  packaged **individually** — the CLI logs `Packaging single feature...` — which
  is the single-Feature mode the per-Feature matrix rests on, and the resulting
  `devcontainer-collection.json` listed only `["node-nvmrc"]`, confirming the
  recorded cost rather than assuming it. **The decoupling itself is pinned by a
  test:** with a `gh` stub reporting _every_ release missing,
  `--feature node-nvmrc --check-release-pins` passes while `--feature devc-bridge`
  fails naming `v0.1.0` — a Feature that fetches nothing cannot be blocked by one
  that does.
  **Not verified here (no Actions):** the workflow has never run. Two things need
  a real dispatch, both in `docs/manual-verification.md` §1 and §3 — a dry run
  from `main` showing `node-nvmrc`'s matrix job green beside `devc-bridge`'s
  failing pin guard with `fail-fast: false` holding, and a real publish of
  `node-nvmrc` **with no devc release tagged**, followed by a no-change re-run
  that must print `Version 0.1.0 already exists, skipping` and push nothing.
  Until a stable `v0.1.0` exists, `devc-bridge`'s job is expected to be red; that
  is the pin guard working, and it no longer holds `node-nvmrc` back.
- [feature-node-nvmrc](archived/feature-node-nvmrc.md) — Publish
  `ghcr.io/devc-tools/features/node-nvmrc`: the Node version a workspace pins in
  `.nvmrc`, installed at create time and selected in every interactive shell,
  including on `cd`. The first of the four splits and the only one with **no host
  coupling at all** — it reads the workspace, writes the container, declares no
  mounts — so a bare `{}` is the whole Feature rather than half of it. Copied out of
  `devc/default/scripts/node-setup.sh` and the nvm lines in `bashrc-additions.sh`;
  **both devc copies are untouched and still running**, per the copy-don't-move rule.
  The generalizations that mattered were the ones about not owning the image:
  hardcoded `vscode` becomes `id -u`/`id -g` (whoever the hook runs as), `sudo`
  becomes `command -v sudo` plus `sudo -n` so an image whose sudo wants a password
  fails instantly instead of hanging create on a prompt nobody can answer, and every
  failure mode is graded — **no `.nvmrc` is silent success** (the Feature has to be
  safe to leave enabled in a repo that pins nothing, or the one-line opt-in is
  worthless), **missing nvm warns and exits 0** (failing create over a documented
  prerequisite turns a one-line misconfiguration into a container you cannot open to
  fix it), and **`nvm install` failing is fatal** (a container quietly on the wrong
  Node is worse than one that fails while you are watching). `installsAfter`, not
  `dependsOn`: `dependsOn` would install the upstream node Feature with _this_
  Feature choosing its `version`/`pnpmVersion`/`nvmVersion`, which are exactly what a
  consumer wants to choose, so the prerequisite is documented and only the ordering
  is declared. The manifest's `postCreateCommand` takes no arguments, so `install.sh`
  bakes the four options into the copies it places by rewriting their
  `VAR="${VAR:-default}"` lines and **failing the build if a rewrite does not take** —
  a rename upstream would otherwise leave an option silently unwired with the default
  standing in for whatever the consumer asked for.
  **Three deviations from devc's copy, not two.** The plan specifies two, both
  implemented: the `cd()` override is conditional on nvm having actually loaded (devc
  redefines `cd` unconditionally, which in an image with no nvm leaves every directory
  change calling a missing command), and the block cannot leave a non-zero `$?` at the
  first prompt. The third is the plan being wrong: it copies devc's `cd` one-liner
  verbatim, and that one-liner returns **1 from every `cd` into a directory without a
  `.nvmrc`**, so `cd somewhere && make` silently stops before `make`. That is the same
  wart as the `$?` one the plan does fix, for the same reason (devc's PS1 only colors
  the status), so `cd` now preserves the builtin's status on failure and returns 0 on
  success. Recorded and pinned by tests rather than done quietly.
  Verified here: the offline `nvm_use_test.sh` (31 checks over the `devc:nvm-use`
  block **extracted from the real `install.sh`**, so the test cannot drift from what
  lands in `~/.bashrc`), `tests/workflow_guards_test.sh` (10 checks, now covering the
  new Feature's id/version), `deno fmt --check` (121 files), and — beyond the plan —
  `install.sh` and the installed `post-create.sh` run offline with `SHARE_DIR` and
  `_REMOTE_USER_HOME` in temp dirs, covering all four options, append idempotency and
  all four create-time paths, plus the appended block sourced against the **real** nvm
  in this devcontainer.
  **Not verified here (no Docker):** every `devcontainer features test` scenario. All
  three are written — the autogenerated default is `{}` on a base image with no nvm
  (which is both the hostile case and the design doc's bare-`{}` case), and
  `test/scenarios.json` adds `with_nvmrc` (pinning `20` while the node Feature installs
  `lts`, so "the pinned version won" is observable) and `no_nvmrc` — but none has been
  run. **The plan's one must-measure item is still unmeasured:** the cwd of a
  Feature-declared `postCreateCommand`. What is recorded in
  [design/devc-feature-split.md](design/devc-feature-split.md) open question 1 is a
  **source read**, not a measurement — the CLI computes
  `remoteCwd = remoteWorkspaceFolder || homeFolder` once and passes it to every
  lifecycle hook, Feature-contributed ones included — so `${PROJECT_PATH:-$PWD}` stays
  and the `with_nvmrc` scenario is what will actually settle it, since its first check
  fails if the hook did not find a `.nvmrc` written at the workspace root.
  One change outside this Feature: `test/run-features-test.sh` now stages the whole
  `test/` directory minus itself instead of only `test.sh`, or a `scenarios.json`
  would never reach the command; `devc-bridge`'s copy was updated identically, because
  that file is meant to be byte-identical in every Feature, and `features/README.md`
  documents both the widened staging and the scenario conventions.
- [features-collection](archived/features-collection.md) — Make `features/` a
  real collection before four more Features arrive, rather than a directory that
  happens to contain one. `features publish ./features` already walked the whole
  tree while the version guard read `features/devc-bridge/` literally, so the
  second Feature would have published **unguarded** — the kind of failure nobody
  sees until they pull a Feature whose version disagrees with the tag it shipped
  under. The guard is now one loop over `features/*/devcontainer-feature.json`
  that checks three things per Feature — `id` equals the directory basename
  (`features package` names the artifact from it, and a mismatch otherwise
  surfaces as a baffling packaging error), `version` equals the tag minus its
  `v`, and the baked `FEATURE_VERSION` **only where one exists**, since only
  `devc-bridge` names a release asset to download and a Feature that fetches
  nothing must not be made to invent a version. It reports every offender with
  its directory before exiting, because "which of the five?" is the only question
  a failed release run has to answer, and it **fails on an empty glob**: a guard
  that finds nothing to check must not pass, which is the exact failure mode the
  plan existed to prevent. What deliberately did **not** change is what fires it:
  `on:` is untouched, publishing stays tag-triggered with `dry_run` defaulting
  true, and the version guard stays gated on the ref alone — a dry run against a
  tag should still check. Widening the guard's coverage was the work; widening
  its trigger was not. The staging wrapper for `devcontainer features test` now
  copies the whole Feature directory minus `test/` instead of a per-Feature file
  list, so a Feature shipping `scripts/*.sh` cannot stage an incomplete copy that
  fails deep inside a container build; it is byte-identical between Features and
  meant to be copied unchanged. New `features/README.md` carries the collection
  layout, the one-repo-one-version rule, the published-refs table and the
  no-shared-code / no-host-mounts constraints; the root README's Releasing
  section and `docs/manual-verification.md` §3 stop saying "all four" versions
  and say "every Feature under `features/`". `tests/workflow_guards_test.sh`
  gained two offline sections: the guard's `run:` block must name **no** Feature
  id literally and must iterate the collection glob, and every Feature's `id`
  must match its directory with all versions equal — the one-repo-one-version
  rule, checkable without a tag and the thing most likely to rot between
  releases. Nothing about the published `devc-bridge` artifact changes.
  **Not verified here (no Docker):** `bash features/devc-bridge/test/run-features-test.sh`
  against the widened staging copy, left unchecked in the archived plan — what
  was checked is the staged tree itself, via a stub CLI. Everything else was run:
  the harness (10 checks, plus both new sections confirmed to fail when the guard
  is hardcoded or a Feature's version drifts), and the guard's `run:` block
  extracted through a real YAML parse and executed against this tree (passes on
  `v0.1.0`, fails naming `features/devc-bridge` on `v9.9.9`) and against
  synthetic collections covering the empty glob, two Features with and without
  `FEATURE_VERSION`, and all three per-Feature failures at once.
- [devc-bridge-client-download](archived/devc-bridge-client-download.md) — Stop
  resting the devc-bridge Feature's security on `readonly` surviving into
  `docker run --mount`, which the published Feature schema cannot express and the
  CLI honors only as an accident of string passthrough (`generateMountCommand`
  passes a string verbatim but rebuilds an object as `type=,src=,dst=`). Verified
  both ways: the old manifest is **invalid** against the published schema, the new
  one validates. The client mount goes away entirely — the binary is already a
  release asset, so the Feature downloads and checksum-verifies it at build time
  and owns it root-owned in an image layer, which _ends_ the cross-container
  tamper vector instead of blocking it, and drops the host-bridge prerequisite for
  the `devcontainer features test`. The token stays a mount, but not the
  Feature's: `devcontainer.json`'s schema takes `anyOf: [Mount, string]` and defers
  to Docker's `--mount` syntax, so `readonly` is specified there rather than
  accidental — and the Feature now declares **no mounts at all**, retiring the last
  unspecified thing it leaned on (`${localEnv:HOME}` inside a Feature mount).
  **Who declares that mount for devc was the plan's one real error** and stopped
  implementation for a call: the plan assumed an `initialize-command.sh` mkdir that
  `0d46b51` had deliberately deleted, so putting the mount in devc's bundled
  default would have failed _every_ devc create on a bridge-less host. Resolved a
  third way — devc injects it into the config it **materializes**, in zero-config
  mode only, and only when a devc.json opts into the Feature; the bundled default
  and `initialize-command.sh` stay untouched, so `0d46b51` stands and
  `default_config_test.ts:336` passes unchanged. Project-mode users declare the
  mount themselves, like any non-devc project — the one documented asymmetry. The
  devc.json overlay could never carry it (`MOUNT_SPEC_RE` rejects `readonly` for
  the same re-serialization reason), which is what makes injection the only route
  rather than the tidiest. Host-side, `ensureToken` → `resetToken` regenerates
  instead of adopting, closing the token-pinning escalation; since that makes the
  host a _writer_ into a possibly-writable directory and a container can plant a
  symlink there (measured), every token write goes through a same-dir temp +
  `rename`. Host permissions are **not** an alternative: Docker Desktop shares
  through `fakeowner`, where an unprivileged container user overwrites a
  `root:root 0400` file, while the `ro` flag stops even root. Lifts the Docker
  Compose exclusion to a caveat.
  **Not verified here (no Docker, no macOS host):** `devcontainer features test`,
  both devc modes end to end, the compose devcontainer, the live symlink check and
  the dev-override shadowing — all left unchecked in the plan.
- [release-and-installer](archived/release-and-installer.md) — Publish prebuilt
  binaries from a tagged GitHub release and install them with one `curl | sh`, so
  nobody needs Deno to _use_ these tools. Covers `devc` (4 targets), the
  devc-bridge host CLI (macOS) and the Linux container client — the destination
  [devc-bridge-client-mount](archived/devc-bridge-client-mount.md) already fixed.
  Eight plain-binary archives named by Deno's own target triples (one vocabulary
  between the workflow and the installer, not two mappings to keep in step),
  built natively on a runner of each architecture, verified against a
  `checksums.txt`, and installed without `sudo` into `~/.local/bin`. The Linux
  client is arch-matched to the **host**, not the installer's own platform — the
  one selection here that is easy to get backwards, so it is what the installer
  tests lead with. Both `devc-bridge` binaries gained a `VERSION` and
  `version`/`--version`/`-V`, which is what makes each build job's smoke test an
  assertion rather than a formality; the version guard requires all three
  `VERSION` consts to agree and, on a tag, to equal it — **strict equality, so a
  `v0.1.0-rc.1` tag needs `VERSION` to read `0.1.0-rc.1`**, documented in the
  root README's new Releasing section. `install.sh` ships as a release asset with
  the tag stamped in, not from `main`, so the `latest/download` URL always serves
  the script that release was tested with.
  **The release workflow has never been run against a real tag — or at all.**
  There is no Actions access, no macOS host and no Docker here, so what was
  verified is the workflow's own `run:` steps, extracted from the parsed YAML and
  executed against the real tree: the version guard (passing on `v0.1.0`, failing
  on `v9.9.9`, and synthesizing a version on a branch ref for `dry_run`), the
  smoke test, the archive step, and the publish job's collect/checksums and
  install.sh stamping. All four targets were cross-built locally through the new
  `build:release` tasks, yielding exactly the eight expected archives with the
  right architecture in each (ELF `e_machine`, Mach-O `cputype`) and mode 0755
  surviving tar; `sha256sum -c` passed on the generated `checksums.txt`, and a
  missing or extra asset each fails the collect step. Then the **stamped**
  `install.sh` was run end to end against those archives over `file://` and
  installed working binaries. A new `tests/install_test.sh` (34 cases, offline,
  `uname` stubbed on PATH so the real detection code runs) pins the triple→asset
  mapping for all four platforms, the four failure paths, all three
  version-resolution sources, the `DEVC_TOOLS` knobs, the PATH warning and
  upgrade-in-place; it also greps the workflow's spelled-out asset list, so the
  installer and the workflow cannot drift apart on a name silently. Left for a
  human, in the order that answers the most: a `workflow_dispatch` **dry run**
  (the only thing that can tell us whether `ubuntu-24.04-arm` is available to
  this repo, and the first time the macOS signing and the `macos-14` arm64 smoke
  test run at all), then a prerelease tag, then installing it on a Mac to confirm
  `devc-bridge start` from the installed binary with no `deno` on PATH and a
  container `ping` through the host-matched client.

- [devc-bridge-tray-decouple](archived/devc-bridge-tray-decouple.md) — Make
  `devc-bridge start` run the bridge as a plain detached background process: no
  `.app`, no `deno desktop`, no LaunchServices, with the menu-bar tray demoted to
  an opt-in extra behind `run --tray`. This is what makes the host binary
  shippable — a compiled binary's `start` used to shell out to
  `deno desktop … main.ts` with a cwd derived from `Deno.mainModule`, which in a
  compiled binary is a virtual `/tmp/deno-compile-*` path, and it needed a `deno`
  on PATH that a released binary must not assume. `start` now relaunches _the
  program it was invoked as_ with the `run` subcommand, detached; one helper
  returns that argv for both modes, keyed off `Deno.build.standalone` — **not** a
  path probe, because a compiled binary can stat its own virtual `main.ts` even
  though nothing it spawns can reach it. Nothing of substance is lost: `core.ts`
  owns the server, dispatch and keepawake, and `tray.ts` already degraded
  headless when `Deno.Tray` is absent. `serve.ts` is deleted — bare `run` is what
  it was — and its opt-in keepawake resolves toward `Config`, which always
  configures it. The settings file goes too: it existed only because `open -g`
  started the tray under launchd without the shell's environment, and a detached
  child inherits that environment directly.
  Verified here, all on Linux with no GUI, which is itself the result: the
  compiled binary's `start`/`status`/`restart`/`stop` on a PATH with **no
  `deno`** (the case that blocked shipping), a `ping` from the client arming and
  expiring a stub keepalive with `status` reporting `active: caffeinate`,
  `DEVC_BRIDGE_KEEPAWAKE_IDLE_MS` taking effect through the inherited environment
  with no `settings.json` written, `run --tray` coming up (headless, as it must
  without `Deno.Tray`), and a new 10-test host suite covering the relaunch argv
  in both modes plus `start`'s detach-and-wait contract. **One real bug was found
  by validating rather than assuming:** `nohup`'s SIG_IGN does not survive Deno's
  own signal setup, so the daemon died when the terminal that started it closed —
  fixed with an explicit SIGHUP listener and pinned by a test. Left for a human,
  all macOS-only: the real `caffeinate(8)`/`pmset` assertions, a container→host
  `ping`, and whether a menu-bar icon actually appears under `deno task dev`
  (this container's `deno desktop` never executes the bundle it builds). Also
  updated [release-and-installer](archived/release-and-installer.md) in the same change,
  as planned: its first checklist item and both `.app` assets are gone (ten
  archives → eight) and its decisions 5 and 6 are marked withdrawn.

- [devc-bridge-feature](archived/devc-bridge-feature.md) — Repackage the container half
  of devc-bridge as a published devcontainer Feature, so any project (devc or
  not) opts in with one line, and devc's bundled config consumes the same
  Feature instead of carrying its own mounts — one mechanism, not two. Two
  assumptions were tested rather than assumed, with a throwaway Feature under
  `test/`: `${localEnv:HOME}` **is** substituted in Feature mounts, and a mount
  written as a **string** is passed through verbatim so `readonly` survives
  (`RW=false`), while the object form is re-serialized and drops it. The string
  form is unspecified by the published schema, so the probe is kept as a
  regression harness. Features cannot declare `initializeCommand`, so the
  Feature cannot create its own mount sources: standalone users must install the
  host bridge first (documented), while devc keeps its own host-side hook and
  stays inert-when-absent. Docker Compose is out of scope — the string form
  emits the wrong syntax there — which is why the pidfile also moves out of
  `run/`, making a writable token mount harmless rather than a way to feed
  `devc-bridge stop` an arbitrary PID.
  Merged. Verified here: `deno task check`/`test` (269/269) and repo-wide
  `deno fmt --check` clean, the Feature's `install.sh` symlink harness (moved
  from devc's tests and retargeted) passing all five cases, devc's other four
  shell harnesses unchanged, and a new unit test pinning the two mounts to the
  **string** form with `readonly`. Left for a human, all needing Docker or a
  real host: the `devcontainer features test` scenario (written, not run), a
  standalone non-devc project reaching `pong`, a devc project with no
  duplicate-mount error, the two failed `touch`es, the never-installed-bridge
  difference between the devc and standalone paths, live client healing, and
  `stop` against the moved pidfile. **The Feature must be published before
  devc's bundled config is used**, this repo's own container included: that
  config is materialized into a cache dir, so it can only reference a published
  ref. Deviations recorded in the archived plan: `:0` rather than `:1` (a 0.1.0
  publish has no `1` tag), and a staging wrapper for `devcontainer features
  test`, which insists on a `src/`+`test/` collection layout that
  `features publish` does not.
  **Partly superseded — two of this plan's decisions were reversed after it
  landed** (`b513800`, `0d46b51`), so read the paragraphs above as history:
  1. **devc's bundled config does _not_ consume the Feature.** Putting a Feature
     ref in the bundled default made every `devc up` anywhere depend on that ref
     resolving — so an unpublished (or renamed, or yanked) Feature breaks devc
     for everyone, and it broke it immediately, since nothing was published.
     devc-bridge is now opt-in via `additionalFeatures` in a user-level
     `~/.config/devc/devc.json` or a project-level `devc.json`, which the
     overlay already supported. `devc/tests/default_config_test.ts` asserts the
     **absence** of the Feature from the default; the test covering the
     Feature's own readonly string mounts is unchanged.
  2. **devc no longer pre-creates the mount sources.** The
     `devc:bridge-placeholder` fence in `initialize-command.sh` (and
     `devc/tests/initialize_command_test.sh` with it) is deleted: a host that
     never uses the bridge should not carry directories for it, and the host
     bridge seeds `~/.config/devc-bridge/` itself on `start`
     (`devc-bridge/host/config.ts`). So the "devc stays inert / standalone
     fails" asymmetry above is gone — installing the host bridge first is now
     the same prerequisite for everyone, which is what "one mechanism" should
     have meant in the first place.

     Unchanged by this: the Feature itself, its mounts, and the requirement to
     publish it before any `ghcr.io/...` ref resolves. Pre-publish testing goes
     through a project whose own `.devcontainer/devcontainer.json` references
     `./features/devc-bridge` — a relative local path resolves against that
     file's folder, and needs no overlay and no registry.

- [devc-bridge-client-mount](archived/devc-bridge-client-mount.md) — Ship the devc-bridge
  container client by **read-only bind mount** from devc's bundled
  `devcontainer.json`, so every devc container gets it with no per-project
  wiring — the current `.devc/devc-post-create.sh` builds from source that only
  exists in this repo, so it cannot be the distribution mechanism. The mounts
  must live in `devcontainer.json` rather than a `devc.json` overlay because
  only verbatim string mounts there can carry `readonly`. Mounts the client's
  _directory_ (a file mount pins the inode, so a rebuilt client would go stale)
  into devc's namespace, plus an unconditional PATH symlink that heals the
  moment the host builds the client — shell-init healing does not work, since
  devc's `~/.bashrc` additions sit after Ubuntu's non-interactive guard and
  `devc claude` runs `bash -lc`. A host-side placeholder keeps the dangling link
  self-explanatory. Nothing is built on the fly: the mount source is a
  destination that the release installer (typical user) or `deno task build:client`
  (dev) writes to, so `start` needs no embedded source, arch derivation or
  build-failure handling. Also hardens the existing `run/` mount to `readonly`,
  which closes a live issue: it is writable today, and `stop` `Deno.kill`s
  whatever PID a container can write into `run/tray.pid`. **Requires migration**
  — this repo's overlay mounts the same target (Docker fails on duplicate mount
  points) and its `.devc/devc-post-create.sh` is deleted, leaving devc-tools
  consuming the bridge like any other project.
  Merged and in use; its remaining end-to-end checks were deliberately not run
  standalone, because [devc-bridge-feature](archived/devc-bridge-feature.md) replaces
  this mechanism and re-tests the same behaviors more thoroughly.

- [devc-project-post-create-hook](archived/devc-project-post-create-hook.md) —
  Restore the project create-time hook as `devc-post-create.sh`, found at
  `.devc/` then `.devcontainer/` (first-hit-wins, the overlay's own order) and
  run last by `post-create.sh` via a new `scripts/project-hook.sh` step.
  `devc-container-feature` dropped the old hook because the top-level
  `postCreateCommand` was then free; `devc-drop-feature` gave that slot back to
  devc's own baseline and its `post-create.user.sh` replacement never shipped,
  leaving **zero-config projects with no create-time extension point at all** —
  the overlay cannot express a command, since only three keys have a
  `devcontainer up` flag and adding one would mean rewriting the project's
  `devcontainer.json`. A script the baseline _calls_ composes additively by
  construction, so the "does this override `devcontainer.json`?" question never
  arises. Deliberate change from the old behavior: **existence selects,
  executability is enforced** — a present-but-non-executable hook (or a dangling
  symlink) fails the create naming the path instead of being silently skipped,
  and never falls through to the other location. The fence the shell test
  extracts encloses the whole body including `set -e` and the `cd`; putting them
  outside it let the block pass without them, which the tests caught. Verified
  end-to-end without a rebuild: the step discovered this repo's own hook, built
  and installed the `devc-bridge` client, and `devc-bridge ping test` returned
  `pong` on the client's built-in defaults — which also confirms the `containerEnv`
  key deleted from `.devc/devc.json` was pure redundancy (the overlay never
  supported it; it warned and dropped it). Then confirmed on a **real rebuild**:
  the client is installed by `postCreateCommand` → `post-create.sh` →
  `project-hook.sh` → `.devc/devc-post-create.sh` (its mtime falls after PID 1's
  start, so it is the hook's work, not the earlier direct run), `ping` returns
  `pong`, and the project still has no `.devcontainer/` — zero-config extension
  works end to end. One pre-existing unrelated test failure
  (`jsonc_edit_test.ts:111`) is unchanged.

- [devc-mounts-to-overlay](archived/devc-mounts-to-overlay.md) — The wizard's
  two managed mount fences (`devc:source`, `devc:skills`) now live in the
  project's `devc.json` overlay instead of the tracked `devcontainer.json`.
  `devc config` writes an existing overlay in place, else creates
  `.devcontainer/devc.jsonc` (or `.devc/devc.jsonc` when the project has no
  `.devcontainer/`) — and no longer writes or scaffolds `.devcontainer/` at all,
  so the standalone invariant is structural rather than conventional. Mount
  specs are re-serialized to the exact form `devcontainer up --mount` accepts
  and validated against the CLI's own regex at load, which drops `readonly` and
  `consistency`: neither is expressible, and every workaround costs `SYS_ADMIN`
  (Docker's default seccomp profile fixes the `mount` allowance at create time,
  so even `docker exec --privileged` cannot restore it) — the archived plan
  records the full investigation. Verified live: `devcontainer up` accepted the
  emitted spec, `devc mounts` listed it `rw`, and a hand-written `readonly`
  overlay mount fails the command naming the file, index and field. No
  migration by design — **the old fences in this repo's
  `.devcontainer/devcontainer.json` still need deleting by hand** (until then
  `~/code/thirdparty/agent-tools` is mounted twice, at two different targets).
  Two pre-existing test failures (`default_config_test.ts:654`,
  `jsonc_edit_test.ts:111`) are unrelated and unchanged.

- [devc-attach-exit-code](archived/devc-attach-exit-code.md) — Stop crashing
  on detach: `attachToContainer` now resolves to the attached shell/command's
  own `docker exec` exit code (e.g. 130, an ordinary signal-driven shell exit)
  instead of throwing on any non-zero code, mirroring `execInContainer`'s
  existing contract; `main.ts`'s `attach()` wraps the call in try/catch,
  exiting with that code on success or printing `devc: …` + exit 125 on a
  real infra failure, matching `exec`'s pattern exactly. `devc/README.md`'s
  `attach`/`claude` bullet documents the same contract the `exec` bullet
  already did. `deno check`/`deno fmt --check`/`deno lint` are clean (30
  pre-existing, unrelated `no-import-prefix` lint findings elsewhere in the
  repo are unchanged by this work). The plan's live-Docker validation steps
  (attaching to a real container and observing `exit`/`exit 130`/a non-zero
  `devc claude` exit/an infra-failure `PATH` case/`--build`+`--no-clear`
  regression) were **not run** — no Docker available in this environment —
  and are left unchecked in the archived plan for a human to verify.

- [devc-bridge-keepawake](archived/devc-bridge-keepawake.md) — Activity-driven
  caffeinate: a reserved `ping` builtin in the bridge server starts the
  allowlisted `caffeinate` script on the first ping and stops it after a
  configurable idle timeout (default 5 min — must exceed the longest ping gap
  from long tool runs and permission prompts). Deliberately minimal: a
  re-armed `setTimeout` in a new `host/keepawake.ts` is the whole reaper, the
  existing state-dir marker still drives the tray ○/●, and `main.ts` and the
  client are unchanged. The tray's only change is an async `shutdown` that
  awaits `server.close()` so quitting never leaks a started `caffeinate`.
  Config (`DEVC_BRIDGE_KEEPAWAKE_COMMAND`/`_IDLE_MS`) is always-on for the
  tray; the headless `serve.ts` keeps `ping` opt-in (only enabled when one of
  those vars is set) so §A can test the unconfigured fall-through too.
  §A (in-container) validation fully passes: ping round-trip, start/no-double-
  start/expiry/re-arm/gap-reset, unauthorized-doesn't-arm, `close()` awaits
  stop, fall-through when unconfigured, and the full existing regression
  table. §B (macOS/GUI: real `pmset` assertions, tray icon, a real Claude
  session) was **not run** — no macOS host available in this environment —
  and is left unchecked in the archived plan for a human to verify.

- [devc-config-overlay](archived/devc-config-overlay.md) — Reintroduce a
  `devc.json` overlay (`mounts`/`additionalFeatures`/`remoteEnv` →
  `--mount`/`--additional-features`/`--remote-env`) that merges onto whichever
  base config is in play, in project mode as well as zero-config — the reference
  implementation only ever consulted it when the project had no
  `devcontainer.json`. Adds a user-level `~/.config/devc/devc.json` applying to
  every project, and a sparse `~/.config/devc/templates/` that overrides bundled
  assets per file and is re-applied every run, so a devc upgrade keeps shipping
  its new defaults.

- [devc-init-command](archived/devc-init-command.md) — Add a non-interactive
  `devc init [PATH]` that scaffolds the bundled default `.devcontainer/` into a
  project verbatim — the same files `devc config` writes on first creation,
  minus the wizard and minus the two managed mount fences. Refuses to clobber an
  existing config, and never triggers the first-run global-config wizard.

- [devc-picker-free-navigation](archived/devc-picker-free-navigation.md) — Make
  the configured roots a shortcut list rather than a boundary: `←` walks to the
  real parent everywhere and wraps to the shortcut list at `/`, so any folder
  can be picked. Roots stay unselectable. Because that makes out-of-root
  worktrees reachable, `resolveWorktree` stops calling them invalid and instead
  mirrors both the worktree's and the primary `.git`'s container targets from a
  shared base — the configured root when it holds the primary, else their common
  ancestor (what the devcontainer CLI does for a worktree project).

- [devc-picker-derived-mounts](archived/devc-picker-derived-mounts.md) — Show
  the auto-added primary repo `.git` mount in the source picker's
  `Source Folders` list the moment its worktree is picked, marked `◎` and inert
  (the picks cursor skips it) so it cannot be unticked while a worktree
  requiring it is picked. One shared helper backs both the picker display and
  the written fence, so they cannot disagree (introduced here as
  `impliedPrimaryMounts`; since replaced by `resolvePickedMounts` — see
  [devc-picker-free-navigation](archived/devc-picker-free-navigation.md)).
  Display-only: the fence contents are unchanged.

- [devc-wizard-modernize](archived/devc-wizard-modernize.md) — Replace the
  full-screen sidebar wizard (mnemonic `N`/`B`/`A` keys) with a modern inline
  sequential flow plus a multi-select, type-to-filter folder picker, zero new
  dependencies, on the existing `tui/term.ts`+`tui/keys.ts`.

- [devc-wizard-screens](archived/devc-wizard-screens.md) — Re-skin the
  folder-picker screens to the mockups in `.plans/design/wizard/` (screen
  banner, Title Case section headings, no mid divider, `>` filter line, `◎`
  pinned marker), and retire the superseded sidebar/step-table wizard
  description in the design doc.

- [devc-build-command](archived/devc-build-command.md) — Add a top-level
  `devc build` (recreate the container, `--no-cache` to drop the layer cache)
  and make `devc config` change-aware: it prompts for a rebuild only when the
  apply actually altered `devcontainer.json`, so toggling folders back to their
  original state prints "no changes" instead.

- [devc-drop-feature](archived/devc-drop-feature.md) — Remove the local
  devcontainer Feature entirely; deliver the baseline via the bundled Dockerfile
  (build-time) + a top-level `postCreateCommand` running
  `scripts/post-create.sh` (create-time), so zero-config and `devc config`
  projects share one transform-free `.devcontainer/` shape. Composition is
  preserved by the developer editing the project's own `post-create.sh` — the
  `post-create.user.sh` hook that plan proposed was dropped before it shipped,
  and no such file exists. Publishing a standalone OCI feature is explicitly
  dropped as a goal.

- [devc-worktree-mounts](archived/devc-worktree-mounts.md) — Worktree-aware
  `devc config` bind mounts: keep the source target's sub-path relative to the
  configured code root, and for a picked git worktree also mount the primary
  repo's `.git` at the mirror location (only when the worktree uses relative
  paths and the primary lives under the same root). Invalid worktrees are
  flagged live in the folder picker and skip the primary mount.

- [devc-container-feature-fix](archived/devc-container-feature-fix.md) — Fix
  zero-config `devc up`: a local Feature can't load from devc's out-of-tree
  bundled config, so the bundled default carries its baseline itself (Dockerfile
  build-time + top-level postCreateCommand runtime) while `devc config` projects
  keep the composable Feature. Also drops in-container tmux.

- [devc-help-output](archived/devc-help-output.md) — Clap-style
  `--help`/`--version`: structured top-level help with a `Commands:` list,
  `-V`/`--version`, and per-command `devc <cmd> --help` blocks (verbatim from
  the design doc), in a new pure `help.ts` module.

- [devc-config-wizard](archived/devc-config-wizard.md) — The four-step
  `devc config` project wizard writing `.devcontainer/` via two comment-fenced
  mount blocks (`devc:source`/`devc:skills`) over the kept `jsonc_edit.ts`;
  opt-in per-folder skills with a remembered last-selection seed.
- [devc-global-config](archived/devc-global-config.md) — Global user config
  (`codeRoots`/`skillsRoots` at `~/.config/devc/config.json`), first-run flow,
  and the reusable step-based wizard TUI shell (reusing
  `tui/term.ts`+`tui/keys.ts`) with the Global config step.
- [devc-container-feature](archived/devc-container-feature.md) — Repackage the
  baseline setup (Claude CLI, `.claude` volume/symlink, shell additions) as a
  custom devcontainer Feature so a project's own top-level `postCreateCommand`
  composes instead of clobbering it; make skills opt-in in the zero-config
  default.
- [devc-lifecycle-core](archived/devc-lifecycle-core.md) — Replace the
  fence-based tool with the container-lifecycle CLI
  (`up`/`attach`/`claude`/`exec`/`mounts`/`stop`/`down`/`status`) + bundled
  default, ported from the reference `@devcontainers/cli`+`docker`
  implementation (tmux-attach and `.devc` overlay dropped).
- [devc-tui-home-paths](archived/devc-tui-home-paths.md) — Home directory
  support: expand `~`/`$HOME` in host-side config values, and write mount
  `source=` paths under home as `${localEnv:HOME}/...`.
- [devc-tui-host-folder-paths](archived/devc-tui-host-folder-paths.md) — Fix the
  `devc-tui:folders` fence, which writes container paths into a workspace file
  VS Code opens on the host: write host paths relative to the workspace file,
  and move the selection read-back with them.
- [devc-tui-folder-tree](archived/devc-tui-folder-tree.md) — Make the
  interactive tree mirror the scanned directory layout: worktree groups shown in
  place instead of re-parented under their primary, collapsed by default, and
  the fold column reserved for fold state.
- [devc-tui-ui](archived/devc-tui-ui.md) — The interactive checkbox folder tree
  on top of the core: scrollable tri-state tree, filter, skills section, writing
  through the same apply path as the CLI.
- [devc-tui-core](archived/devc-tui-core.md) — New `devc-tui/` tool: scan a
  configured root for repos and worktrees, and toggle them as bind mounts in
  `.devcontainer/devcontainer.json` plus folders in the `.code-workspace`, via
  comment-fenced managed blocks. Headless CLI + tests.
- [host-command-bridge](archived/host-command-bridge.md) — Loopback-TCP + token
  bridge letting a devcontainer invoke allowlisted host scripts (e.g.
  `caffeinate`), with a Deno Desktop menu-bar tray showing idle/active state.
- [host-lifecycle-cli](archived/host-lifecycle-cli.md) — Single self-contained
  `devc-bridge` executable with `start`/`stop`/`status`/`restart` background
  lifecycle and zero-setup config/command seeding.

## Development Phases

| Phase                                                                                                       | Plan                                                                               | Status   |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------- |
| Host command bridge (socket server + client + tray)                                                         | [host-command-bridge](archived/host-command-bridge.md)                             | complete |
| Host `devc-bridge` lifecycle CLI + zero-setup seeding                                                       | [host-lifecycle-cli](archived/host-lifecycle-cli.md)                               | complete |
| devc-tui core — scan, model, fenced-region file surgery                                                     | [devc-tui-core](archived/devc-tui-core.md)                                         | complete |
| devc-tui interactive UI — checkbox project tree                                                             | [devc-tui-ui](archived/devc-tui-ui.md)                                             | complete |
| devc-tui tree reshape — folder tree, collapsed by default                                                   | [devc-tui-folder-tree](archived/devc-tui-folder-tree.md)                           | complete |
| devc-tui workspace folders — host paths, not container paths                                                | [devc-tui-host-folder-paths](archived/devc-tui-host-folder-paths.md)               | complete |
| devc-tui home directory support — `$HOME` in config, `${localEnv:HOME}` in mounts                           | [devc-tui-home-paths](archived/devc-tui-home-paths.md)                             | complete |
| devc lifecycle core — container commands + bundled default (ported)                                         | [devc-lifecycle-core](archived/devc-lifecycle-core.md)                             | complete |
| devc baseline as a devcontainer Feature — composable postCreate                                             | [devc-container-feature](archived/devc-container-feature.md)                       | complete |
| devc global config + wizard TUI foundation                                                                  | [devc-global-config](archived/devc-global-config.md)                               | complete |
| devc config wizard — project `.devcontainer/` via managed fences                                            | [devc-config-wizard](archived/devc-config-wizard.md)                               | complete |
| devc help output — clap-style `--help`/`--version` + per-command help                                       | [devc-help-output](archived/devc-help-output.md)                                   | complete |
| devc container baseline fix — out-of-tree Feature + drop in-container tmux                                  | [devc-container-feature-fix](archived/devc-container-feature-fix.md)               | complete |
| devc wizard modernize — inline sequential flow + multi-select folder picker                                 | [devc-wizard-modernize](archived/devc-wizard-modernize.md)                         | complete |
| devc worktree-aware mounts — root-relative source targets + primary `.git` mount                            | [devc-worktree-mounts](archived/devc-worktree-mounts.md)                           | complete |
| devc `~/.claude` seed dir — one read-only directory bind, symlinked in postCreate                           | [devc-claude-seed-dir](archived/devc-claude-seed-dir.md)                           | complete |
| devc `init` command — scaffold the bundled default `.devcontainer/` into a project                          | [devc-init-command](archived/devc-init-command.md)                                 | complete |
| devc drop Feature — Dockerfile + top-level `postCreateCommand`; `scripts/` + user hook                      | [devc-drop-feature](archived/devc-drop-feature.md)                                 | complete |
| devc `build` command + change-aware `config` rebuild prompt                                                 | [devc-build-command](archived/devc-build-command.md)                               | complete |
| devc wizard screens — picker chrome per `.plans/design/wizard/` mockups                                     | [devc-wizard-screens](archived/devc-wizard-screens.md)                             | complete |
| devc picker derived mounts — implied primary `.git` shown in the picks list                                 | [devc-picker-derived-mounts](archived/devc-picker-derived-mounts.md)               | complete |
| devc picker free navigation — roots as shortcuts + worktree mirror base                                     | [devc-picker-free-navigation](archived/devc-picker-free-navigation.md)             | complete |
| devc config overlay — `devc.json` in both modes + user template layer                                       | [devc-config-overlay](archived/devc-config-overlay.md)                             | complete |
| devc-bridge keepalive — `ping` builtin + idle-timeout caffeinate                                            | [devc-bridge-keepawake](archived/devc-bridge-keepawake.md)                         | complete |
| devc attach exit-code handling — stop crashing on non-zero `docker exec`                                    | [devc-attach-exit-code](archived/devc-attach-exit-code.md)                         | complete |
| devc mounts to overlay — wizard fences move into `devc.json`, out of `devcontainer.json`                    | [devc-mounts-to-overlay](archived/devc-mounts-to-overlay.md)                       | complete |
| devc project post-create hook — restore `devc-post-create.sh` for zero-config projects                      | [devc-project-post-create-hook](archived/devc-project-post-create-hook.md)         | complete |
| devc-bridge client by read-only mount — every container, no per-repo build                                  | [devc-bridge-client-mount](archived/devc-bridge-client-mount.md)                   | complete |
| devc-bridge as a devcontainer Feature — one opt-in line, one mechanism                                      | [devc-bridge-feature](archived/devc-bridge-feature.md)                             | complete |
| devc-bridge tray decoupling — headless by default, tray as an add-on                                        | [devc-bridge-tray-decouple](archived/devc-bridge-tray-decouple.md)                 | complete |
| releases + installer — GH Action builds every binary; `curl \| sh` installs them                            | [release-and-installer](archived/release-and-installer.md)                         | complete |
| `features/` as a real collection — guard and test every Feature, not just the bridge                        | [features-collection](archived/features-collection.md)                             | complete |
| `node-nvmrc` Feature — `.nvmrc` install at create, `nvm use` on `cd`                                        | [feature-node-nvmrc](archived/feature-node-nvmrc.md)                               | complete |
| Features version independently — unpin the collection from the repo tag                                     | [feature-independent-versions](archived/feature-independent-versions.md)           | complete |
| `shell-dirs` Feature — sourced `*.sh` layers; devc keeps the read-only user layer                           | [feature-shell-dirs](archived/feature-shell-dirs.md)                               | complete |
| `bash-config` Feature — two fixed dirs, static blocks; supersedes `shell-dirs`                              | [feature-bash-config](archived/feature-bash-config.md)                             | complete |
| `bash-config` 0.2.0 — `~/.bashrc` only; the login profile half dropped entirely                             | [feature-bash-config-bashrc-only](archived/feature-bash-config-bashrc-only.md)     | complete |
| `git-container-config` Feature — container-scope git settings; identity stays devc's                        | [feature-git-config](archived/feature-git-config.md)                               | complete |
| `agents` Feature — agent CLIs + `~/.claude` wiring; seed stays devc's (renamed from `claude-config`)        | [feature-claude-config](archived/feature-claude-config.md)                         | complete |
| `project-hook` Feature — runs the project's own `devc-post-create.sh` at create                             | [feature-project-hook](archived/feature-project-hook.md)                           | complete |
| devc injects `devc-config` — the baseline reaches project-mode containers too (renamed from `project-hook`) | [devc-inject-project-hook](archived/devc-inject-project-hook.md)                   | complete |
| `node-nvmrc` 0.2.0 — `containerEnv` PATH pin for every process; drop the `cd` hook                          | [feature-node-nvmrc-container-wide](archived/feature-node-nvmrc-container-wide.md) | complete |
| devc surfaces the container's agent to Herdr — rotating `HERDR_AGENT` sidecar                               | [herdr-agent-sidecar](archived/herdr-agent-sidecar.md)                             | complete |
