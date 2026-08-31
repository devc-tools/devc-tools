# Splitting devc's baseline into devcontainer Features

Assessment doc for the `feature-*` plans in `.plans/`. It answers one question
once, so five plans do not each re-derive it: **which pieces of `devc/default/`
can a Feature declare, and which must be declared by whatever
`devcontainer.json` consumes it?**

The second group is the confusing one, and it is smaller than it looks. It does
_not_ mean "requires devc" — see "Stays in devc does not mean needs devc" below.

Nothing here is a work item. The plans that cite it are.

## The constraint that decides everything

A Feature's whole vocabulary is `devcontainer-feature.json` plus an `install.sh`
that runs **as root, at image build time**. Verified against the published
schema (`schemas/devContainerFeature.schema.json`) and the spec page:

| Feature can                                                                                                 | Feature cannot                                                                                                    |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `options` (string/boolean, `enum`/`proposals`)                                                              | declare `initializeCommand` — **no host-side hook at all**                                                        |
| `containerEnv`                                                                                              | declare a **read-only** mount (the schema's `Mount` has no `readonly`)                                            |
| `mounts` — **objects only**, `type` + `target` (+ `source`)                                                 | declare a mount as a **string** (the `anyOf: [Mount, string]` is `devcontainer.json`'s, not the Feature schema's) |
| `onCreateCommand`, `updateContentCommand`, `postCreateCommand`, `postStartCommand`, `postAttachCommand`     | create a bind mount's **source** on the host                                                                      |
| `installsAfter`, `dependsOn`, `privileged`, `init`, `capAdd`, `securityOpt`, `entrypoint`, `customizations` | read host state (git identity, a `~/.config` tree) at any point                                                   |

Two consequences, and they are the whole story:

1. **A read-only host bind cannot come from a Feature.** Already established the
   hard way in [devc-bridge-client-download](../archived/devc-bridge-client-download.md):
   the CLI re-serializes an object mount as `type=,src=,dst=` and drops
   `readonly`, and the string form that _does_ pass through verbatim is not in
   the Feature schema. Only a `devcontainer.json` `mounts` array can express one.
2. **A bind mount's source must already exist**, and `--mount type=bind` on a
   missing source is a hard create failure, not a warning. Something host-side
   has to `mkdir` it — which in devc is `initialize-command.sh`, a hook no
   Feature may declare.

So the dividing line is not "how generic is this logic". It is:

> **Does this piece need host state, or a read-only bind?** If yes it must be
> declared by the **consumer's `devcontainer.json`** — which for devc's own
> containers means `devc/default/`, however generic the logic looks. If no, it is
> Feature material, however devc-flavored it looks today.

Read the next section before concluding that the second half means "needs devc".
It does not.

## The verdict, piece by piece

| Piece                                                          | Lives in                               | Feature? | Why                                                                                                                                                  |
| -------------------------------------------------------------- | -------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nvm install` from the project's `.nvmrc`                      | `scripts/node-setup.sh`                | ✅ whole | Reads the **workspace**, not the host. No mount.                                                                                                     |
| `nvm use` on `cd`                                              | `scripts/bashrc-additions.sh`          | ✅       | A `~/.bashrc` append; `install.sh` can do that.                                                                                                      |
| `node_modules` chown                                           | `scripts/node-setup.sh`                | ✅ (opt) | Fixes a **volume** mount devc declares; the fix itself is portable.                                                                                  |
| Sourcing `*.sh` from **project** `.devcontainer/shell/`        | `devc:shell-dirs` fence                | ✅       | Workspace path, found through `$PROJECT_PATH`. No mount.                                                                                             |
| Sourcing `*.sh` from **user** `~/.config/devc/shell/`          | same fence + a mount                   | ⬖ mount  | Read-only host bind. **Consumer-declared** — devc writes it for you.                                                                                 |
| git LFS filters, `worktree.useRelativePaths`, `safe.directory` | `scripts/git-setup.sh`                 | ✅       | Pure container-scope `git config`. Nothing host-side.                                                                                                |
| git `user.name` / `user.email`                                 | `initialize-command.sh` + a mount      | ⬖ both   | Host state extracted host-side, then a read-only bind. Both consumer-declared.                                                                       |
| Claude / Copilot CLI install                                   | `Dockerfile`                           | ✅       | `curl \| bash` as the remote user at build time.                                                                                                     |
| `~/.claude` volume ownership, `~/.claude.json` volume link     | `scripts/agents-setup.sh` + two mounts | ⚠️ maybe | Volumes _are_ declarable by a Feature — but the per-workspace names need `${localWorkspaceFolderBasename}` to substitute there, which is unmeasured. |
| `~/.claude` **seed** symlinks                                  | `devc:seed-link` fence + a mount       | ⬖ mount  | Read-only host bind. **Consumer-declared** — devc writes it for you.                                                                                 |

## "Stays in devc" does not mean "needs devc"

The ⬖ rows above are the easiest thing on this page to misread, so read this
before writing any of the plans. ⬖ marks a piece the **Feature cannot declare**,
not a piece that requires devc.

A host-coupled piece is **not** owned by devc. It is owned by **the consumer's
`devcontainer.json`** — a file every devcontainer project has, devc or not. Any
project can write a read-only bind mount; any project can write an
`initializeCommand` (only _Features_ cannot). What devc actually contributes is
that it writes those lines **for you**, and picks the host paths
(`~/.config/devc/...`) they point at.

So the split is:

- **The Feature owns the mechanism** — the loop that sources a directory, the
  `git config` calls, the symlink walk — parameterized by container paths, and
  it declares **no host mounts**.
- **The consumer owns anything host-coupled** — the read-only bind, the
  `initializeCommand` `mkdir`, the host-state extraction — and tells the Feature
  where it landed via an **option**.
- **devc is one consumer.** A well-configured one that does it automatically.

This is not a new idea in this repo — it is exactly how the shipped
`devc-bridge` Feature already works. It declares no mounts; the token bind lives
in the consumer's `devcontainer.json`; non-devc projects use it by copying one
mount line out of its README; devc writes that same line into the config it
materializes. One mechanism, two consumers.

The test of whether a Feature here is honest is therefore **not** "does it do
everything without devc" but:

> **Does `"<feature>": {}` — no options, no mounts, no devc — install cleanly and
> do something useful?**

For all four, yes:

| Feature                | What a bare `{}` gives you                                                                  | What an added mount buys                           |
| ---------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `node-nvmrc`           | Everything. `.nvmrc` installed at create; every process gets that version.                  | n/a — it has no mount                              |
| `shell-dirs`           | The project layer: every `*.sh` in the repo's own `.devcontainer/shell/`.                   | A second layer of _personal_ scripts from the host |
| `git-container-config` | LFS filters, `worktree.useRelativePaths`, `safe.directory` — the majority of the script.    | Your host `user.name` / `user.email`               |
| `agents`               | The CLI installs. Plus the `~/.claude.json` and seed wiring as soon as anything is mounted. | Per-workspace persistence; a host config seed      |

The optional half is **personal-host-machine state** in every case — your shell
preferences, your git identity, your Claude config. That is the one category a
container genuinely cannot invent for itself, and no packaging choice changes
that. A Feature that claimed to supply it would be lying.

Each Feature README therefore carries the **copy-paste recipe** — the mount line,
and the `initializeCommand` that creates its source — so a non-devc project
reaches full parity by pasting two lines. Not by installing devc.

## Rules the plans inherit

- **`{}` must work, and no Feature may declare a host bind mount.** Every option
  defaults to the **standalone** behavior, never to devc's paths — no
  `/usr/local/share/devc/...` default, no assumption that a mount exists. A
  Feature that is inert until devc configures it has failed this rule, and the
  plan's `devcontainer features test` scenario must include a bare `{}` case that
  proves otherwise. devc supplies its paths explicitly at swap time, like any
  other consumer would.
- **Every Feature README carries the copy-paste recipe** for the optional
  host-coupled half: the exact mount line, and the `initializeCommand` that
  creates its source. That is what makes "usable without devc" true in practice
  rather than in principle — see `features/devc-bridge/README.md`, which already
  does this for the token mount.
- **No shared code between Features.** Each publishes as its own OCI artifact
  with only its own directory in it. Two Features that both append to `~/.bashrc`
  duplicate that ~10 lines. Deliberate; do not invent a `features/common/`.
- **Copy, don't move.** Every `feature-*` plan _copies_ logic out of
  `devc/default/` and leaves the original running. Nothing in `devc/default/`
  changes until the Features are published and a separate swap plan lands. A
  half-swapped baseline that depends on an unpublished `ghcr.io` ref breaks every
  `devc up` — the exact failure [devc-bridge-feature](../archived/devc-bridge-feature.md)
  had to reverse.
- **Keep the fence marker names.** `devc:seed-link`, `devc:shell-dirs`,
  `devc:devc-config` name _blocks_, not owners. A Feature's copy keeps the same
  markers and the same parameter variable names, so `devc/tests/*_test.sh` — which
  already take the script path as `$1` — run against the copy unchanged. That is
  what stops the two copies drifting during the interim.
- **`/usr/local/share/devc-features/<id>/`** for Feature-installed scripts.
  `/usr/local/share/devc/` is devc's baseline namespace (post-create, scripts,
  claude-seed, gitconfig-identity, shell) and stays devc's. Not sharing the
  prefix is what keeps "did devc put this here, or a Feature?" answerable.
- **Hardcoded `vscode` becomes `$_REMOTE_USER`.** `install.sh` gets
  `_REMOTE_USER`, `_REMOTE_USER_HOME`, `_CONTAINER_USER`, `_CONTAINER_USER_HOME`.
  Every path baked at build time uses them; nothing assumes a `vscode` user or a
  `sudo` that exists.
- **Every option is opt-outable and defaults to today's devc behavior**, so the
  eventual swap is a no-op in observable terms.
- ~~**One repo, one tag.** `publish-feature.yml` packages `./features` as a
  collection and its version guard demands tag == every Feature's `version`, the
  same rule the binaries follow. New Features join at the repo's current
  version.~~ **Superseded by
  [feature-independent-versions](../archived/feature-independent-versions.md).** The
  decision this borrowed from ([release-and-installer](../archived/release-and-installer.md)
  decision 8) is about the **installer** resolving one version across the eight
  tarballs it fetches; Features are pulled from ghcr by a consumer's
  `devcontainer.json` and `devc` never resolves a Feature version at all. Each
  Feature now carries its own `version`, bumped when that Feature changes, and
  publishes on a push to `main` under `features/`. `publish-feature.yml` still
  packages `./features` as a collection and its guard still walks the collection
  rather than naming a Feature; it no longer compares anything to a tag. **A new
  Feature starts at `0.1.0`, not at the repo's version.**

## Open questions the plans must measure, not assume

Each is called out in the plan that depends on it. None blocks writing the plan;
all block calling it done.

1. **cwd of a Feature-declared `postCreateCommand`.** Assumed to be the workspace
   folder. Every script here uses `${PROJECT_PATH:-$PWD}` so it survives either
   answer, but the `.nvmrc` lookup is only correct under one of them.

   **Read from the CLI's source, not yet measured** ([feature-node-nvmrc](../archived/feature-node-nvmrc.md)).
   `runLifecycleHook` in `src/spec-common/injectHeadless.ts` computes
   `remoteCwd = containerProperties.remoteWorkspaceFolder || containerProperties.homeFolder`
   once and passes it as the cwd of every lifecycle command; Feature-contributed
   commands reach it through the same `runLifecycleCommands` loop as the ones from
   `devcontainer.json` (they differ only in the `origin` used for logging). So the
   answer is **the workspace folder whenever there is one**, and the remote user's
   home otherwise. Nobody has run a container to confirm it — no Docker in the
   environment where node-nvmrc was written — so `${PROJECT_PATH:-$PWD}` stays, and
   `features/node-nvmrc/test/scenarios.json`'s `with_nvmrc` scenario is what will
   actually measure it: its first check fails if the hook did not find the `.nvmrc`
   an `onCreateCommand` wrote at the workspace root.
2. **Substitution inside Feature `mounts`.** ~~`${localEnv:HOME}` is measured
   working (devc-bridge-feature findings). `${localWorkspaceFolderBasename}`,
   `${containerWorkspaceFolder}` and `${devcontainerId}` are **not** — and the
   `agents` volumes need them for per-workspace isolation.~~ **Closed —
   measured, all four substitute.** `${devcontainerId}` is the variable the
   spec added for exactly this purpose (a stable unique id for Features naming
   their own volumes) and was folded into this question rather than left
   unasked. See
   [`mount-substitution-spike`](../implemented/mount-substitution-spike.md) for
   the fixture and full method. Measured with `@devcontainers/cli 0.89.0`:

   | Variable | Substitutes to |
   | --- | --- |
   | `${devcontainerId}` | `volspike-id-13gra4npo69h23i10h25gq869gjtjet092p9ushcd11d6sdutp0c` |
   | `${localWorkspaceFolderBasename}` | `volspike-base-mount-substitution` |
   | `${containerWorkspaceFolder}` | mount landed under the workspace folder — `findmnt` showed `/workspaces/devc-tools/tests/fixtures/mount-substitution/.volspike-target` |

   All three built cleanly; no create failure, no silent shared-volume
   collapse. Re-run with `tests/fixtures/mount-substitution/` if the CLI
   version moves.
3. **Named-volume ownership seeding.** If `install.sh` creates
   `$_REMOTE_USER_HOME/.claude` owned by the remote user at build time, Docker
   should initialize a first-use empty named volume from that directory's
   contents _and mode_, removing the `sudo chown` at create time. Standard Docker
   behavior; unverified here.
4. **`~/.bashrc` append ordering.** Features install _after_ the Dockerfile, so a
   Feature's `~/.bashrc` block lands **after** devc's `bashrc-additions` block —
   including after the `DEVC_ATTACH` `PROMPT_COMMAND` snapshot that today runs
   last. Matters for `shell-dirs`; see that plan.

**Questions 2 and 3 were both unmeasured as of `feature-claude-config`.** No
Docker in the environment that plan was implemented in either — the same
constraint every other plan here has hit, just fatal to these two specifically
instead of merely postponing a container scenario. The Feature it produced —
published as `claude-config`, renamed to `agents` shortly after (see its
README's "Relationship to devc") — took the safe path the plan itself
specifies for the unmeasured case: it declares **no** `mounts`, and its README
carries the two-volume recipe as a consumer paste instead. Question 3's `sudo
chown` stays in `post-create.sh` regardless, per the plan (cheap,
belt-and-braces either way).

Question 2 is now closed (above), by `mount-substitution-spike`. Declaring the
`~/.claude` volume in the Feature instead of pasting it is a follow-up with its
own version bump and scenarios, not done by that measurement alone — see
`features/agents/README.md` § The volume question. Question 3 is still open
for whoever next has a Docker daemon.
