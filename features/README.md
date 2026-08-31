# devcontainer Features

This directory is a devcontainer Feature **collection**: `features/` is the
collection, and each `features/<id>/` is one Feature published as its own OCI
artifact. Adding a directory here is the whole of adding a Feature —
[`publish-feature.yml`](../.github/workflows/publish-feature.yml) derives its
publish matrix from the collection rather than naming its members, and so does
[`tests/features_test.sh`](../tests/features_test.sh), the guard it runs.

## Published Features

| Feature                                                | Ref                                       | What it does                                                                                                                                                                                                                        |
| ------------------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [agents](agents/README.md)                             | `ghcr.io/devc-tools/agents`               | Installs coding-agent CLIs (Claude Code, optionally Copilot); links a host config seed into `~/.claude` and folds `~/.claude.json` into it, so one volume holds all Claude state. No path options — mount onto the fixed seed path. |
| [bash-config](bash-config/README.md)                   | `ghcr.io/devc-tools/bash-config`          | Sources `bashrc_*.sh` from `~/.bashrc` out of two fixed directories.                                                                                                                                                                |
| [devc-bridge](devc-bridge/README.md)                   | `ghcr.io/devc-tools/devc-bridge`          | Installs the devc-bridge client so container code can invoke host commands.                                                                                                                                                         |
| [devc-config](devc-config/README.md)                   | `ghcr.io/devc-tools/devc-config`          | On every container create, runs the project's own `devc-post-create.sh` if it has one — `.devc/` first, then `.devcontainer/`, first hit wins. **devc contributes this one to every container it starts by default** — see below.   |
| [git-container-config](git-container-config/README.md) | `ghcr.io/devc-tools/git-container-config` | Re-applies the user-scope git settings a devcontainer needs and cannot keep — LFS filters, `worktree.useRelativePaths`, `safe.directory`, and an identity include.                                                                  |
| [node-nvmrc](node-nvmrc/README.md)                     | `ghcr.io/devc-tools/node-nvmrc`           | Makes the Node version a workspace pins in `.nvmrc` the one every process in the container gets.                                                                                                                                    |
| [shell-dirs](shell-dirs/README.md)                     | `ghcr.io/devc-tools/shell-dirs`           | Sources every `*.sh` in a project (and optionally a personal) directory in every interactive shell.                                                                                                                                 |

The tag tracks **each Feature's own** version line: `:0` while that Feature is
pre-1.0, `:1` at its first 1.x release. It is not the repo's version — see
[Versions](#versions).

`node-nvmrc`, `agents`, `bash-config` and `git-container-config` are
**published and public** — an unauthenticated pull resolves each, so the
`:0` refs in the tables above and in `devc/README.md` work today.
`devc-config` publishes under its current id; it was briefly published as
`project-hook` before being renamed (see
[devc-config/README.md](devc-config/README.md#relationship-to-devc)) — the
old id is orphaned on ghcr.io and no longer referenced anywhere in this
repo. When devc injects `devc-config` it is pinned at an exact version
(`0.1.0`) rather than `:0` — see `devc-core/overlay.ts`'s
`DEVC_CONFIG_FEATURE` — because that injection reaches every container devc
starts, with no opt-in anywhere; a manual `"devc-config": {}` in your own
config still floats on `:0` like any other Feature here. `devc-bridge` is on
the publish allowlist but **not published yet**: it pins
`DEVC_TOOLS_RELEASE='v0.1.0'`, and until that release is tagged its publish
job fails the pin guard by design. `shell-dirs` is **not on the publish
allowlist** — still under active development and deliberately held back
from ghcr.io. See [The publish allowlist](#the-publish-allowlist), and
[Versions](#versions) for why each Feature publishes on its own.

**`bash-config` supersedes `shell-dirs`**, and the two are not meant to be
enabled together: they write different blocks, so a container with both sources
its project directory twice. `shell-dirs` stays in the tree until `bash-config`
has been verified under Docker — retiring it is a later plan. The difference
is structural: `shell-dirs` keeps its sourcing loop _inside_ `~/.bashrc` and
has both halves of the Feature rewrite lines within it, while `bash-config`
puts a static one-line block in `~/.bashrc` naming two fixed container
directories, so nothing rewrites anything. See
[bash-config/README.md](bash-config/README.md#relationship-to-shell-dirs).

**`devc-config` is the one Feature devc contributes to every container it
starts, with no opt-in — and it is the only route in.** `devc up` adds it to
whatever `devcontainer.json` is in play via `--additional-features`, purely
dynamically: the bundled `devcontainer.json` devc's zero-config path
materializes and `devc init` scaffolds does **not** declare it itself, unlike
every other injection-eligible Feature idea this repo has considered. That
means a `devc init`-scaffolded project run with a plain `devcontainer up` and
no `devc` installed will not run this Feature — deliberate, since what it
does (running a script written specifically for devc's own convention) is
devc-specific to begin with. devc's own former copy of the same script
(`devc-core/default/scripts/project-hook.sh`) is retired, so there is now
exactly one copy to run and no double-run hazard. Declaring the Feature
yourself, under any tag, replaces devc's injected entry rather than adding a
second one — see
[devc-config/README.md](devc-config/README.md#devc-includes-this-automatically--dynamically-not-baked-in)
and `devc/README.md`'s
[Project post-create hook](https://github.com/devc-tools/devc-tools/blob/main/devc/README.md#project-post-create-hook-devc-post-createsh)
section.

## Layout

```
features/
  PUBLISH_ALLOWLIST.txt         # ids allowed to publish — see below
  <id>/
    devcontainer-feature.json   # id must equal the directory name
    install.sh                  # runs as root at image build time
    README.md                   # what a bare `{}` gives you, plus any mount recipe
    scripts/                    # optional; whatever install.sh installs
    test/
      test.sh                   # the default `devcontainer features test` scenario
      scenarios.json            # optional; extra scenarios, one <name>.sh each
      run-features-test.sh      # wrapper for the above (see below)
      *_test.sh                 # offline harnesses over blocks of install.sh
```

Each Feature is **self-contained** — that is what `devcontainer features publish`
packages, and there is deliberately no `features/common/`. Two Features that both
append to `~/.bashrc` duplicate those lines instead of sharing them; a shared
directory would either be missing from both artifacts or duplicated into both,
and the second is at least honest about it.

A Feature declares **no host bind mounts**. It cannot declare a read-only one
(the published Feature schema's `Mount` has no `readonly`), and it cannot create
a bind source (Features cannot declare `initializeCommand`). Anything
host-coupled belongs to the consumer's `devcontainer.json`, so each Feature's
README carries the mount line to paste. See
[../.plans/design/devc-feature-split.md](../.plans/design/devc-feature-split.md)
for the reasoning, and `devc-bridge/README.md` for the shape.

## Versions

**Every Feature versions itself.** The `version` in a `devcontainer-feature.json`
is that Feature's own, unrelated to the repo's `vX.Y.Z` tag and to the other
Features. Two Features at different versions is the normal state here, not drift.
The binaries still move in lockstep on one tag — see the root
[README's Releasing section](../README.md#releasing) — but a Feature is pulled
from ghcr by a consumer's `devcontainer.json`, not installed by `install.sh`, so
nothing needs the coupling. It only ever cost: a byte-identical Feature getting a
new digest because some unrelated tool changed, and a one-line Feature fix
needing a full binary release. (Reasoning:
[.plans/archived/feature-independent-versions.md](../.plans/archived/feature-independent-versions.md).)

**Bump what you changed, in the same commit.** A push to `main` touching
`features/` publishes each Feature from its own matrix job, so:

- bump a Feature's `version` when that Feature changes — nothing else has to move;
- leave it alone and the publish is a no-op. `devcontainer features publish` skips
  a version already in the registry, prints `Version X already exists, skipping`,
  and pushes nothing. So "I forgot to bump it" shows up as "nothing published" in
  the run that changed it, not silently at the next release.

A new Feature starts at `0.1.0`.

A Feature that downloads a release asset bakes `DEVC_TOOLS_RELEASE='<tag>'` into
its `install.sh`, naming the devc-tools release it fetches from — **not its own
version**; the two are independent and only ever looked equal because the old
rule forced them to be. It is duplicated out of the manifest because the manifest
is JSON and no `jq` is guaranteed in an arbitrary base image. Only `devc-bridge`
has one today. **Do not add one to a Feature that fetches nothing** — a Feature
that downloads nothing must not be made to invent a version.

`bash tests/features_test.sh --check-release-pins` asserts every pinned release
exists, which the old tag trigger used to guarantee by accident: publishing from
`main` otherwise lets a Feature ship pinned to a release nobody has tagged yet.

## The publish allowlist

A Feature that reaches every guard above still does not publish unless its id is
listed in [`PUBLISH_ALLOWLIST.txt`](PUBLISH_ALLOWLIST.txt), one id per line (`#` comments
and blank lines are ignored). This is the gate for a Feature under active
development: add its directory, get its manifest right, run its tests — it still
sits invisible to ghcr.io until you add it here. No half-finished Feature
auto-publishes just because it touched `main`.

It is deliberately the one static list in this collection. Everywhere else a
Feature is _discovered_ by walking `features/*/devcontainer-feature.json`,
precisely so a guard can never be left naming only the old Features — see
[.plans/archived/features-collection.md](../.plans/archived/features-collection.md).
The allowlist does not reopen that failure: leaving a Feature off it fails
**safe** (it does not publish), where the old failure mode failed **unsafe** (it
published unguarded). `bash tests/features_test.sh` checks every entry names a
real Feature, so a stale or misspelled id is caught rather than silently doing
nothing forever.

It is **source-only**. `devcontainer features publish` packages one Feature's own
`features/<id>/` directory; `PUBLISH_ALLOWLIST.txt` lives at the collection root,
outside every Feature directory, so it is never part of a published artifact.

`publish-feature.yml`'s `discover` job builds its matrix from this file, and its
`collection-index` job stages a copy of only the allowlisted Feature directories
before republishing the collection index — both so a held-back Feature cannot
appear in either place. Currently allowlisted: `devc-bridge`, `node-nvmrc`.

## Guarding the collection

```sh
bash tests/features_test.sh                       # the whole collection, offline
bash tests/features_test.sh --feature node-nvmrc  # one Feature
bash tests/features_test.sh --check-release-pins  # + the network check above (needs gh)
```

Per Feature it checks that `id` equals the directory name (`features package`
names the artifact from it, and a mismatch surfaces as a baffling packaging
error), that `version` parses as semver (the whole tag set is derived from it),
and that `name` and `description` are non-empty (`features package` refuses the
Feature otherwise, far from the cause). It walks the collection, reports every
offender, and fails on an empty glob — a guard that finds nothing to check must
not pass.

`publish-feature.yml` runs it twice: once over the whole collection before the
matrix, and once per Feature with `--feature` so one Feature's failed guard
cannot fail another Feature's publish.

## No collection index is published

`devcontainer features publish` also pushes a metadata-only artifact — one
`devcontainer-collection.json` layer listing what is in the collection — to the
namespace itself, with no trailing `/<id>`. There is no flag to suppress it, and
this repo does not have anywhere to put it.

Features publish under `--namespace <owner>`, so they land on
`ghcr.io/devc-tools/<id>`. The index ref the CLI derives from that same namespace
is `ghcr.io/devc-tools`: a registry and an owner with no package name, which GHCR
rejects. (The CLI's own path validation accepts a single segment, so the failure
comes from the registry, not from packaging.) Publishing the index would require
`--namespace <owner>/<repo>`, which would push every Feature one segment deeper,
at `ghcr.io/devc-tools/devc-tools/<id>`.

Nothing in this repo read it anyway — `devc` never resolves a Feature version,
and `devcontainer features info` goes through a Feature's own OCI annotations.
Each run still pushes its own one-Feature view of that document; it is inert.

## Running a Feature's tests

Every Feature has `test/run-features-test.sh`, and it is the same file in each
one:

```sh
bash features/<id>/test/run-features-test.sh
```

It needs **Docker** (and a network, if the Feature downloads anything), so it is
run deliberately and not from `deno task test`.

The wrapper exists because `devcontainer features test` insists on a collection
laid out as `<project>/src/<id>/` + `<project>/test/<id>/`, while `publish` wants
the flat `features/<id>/` this repo keeps. Rather than split one Feature across
two trees, the wrapper stages a throwaway copy in a tempdir: the whole Feature
directory minus its `test/`, plus the whole `test/` minus the wrapper itself, in
the place the command looks for it. Both copies are wholesale on purpose — a
per-file list drops a Feature's `scripts/` from the build, or its
`scenarios.json` from the test run, and both failures surface far from the
omission. Copy it into a new Feature unchanged — it derives the id from its own
path and has nothing per-Feature in it.

A Feature with a `test/scenarios.json` gets those scenarios run too, each from
its own `test/<name>.sh`. A scenario may name external Features by their full
`ghcr.io/...` ref, and its own `onCreateCommand` runs before **every**
`postCreateCommand` — which is the only way to have a workspace fixture in place
before a Feature's own create-time hook looks for one, since the command
generates the workspace folder itself.

Most Features also have offline harnesses under `test/` that extract a fenced
block from the real `install.sh` and run it directly. Those need no Docker and
are the ones to reach for first; each Feature's README lists its own.
