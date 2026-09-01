# Contributing to the Features collection

Maintainer notes for `features/`. Everything a _consumer_ of a Feature needs is in
[README.md](README.md) and each Feature's own README; everything about building,
testing and publishing them is here.

## Layout

`features/` is a devcontainer Feature **collection**: each `features/<id>/` is one
Feature published as its own OCI artifact. Adding a directory here is the whole of
adding a Feature — [`publish-feature.yml`](../.github/workflows/publish-feature.yml)
derives its publish matrix from the collection rather than naming its members, and so
does [`tests/features_test.sh`](../tests/features_test.sh), the guard it runs.

```
features/
  PUBLISH_ALLOWLIST.txt         # ids allowed to publish — see below
  <id>/
    devcontainer-feature.json   # id must equal the directory name
    install.sh                  # runs as root at image build time
    README.md                   # user-facing: what a bare `{}` gives you, plus any mount recipe
    post-create.sh              # optional; create-time hook
    post-start.sh               # optional; start-time hook
    test/
      test.sh                   # the default `devcontainer features test` scenario
      scenarios.json            # optional; extra scenarios, one <name>.sh each
      run-features-test.sh      # wrapper for the above (see below)
      *_test.sh                 # offline harnesses over blocks of install.sh
```

Each Feature is **self-contained** — that is what `devcontainer features publish`
packages, and there is deliberately no `features/common/`. Two Features that both
append to `~/.bashrc` duplicate those lines instead of sharing them; a shared directory
would either be missing from both artifacts or duplicated into both, and the second is
at least honest about it. The same applies to the shared shapes several `install.sh`
files carry — `bake()`, the CSV splitter, the option-validation `case` — they are
copied, not extracted.

## Mounts a Feature may and may not declare

A Feature declares **no host bind mounts** — but it may declare **named volumes**, and
three do (`agents`, `node-nvmrc`, `podman-as-docker`).

No bind mounts, because a Feature cannot declare a read-only one (the published Feature
schema's `Mount` has no `readonly`) and cannot create a bind source (Features cannot
declare `initializeCommand`). Anything host-coupled belongs to the consumer's
`devcontainer.json`, so each Feature's README carries the bind line to paste. See
[`../.plans/design/devc-feature-split.md`](../.plans/design/devc-feature-split.md) for
the reasoning, and `devc-bridge/README.md` for the shape.

Named volumes are different: nothing host-side has to exist first, and
`${devcontainerId}` keys one per devcontainer. Three constraints govern any Feature that
wants one:

- **Only `devcontainer.json` variables substitute** — `${devcontainerId}`,
  `${localWorkspaceFolderBasename}`, `${containerWorkspaceFolder}`, `${localEnv:*}`. A
  Feature's **own option** does not, and neither does `${containerEnv:*}`. Both fail
  _hard_: the literal string reaches Docker, which rejects it and fails
  `devcontainer up`. Loud, not silent — but it means a mount target can never depend on
  how the Feature was configured, and can never name the remote user's home.
- **A declared mount is unconditional.** There is no way to gate one on an option, so
  declare a volume only where every consumer of the Feature wants it.
- **A consumer cannot remove one, only override it.** Mounts merge keyed on **target**,
  consumer config last, so the same target in a `devcontainer.json` wins with no
  duplicate and no error. Say so in the Feature's README; it is the only opt-out there
  is.

Always key a volume on `${devcontainerId}`, never `${localWorkspaceFolderBasename}` — a
`<repo>.worktrees/<branch>` layout names the workspace folder after the branch, so
worktrees called `main` in three different repos share one basename and would share one
volume.

## Versions

**Every Feature versions itself.** The `version` in a `devcontainer-feature.json` is that
Feature's own, unrelated to the repo's `vX.Y.Z` tag and to the other Features. Two
Features at different versions is the normal state here, not drift. The binaries still
move in lockstep on one tag — see the root
[README's Releasing section](../README.md#releasing) — but a Feature is pulled from ghcr
by a consumer's `devcontainer.json`, not installed by `install.sh`, so nothing needs the
coupling. It only ever cost: a byte-identical Feature getting a new digest because some
unrelated tool changed, and a one-line Feature fix needing a full binary release.

The published tag tracks **each Feature's own** version line: `:0` while that Feature is
pre-1.0, `:1` at its first 1.x release.

**Bump what you changed, in the same commit.** A push to `main` touching `features/`
publishes each Feature from its own matrix job, so:

- bump a Feature's `version` when that Feature changes — nothing else has to move;
- leave it alone and the publish is a no-op. `devcontainer features publish` skips a
  version already in the registry, prints `Version X already exists, skipping`, and
  pushes nothing. So "I forgot to bump it" shows up as "nothing published" in the run
  that changed it, not silently at the next release.

A new Feature starts at `0.1.0`.

Adding a declared mount to a published Feature is new behavior every consumer gets
whether or not they ask for it — that is a version bump, not a silent edit.

### Release pins

A Feature that downloads a release asset bakes `DEVC_TOOLS_RELEASE='<tag>'` into its
`install.sh`, naming the devc-tools release it fetches from — **not its own version**;
the two are independent. It is duplicated out of the manifest because the manifest is
JSON and no `jq` is guaranteed in an arbitrary base image. Only `devc-bridge` has one
today. **Do not add one to a Feature that fetches nothing** — a Feature that downloads
nothing must not be made to invent a version.

`bash tests/features_test.sh --check-release-pins` asserts every pinned release exists,
which the old tag trigger used to guarantee by accident: publishing from `main` otherwise
lets a Feature ship pinned to a release nobody has tagged yet.

## The publish allowlist

A Feature that reaches every guard still does not publish unless its id is listed in
[`PUBLISH_ALLOWLIST.txt`](PUBLISH_ALLOWLIST.txt), one id per line (`#` comments and blank
lines are ignored). This is the gate for a Feature under active development: add its
directory, get its manifest right, run its tests — it still sits invisible to ghcr.io
until you add it here. No half-finished Feature auto-publishes just because it touched
`main`.

It is deliberately the one static list in this collection. Everywhere else a Feature is
_discovered_ by walking `features/*/devcontainer-feature.json`, precisely so a guard can
never be left naming only the old Features. The allowlist does not reopen that failure:
leaving a Feature off it fails **safe** (it does not publish), where the old failure mode
failed **unsafe** (it published unguarded). `bash tests/features_test.sh` checks every
entry names a real Feature, so a stale or misspelled id is caught rather than silently
doing nothing forever.

It is **source-only**. `devcontainer features publish` packages one Feature's own
`features/<id>/` directory; `PUBLISH_ALLOWLIST.txt` lives at the collection root, outside
every Feature directory, so it is never part of a published artifact.

`publish-feature.yml`'s `discover` job builds its matrix from this file, and its
`collection-index` job stages a copy of only the allowlisted Feature directories before
republishing the collection index — both so a held-back Feature cannot appear in either
place.

### Publish status

All seven Features are currently allowlisted. Two caveats:

- **`devc-bridge` publishes only once its pinned release exists.** It pins
  `DEVC_TOOLS_RELEASE='v0.1.0'`; the guard runs `gh release view` on that tag, so a tag
  without a published GitHub release still fails it. Check with
  `bash tests/features_test.sh --check-release-pins` before assuming it will publish.
- **A newly created GHCR package is private.** Each has to be made public in the repo's
  Packages settings before an anonymous `devcontainer up` can pull it. Check the
  package's visibility before assuming a fresh publish is reachable.

Orphaned namespaces, referenced nowhere in this repo: everything under
`ghcr.io/bmingles/devc-tools/*` from before the org move, a short-lived
`ghcr.io/devc-tools/*` (no `features/` segment) from a run that published the Features
and then failed on the collection index, and `ghcr.io/devc-tools/features/project-hook`
from before `devc-config` was renamed.

When devc injects `devc-config` it is pinned at an **exact** version rather than `:0` — see
`devc-core/overlay.ts`'s `DEVC_CONFIG_FEATURE` — because that injection reaches every
container devc starts, with no opt-in anywhere. Bumping `devc-config`'s version therefore
means bumping that pin in the same commit, and shipping a devc release to deliver it;
`tests/workflow_guards_test.sh` asserts the two agree. A manual `"devc-config": {}` in your
own config still floats on `:0` like any other Feature here.

## Guarding the collection

```sh
bash tests/features_test.sh                       # the whole collection, offline
bash tests/features_test.sh --feature node-nvmrc  # one Feature
bash tests/features_test.sh --check-release-pins  # + the network check above (needs gh)
```

Per Feature it checks that `id` equals the directory name (`features package` names the
artifact from it, and a mismatch surfaces as a baffling packaging error), that `version`
parses as semver (the whole tag set is derived from it), and that `name` and
`description` are non-empty (`features package` refuses the Feature otherwise, far from
the cause). It walks the collection, reports every offender, and fails on an empty
glob — a guard that finds nothing to check must not pass.

`publish-feature.yml` runs it three times: once over the whole collection before the
matrix, once per Feature with `--feature` so one Feature's failed guard cannot fail
another Feature's publish, and once more in the `collection-index` job.

## The collection index package

`ghcr.io/devc-tools/features` — no trailing `/<id>` — is **not** a Feature and not an
image. It is a metadata-only OCI artifact holding one `devcontainer-collection.json`
layer that lists what is in this collection. `devcontainer features publish` pushes it on
every run and there is no flag to suppress it.

Because each Feature publishes from its own job, every one of those runs would otherwise
overwrite that document with a one-Feature view — so it would name whichever Feature
published last as the whole collection. The `collection-index` job repairs it: it runs
after the matrix, `needs: publish` so it is skipped unless **every** Feature published
cleanly, and re-publishes the whole collection. Every Feature is already at its current
version by then, so the CLI skips them all and only the index document is rewritten.

Nothing in this repo reads it — `devc` never resolves a Feature version, and
`devcontainer features info` goes through a Feature's own OCI annotations. It is kept
honest because it is visible on the repo's Packages page.

### Why the namespace is `<owner>/features`

That unconditional index push is also why `--namespace` cannot be the owner alone. The
CLI derives the index ref from the namespace with no `/<id>`, so
`--namespace devc-tools` would aim it at `ghcr.io/devc-tools` — a registry and an owner
with no package name, which GHCR rejects with `NAME_INVALID`. The CLI's own path
validation accepts a single segment, so nothing catches it until the registry does: every
Feature publishes successfully and _then_ the command fails.

`<owner>/features` keeps Features one segment shorter than `${{ github.repository }}`
would (`ghcr.io/devc-tools/features/<id>` rather than
`ghcr.io/devc-tools/devc-tools/<id>`) while still giving the index a valid home.
`tests/workflow_guards_test.sh` asserts no `--namespace` in the workflow is a single
segment.

## Running a Feature's tests

Every Feature has `test/run-features-test.sh`, and it is the same file in each one:

```sh
bash features/<id>/test/run-features-test.sh
```

It needs **Docker** (and a network, if the Feature downloads anything), so it is run
deliberately and not from `deno task test`.

The wrapper exists because `devcontainer features test` insists on a collection laid out
as `<project>/src/<id>/` + `<project>/test/<id>/`, while `publish` wants the flat
`features/<id>/` this repo keeps. Rather than split one Feature across two trees, the
wrapper stages a throwaway copy in a tempdir: the whole Feature directory minus its
`test/`, plus the whole `test/` minus the wrapper itself, in the place the command looks
for it. Both copies are wholesale on purpose — a per-file list drops a Feature's
`scripts/` from the build, or its `scenarios.json` from the test run, and both failures
surface far from the omission. Copy it into a new Feature unchanged — it derives the id
from its own path and has nothing per-Feature in it.

A Feature with a `test/scenarios.json` gets those scenarios run too, each from its own
`test/<name>.sh`. A scenario may name external Features by their full `ghcr.io/...` ref,
and its own `onCreateCommand` runs before **every** `postCreateCommand` — which is the
only way to have a workspace fixture in place before a Feature's own create-time hook
looks for one, since the command generates the workspace folder itself.

Most Features also have offline harnesses under `test/` that extract a fenced block from
the real `install.sh` and run it directly. Those need no Docker and are the ones to reach
for first.

### Per-Feature test inventory

**agents** — offline: `devc/tests/seed_link_test.sh features/agents/post-create.sh` (the
shared harness, run against the `devc:seed-link` fence),
`features/agents/test/install_options_test.sh` (the real `install.sh` with `curl` and
`runuser` stubbed: the two fixed paths, the already-installed idempotent skip, a failed
download failing the build, `piPackages`/`herdrPlugins` comma-splitting, and both `die`
paths), `features/agents/test/claude_json_test.sh` (the real `post-create.sh` against a
temp `HOME` with `stat`/`sudo` stubbed: ownership repair and every `~/.claude.json` case
including move-don't-delete and repoint-a-stale-link).

With Docker: the default scenario is the bare `{}` case. `scenarios.json` adds
`with_seed`, `with_copilot`, `with_pi`, `with_herdr`, `with_pi_packages` and
`with_herdr_plugins`. The last three hit the network by design.

Two `grep`s in `install_options_test.sh` assert that the seed path `install.sh` creates
and the one `post-create.sh` reads are still the same string — that is what replaced the
bake guard when the path options were removed.

**bash-config** — offline: `init_test.sh` (the sourcing logic), `install_options_test.sh`
(the option and the block), `post_create_test.sh` (the symlink, `env.sh`, the refusal
path).

With Docker: the default scenario is the bare `{}` case, plus `bare_no_env`, `both_dirs`
and `live_edit`. The default scenario is also what **measures** two things the offline
harnesses cannot: the cwd a Feature-declared `postCreateCommand` is given, and the
`chown` of `dirs/` to the remote user.

**devc-bridge** — offline: `install_link_test.sh` (the symlink block extracted from the
real `install.sh`), `install_download_test.sh` (arch → asset mapping, and the failure
paths — bad checksum, missing asset, unsupported arch — that must abort with nothing
installed, against a fixture release served over `file://`).

With Docker and a network, but **no host bridge**, since nothing is mounted: builds a
real container and asserts the client is installed, root-owned, on PATH and reports the
expected version.

**devc-config** — offline, and the most important tests for this Feature:
`devc/tests/devc_config_test.sh features/devc-config/post-create.sh` (eight cases: a
`.devc/` hook running, a `.devcontainer/` hook running when `.devc/` is absent, `.devc/`
winning when both exist, a non-executable `.devc/` failing create without falling
through, a dangling symlink graded as a failure rather than an absence, neither path
present being a silent no-op, a hook exiting non-zero failing the block, and the hook's
cwd being the project root) and
`devc/tests/bashrc_additions_test.sh features/devc-config/post-create.sh` (the marker
landing in a fresh `~/.bashrc`, existing content surviving, idempotence, the
`DEVC_ATTACH` guard, and a whole-file case proving the two fences run in order).

With Docker: the default bare `{}` case with no hook fixture, plus `with_hook` and
`devcontainer_dir_hook`. The five failure paths are **not** container scenarios,
deliberately: `devcontainer features test` has no way to assert that a create genuinely
_failed_, since a failing `postCreateCommand` aborts the run it would report from.

**git-container-config** — offline: `git_config_test.sh` runs the real, installed
`post-create.sh` against a temp `HOME` with `GIT_CONFIG_GLOBAL` pointed into it and a
temp `SHARE_DIR`. Covers the identity include set and skipped, the defaults landing,
`safeDirectory: ""` omitting the setting, a second run being idempotent, the
missing-identity warning on **stderr** with exit `0`, and `git-lfs` absent warning while
the other settings still apply.

With Docker: the bare `{}` case asserting the settings land in the **remote user's**
`~/.gitconfig` and not `/root/`'s, plus `with_git_lfs` and `mounted_identity`.

**node-nvmrc** — offline: `install_options_test.sh` (all four options through to the baked
`post-create.sh`, the values that must fail the build, the ones that must survive
verbatim, the empty-`projectDir` distinction, the user-owned `pin/`, that no startup file
is written under any option combination, and that all four files naming
`/usr/local/share/devc-features/node-nvmrc` still agree), `post_create_test.sh` (the
symlink and its idempotency, every `projectDir` resolution, and the grading of each
failure path).

With Docker: the default scenario is the bare `{}` case on a base image with **no nvm in
it**, which is the hostile one. `scenarios.json` adds `with_nvmrc`, `no_nvmrc`,
`project_subdir` and `pin_outranks_current` — that last one is the only test that can
isolate the `containerEnv` merge ordering, since every other scenario would pass even if
this Feature's PATH entry landed _behind_ `$NVM_DIR/current/bin`. `with_nvmrc` also keeps
checking that two consecutive `npm ci` runs work over the mounted volume, since nothing
pins npm.

**podman-as-docker** — offline: `install_options_test.sh` runs the real `install.sh`
against temp directories with `apt-get` stubbed: every option's effect on the generated
config files, the validation guards, subuid/subgid handling, and the mutual-exclusion
check.

With Docker, and needing a base image that actually carries a podman package:

```sh
bash features/podman-as-docker/test/run-features-test.sh \
  --base-image mcr.microsoft.com/devcontainers/base:ubuntu-24.04
```

The default scenario is the strongest claim this Feature makes: `docker run` has to work
with **zero** `runArgs`. `scenarios.json` adds `with_tun`, `with_socket`, `with_volume`
and `no_shim`.

## Per-Feature maintainer notes

### agents

`post-create.sh`'s `devc:seed-link` block is byte-identical to devc's own copy apart from
its two parameterizing assignments, which is what lets `devc/tests/seed_link_test.sh` run
against both unmodified. Keep it self-contained: parameterized only by `SEED` and
`CLAUDE_DIR`, no `sudo`, no paths outside them.

The declared `~/.claude` volume targets the literal `/home/vscode/.claude`, because no
`devcontainer.json` variable names the remote user's home. `post-create.sh` warns when
the real home differs and still exits `0`.

### devc-bridge

**Do not add a `mounts` key to `devcontainer-feature.json`.** It would reintroduce the
off-schema string-mount dependency this Feature was rewritten to shed _and_ collide with
the consumer's own mount. `devc/tests/default_config_test.ts` asserts the key is absent.

`DEVC_TOOLS_RELEASE` in `install.sh` is not this Feature's version. Bump `version` when
this Feature changes; bump `DEVC_TOOLS_RELEASE` when you want a newer client — which is
itself a Feature change, so it bumps both.

### devc-config

`post-create.sh` holds two fenced blocks — `devc:devc-config` and
`devc:bashrc-additions` — and `devc/tests/devc_config_test.sh` and
`devc/tests/bashrc_additions_test.sh` each extract their own fence and run it against the
file directly. **Nothing inside either fence may be reformatted, reworded, or have a
comment dropped for tidiness**; every line inside them is load-bearing for one of the
cases those harnesses assert. `BASHRC=` is the second fence's one parameter and must stay
a bare assignment at the start of a line, because the harness re-points it with `sed`.

This Feature has no options on purpose. The candidate hook paths are hardcoded inside a
fence, so making either an option would mean rewriting a line inside it. And a
`projectDir` option could not be usefully set by devc anyway: measured against
`@devcontainers/cli` 0.88.0, `--additional-features` JSON is stored raw from argv and
never passes through the CLI's substitution pass, while a config's own `features` block
is substituted along with the rest — so devc could not pass `${containerWorkspaceFolder}`
through an option here even if one existed.

`devc up` contributes this Feature to every container it starts via
`--additional-features`; devc's bundled `devcontainer.json` does not declare it. See
`devc-core/overlay.ts`'s `DEVC_CONFIG_FEATURE` and `withBaselineFeatures`. devc matches
by Feature _name_, not exact id string, so a consumer declaring it under any tag replaces
devc's entry rather than adding a second — which matters because the devcontainer CLI
dedupes `--additional-features` against a config's `features` by exact id string, and two
tags of the same Feature would both install.

### node-nvmrc

The path `/usr/local/share/devc-features/node-nvmrc` appears in four places: the
manifest's `containerEnv` PATH entry, the manifest's `postCreateCommand`, `install.sh`'s
`SHARE_DIR` default, and `post-create.sh`'s own default. Nothing but
`test/install_options_test.sh` catches a rename.

`installsAfter` names the node Feature rather than `dependsOn`, because `dependsOn` would
install it with _this_ Feature choosing its `version`, `pnpmVersion` and `nvmVersion`.
The ordering also puts this Feature's `ENV` line after the node Feature's, which is what
lands `pin/bin` ahead of `$NVM_DIR/current/bin` — `pin_outranks_current` is the only test
that catches a regression there.

### podman-as-docker

The manifest declares `capAdd: ["SYS_ADMIN"]` and three `securityOpt` flags
unconditionally. Each was found by hitting its own specific failure, not added
speculatively:

1. `SYS_ADMIN` and `systempaths=unconfined` — measured on Docker Desktop's LinuxKit VM,
   which runs with no seccomp filter and no AppArmor profile applied. That made the
   original finding true there and silently untested against what a stock Linux host adds
   on top.
2. `apparmor=unconfined` (0.1.1) — the `docker-default` AppArmor profile's blanket
   `deny mount,` rule blocking Podman's own storage setup.
3. `seccomp=unconfined` (0.1.2) — the `docker-default` seccomp profile blocking the
   `keyctl()` syscall `crun` uses to create the container's session keyring.

Both of the last two were found by
[`.github/workflows/test-podman-as-docker.yml`](../.github/workflows/test-podman-as-docker.yml)
(`workflow_dispatch`, manual), which runs on a GitHub-hosted `ubuntu-latest` runner — a
real Linux Docker Engine host — and first asserts the `docker-default` seccomp and
AppArmor profiles are actually enforced there before running all five Docker scenarios.
With both privilege walls down it also surfaced a third, unrelated bug: the API socket's
directory is owned by a UID the devcontainer CLI's post-build UID remap never repairs (it
only repairs `$HOME`). Fixed in 0.1.2 by `post-start.sh`'s ownership repair.

All five scenarios pass on that runner as of 0.1.2. "Measured on two hosts" is not
"proven for all hosts" — the manifest could plausibly need a fourth thing on an
environment neither Docker Desktop nor a GitHub Actions runner represents. **Still not
run against SELinux** (a Fedora/RHEL/CentOS host); some upstream "podman in a
devcontainer" examples also carry `--security-opt label=disable`, and nobody has
confirmed whether it is actually needed.

`privileged` is never declared. That is the line this Feature exists not to cross. If
that trade is unacceptable for a given container, the dind-rootless sidecar recipe in
[`../.plans/design/devcontainer-agent-sandbox-hardening.md`](../.plans/design/devcontainer-agent-sandbox-hardening.md)
is the right answer instead.

Podman config key names are confirmed against both major versions this Feature was
measured on: 4.9.3 (Ubuntu 24.04, default rootless backend `slirp4netns`) and 5.7.0
(Ubuntu 26.04, default `pasta`). `[containers] netns` and
`[network] default_rootless_network_cmd` exist unchanged on both.
