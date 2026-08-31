# devc swaps onto `agents`/`git-container-config`; `bashrc-additions` moves into `devc-config`

## Goal

Three of `devc-core/default/scripts/`' four remaining baseline steps go away as
devc's own scripts:

1. **`agents-setup.sh`** is retired. devc's bundled `devcontainer.json` declares
   the already-published [`agents`](../features/agents/README.md) Feature
   instead. As of that Feature's `0.2.0` this takes **no** path options: devc
   retargets its seed bind onto the Feature's fixed path and drops its
   `claude-json-*` volume outright (see Contracts).
   The Dockerfile's own Claude/Copilot CLI install steps are retired too — the
   Feature's `install.sh` does that now.
2. **`git-setup.sh`** is retired the same way, onto
   [`git-container-config`](../features/git-container-config/README.md).
3. **`bashrc-additions.sh`** does **not** retire the same way. Its content —
   the custom `PS1`, the terminal-title trap, the `DEVC_ATTACH` first-prompt
   clear — moves _into_ [`devc-config`](../features/devc-config/README.md)'s
   `post-create.sh`, as a second fenced block alongside the existing
   project-hook one. This is deliberate, not a filing convenience: `devc-config`
   is the one Feature devc dynamically injects into **every** container it
   starts, project mode included, so this is what makes devc's prompt/title
   behavior reach a project-mode repo for the first time. Everything else
   devc bundles (`agents`, `git-container-config`, `bash-config`, `node-nvmrc`,
   `node`, `python`, …) stays zero-config/`devc init`-only, same as today.

With all three gone, `devc-core/default/scripts/`, `post-create.sh` and the
bundled config's `onCreateCommand` have nothing left to do — see
[Contracts](#devc-coredefault--post-createsh-scripts-and-oncreatecommand-removed)
for why this plan removes them outright rather than leaving an empty
orchestrator.

## Why this reopens the ordering question

[`devc-inject-project-hook`](archived/devc-inject-project-hook.md) put devc's
baseline on `onCreateCommand` specifically so it would precede a
Feature-declared `postCreateCommand` (`devc-config`'s, running the project's
own hook) — the CLI runs every Feature's `postCreateCommand` before the base
config's own, so there was no way to win that race by staying on
`postCreateCommand`.

This plan removes `onCreateCommand` from the picture entirely for two of the
three steps that used to live there: `agents-setup`/`git-setup`'s replacements
(`agents`, `git-container-config`) run via their own Feature-declared
`postCreateCommand`s, the **same phase** `devc-config`'s hook runs in. The
`onCreate`-precedes-`postCreate` trick no longer applies between them — that
was a phase-level lever, and all three are now in the same phase.

The lever that _does_ apply between Features in one phase is `installsAfter`:
the CLI resolves Feature-to-Feature order (both image-layer order and,
consequently, lifecycle-command order) from each Feature's own
`installsAfter`. `devc-config`'s manifest gains
`"installsAfter": ["ghcr.io/devc-tools/features/agents", "ghcr.io/devc-tools/features/git-container-config"]`
so its hook still runs after both, restoring the same guarantee the
`onCreateCommand` trick gave before — but only among Features devc itself
knows to name. See [Concept boundaries](#concept-boundaries) for why this does
not (and cannot) extend to a project's own, unrelated Features.

## Existing touchpoints

- `devc-core/default/devcontainer.json` — `features` gains `agents` and
  `git-container-config` entries; `onCreateCommand` and its comment are
  deleted. `mounts` changes too: the `claude-json-*` volume is deleted, and
  both the `claude-seed` bind and the identity bind are retargeted (see
  Contracts) — the volume deletion is the one place this plan removes
  infrastructure rather than repointing it.
- `devc-core/default/Dockerfile` — the `COPY post-create.sh` / `COPY scripts/`
  / chmod block is deleted; the Claude CLI and Copilot CLI `RUN` steps are
  deleted (the `agents` Feature's `install.sh` does this now). What is left
  after this plan is the `FROM`, the `ripgrep` `RUN`, and the `USER root` /
  `USER vscode` switches that exist only to bracket it — see
  [The Dockerfile stays](#the-dockerfile-stays--but-nothing-may-depend-on-it) for
  the constraint that puts on everything else in this plan.
- `devc-core/default/post-create.sh` — deleted.
- `devc-core/default/scripts/agents-setup.sh` — deleted.
- `devc-core/default/scripts/git-setup.sh` — deleted.
- `devc-core/default/scripts/bashrc-additions.sh` — deleted; its content moves
  into `features/devc-config/post-create.sh` (see Contracts).
- `devc-core/default_config.ts` — four separate edits, not one:
  1. `installBundledAssets`' fixed `executable` list drops `post-create.sh`
     and the `scripts/*.sh` readdir loop (nothing left under `scripts/` to
     chmod — and the `readdir` would **throw**, not no-op, on the absent
     directory).
  2. That same function's **returned** path array drops `${destDir}/post-create.sh`
     and `scriptsDir`. It is the contract `initProject` reports as `written`,
     and `init_test.ts` asserts it element-for-element — easy to miss because
     it sits twenty lines below the `executable` list it mirrors.
  3. `materializeDefaultConfig`'s `postCreateCommand`/`onCreateCommand`
     `replaceAll` rewrite is deleted (there is no such key left to rewrite).
     The `initializeCommand` rewrite is untouched.
  4. `CLAUDE_SEED_TARGET` (`'/usr/local/share/devc/claude-seed'`) — **delete
     the export.** Its value goes wrong the moment the bind is retargeted, and
     it has no code consumers at all: the only reference anywhere is the prose
     of `CLAUDE_SEED_HOST_DIR`'s own doc comment directly above it. That
     comment also has to be repointed — it currently says "`post-create.sh`
     symlinks every top-level _file_ from it", naming a file this plan
     deletes; it should name the `agents` Feature's `post-create.sh` and the
     Feature's fixed target instead. `CLAUDE_SEED_HOST_DIR` itself is the
     **host** path and is unchanged — `container.ts:694` keeps using it.
- `devc-core/default/initialize-command.sh` — two stale comments already
  predate this plan and get fixed in the same pass: "see the `USER_SHELL_DIR`
  layer in `scripts/bashrc-additions.sh`" (that layer left
  `bashrc-additions.sh` for the `bash-config`/`shell-dirs` Features some time
  ago; the comment was never updated) and the general
  `scripts/git-setup.sh` reference. Confirm before editing rather than
  assuming — `git blame` the two lines.
- `features/devc-config/post-create.sh` — gains a second fence,
  `devc:bashrc-additions`, carrying `bashrc-additions.sh`'s **body**. Not a
  verbatim paste: four specific things change on the way in, and pasting the
  file as-is is a defect. Sequencing is a real decision too. Both in Contracts.
- `features/devc-config/devcontainer-feature.json` — `installsAfter` added;
  `version` bumped (a real behavior change to an already-published Feature).
- `features/devc-config/install.sh` — header comment updated: two fenced
  blocks now, not one.
- `features/devc-config/README.md` — documents the second fence, the ordering
  guarantee, and that a non-devc consumer who declares `"devc-config": {}`
  now gets the prompt/title behavior too, not just the project hook.
- `devc-core/overlay.ts` — `DEVC_CONFIG_FEATURE`'s version bumped to match.
- `tests/workflow_guards_test.sh` — the existing `devc_config_pin_agrees`
  guard covers the bump automatically; no new guard needed.
- `devc-core/tests/default_config_test.ts` — **six** sites, not one. Enumerated
  because a cold agent that fixes only the obvious two leaves the suite red:
  1. `'materializeDefaultConfig copies the embedded tree flat to cacheDir…'`
     (~line 276) — the file list drops `post-create.sh` and all four
     `scripts/*.sh` entries.
  2. `'materializeDefaultConfig writes the embedded tree to real disk…'`
     (~line 451) — the same list, again.
  3. `'materialized (zero-config) devcontainer.json…'` (~line 299) — asserts
     `dc.onCreateCommand === 'bash "/usr/local/share/devc/post-create.sh"'`
     and `dc.postCreateCommand === undefined`. Now **both** keys are absent;
     replace with assertions that `agents`/`git-container-config` are declared
     with the options in Contracts. The test's own name says "…the baseline
     runs via a top-level onCreateCommand" and has to be renamed with it.
  4. `withRewrites` (~line 515), the helper `assertBundledExcept` compares
     against — its second `replaceAll` mirrors the rewrite being deleted from
     `default_config.ts` and has to be deleted in lockstep, or every
     `assertBundledExcept` caller fails on `devcontainer.json`'s contents.
  5. `'canonical default devcontainer.json…'` (~line 624) — asserts
     `config.postCreateCommand === 'bash "/usr/local/share/devc/post-create.sh"'`
     on a templates-supplied config; same rewrite, same deletion.
  6. `'a templates subdirectory file overrides the bundled one in place'`
     (~line 574) — this one **loses its subject**: it overrides
     `scripts/node-setup.sh` and then asserts the sibling
     `scripts/agents-setup.sh` came from the bundle, and after this plan
     `default/` has no subdirectory left to override into. Keep the coverage
     rather than deleting it — retarget it as "a templates subdirectory file
     the bundle has no counterpart for is still copied through", asserting the
     file arrives and the bundled top-level files are untouched. (It cannot
     use `assertBundledExcept`, which asserts tree equality.)

  One assertion that looks like it needs editing and does **not**: the bridge
  test's `mounts.filter((m) => m.includes('claude-seed'))` length-1 check
  (~line 1117). The retargeted bind still contains that substring. Leave it.
- `devc-core/tests/init_test.ts` — **three** tests, not one:
  1. `'initProject writes the whole bundled .devcontainer/'` (~line 70) — both
     the `written` array (drops `post-create.sh` and `scripts`) and the
     `.devcontainer/scripts/bashrc-additions.sh` existence assertion below it.
  2. `'initProject makes the lifecycle scripts and scripts/*.sh executable'`
     (~line 74) — asserts `mode(post-create.sh) === 0o755` and then
     `Deno.readDir(`${dir}/scripts`)`, which throws on the absent directory.
     Reduce to `initialize-command.sh`, and rename.
  3. `'initProject writes the template's Dockerfile instead of the bundled one'`
     (~line 210) — asserts `.devcontainer/scripts/node-setup.sh` exists.
     Already failing today (see Validation); this plan removes its subject.
- `devc/tests/seed_link_test.sh` — currently run against **two** copies
  (`devc-core/default/scripts/agents-setup.sh` and
  `features/agents/post-create.sh`); devc's copy is gone, so this becomes the
  only-copy-left-to-test case, the same transition `devc_config_test.sh` went
  through for the project-hook fence.
- `devc/tests/shell_dirs_test.sh` invoked against
  `../devc-core/default/scripts/bashrc-additions.sh` in `devc/README.md`'s
  harness list — **already broken today** (confirmed: `FAIL: could not
  extract shell-dirs block` — `bashrc-additions.sh` has carried no
  `devc:shell-dirs` fence for some time, a leftover from the `shell-dirs`
  Feature's own retirement). This plan deletes the line rather than fixing
  it, since the file it points at no longer exists either way. Not this
  plan's regression, but the line has to go regardless.
- A new `devc/tests/bashrc_additions_test.sh` — offline harness extracting
  the `devc:bashrc-additions` fence from `features/devc-config/post-create.sh`
  and exercising it against a temp `$HOME`, same shape as `devc_config_test.sh`.
  No second copy to run it against — `bashrc-additions.sh` had none either,
  historically.
- `devc/README.md` — more than the two prose lines. The "Claude config"
  section's "`scripts/agents-setup.sh` (run by `post-create.sh`)" line
  (~line 423) and the "Git setup" section's "`scripts/git-setup.sh` (run by
  `post-create.sh`)" line (~line 537) both need to reference the Features
  instead. **Also in the same Claude-config section**, three statements of the
  old container target that a search for "agents-setup" will not surface:
  the prose "bind-mounted read-only at `/usr/local/share/devc/claude-seed`"
  (~line 422), the copy-paste migration snippet's `target=…/devc/claude-seed`
  mount line (~line 468), and the sentence naming "the `claude-seed` mount"
  beside the `initializeCommand` caveat (~line 475). All three become the
  Feature's fixed path.

  That section also needs one thing this plan newly makes true and nothing
  currently documents: **`~/.claude.json` now lives inside the `~/.claude`
  volume**, so the section's closing bullet ("the container's own `~/.claude`
  stays a per-workspace volume, so `projects/`, `todos/`, and credentials
  persist per project") is now the whole story rather than most of it — and
  the one-re-login-per-workspace cost from the `claude-json-*` deletion is
  user-visible and belongs here, not only in this plan's Contracts.

  The fence-harness list (~lines 683-698) drops the two
  `agents-setup.sh`/`bashrc-additions.sh` devc-copy invocations and gains the
  new `bashrc_additions_test.sh` line.
- `docs/manual-verification.md` — new Docker-needed scenarios (see
  Validation).
- `.plans/PLAN.md` — register, then move this plan to `archived/` on
  completion.

## Contracts

### `devc-core/default/devcontainer.json` — the two new Feature entries

```jsonc
"features": {
  // … existing entries …
  "ghcr.io/devc-tools/features/agents:0": {
    // The only option this Feature still takes that devc needs. There are no
    // path options as of agents 0.2.0 — ~/.claude is derived from the remote
    // user's home, and the seed path is fixed. Preserves current behavior:
    // devc's own Dockerfile installs Copilot unconditionally today, and the
    // Feature's own default is false.
    "installCopilotCli": true
  },
  // Bare `{}`, like `bash-config`'s.
  // feature-git-container-config-fixed-identity.md landed first, as required —
  // there is no identityIncludePath left to pass. lfsFilters, lfsSkipSmudge,
  // worktreeRelativePaths, safeDirectory all left at their defaults — they
  // already match git-setup.sh's behavior exactly (confirmed by reading both
  // side by side). Do not restate defaults. The identity bind is retargeted
  // in `mounts` below.
  "ghcr.io/devc-tools/features/git-container-config:0": {}
}
```

Both use the floating `:0`, matching every other bundled Feature except
`devc-config` — these are declared once, statically, the same way
`bash-config`/`node-nvmrc` already are. Nothing about them is forced on every
container the way `devc-config` is: a user who wants to change or remove
either can override `~/.config/devc/templates/devcontainer.json`, the
existing sparse-overlay mechanism every other bundled Feature is already
subject to. No new opt-out mechanism, no `baselineFeatures` involvement —
that key governs only devc's _dynamic_ injection, which stays exactly
`devc-config`, alone.

### `devc-core/default/devcontainer.json` — the mounts `agents` and `git-container-config` 0.2.0 change

Both Features moved their one devc-coupled path off an option and onto a fixed
mount point at `0.2.0`, so both binds below are retargets, not new
infrastructure. `agents` is also where this plan **removes** infrastructure
rather than repointing it (the second volume):

```jsonc
"mounts": [
  // unchanged
  "type=volume,source=claude-code-config-${localWorkspaceFolderBasename},target=/home/vscode/.claude",

  // DELETED — agents 0.2.0 symlinks ~/.claude.json to ~/.claude/.claude.json,
  // so the second volume has nothing left to back:
  //   "type=volume,source=claude-json-${localWorkspaceFolderBasename},target=/usr/local/share/devc/claude-json",

  // RETARGETED onto the Feature's fixed seed path. The host source is unchanged.
  "type=bind,source=${localEnv:HOME}/.config/devc/.claude,target=/usr/local/share/devc-features/agents/claude-seed,consistency=cached,readonly",

  // RETARGETED onto git-container-config's fixed identity path. The host
  // source is unchanged; initialize-command.sh still writes it.
  "type=bind,source=${localEnv:HOME}/.config/devc/gitconfig-identity,target=/usr/local/share/devc-features/git-container-config/identity/gitconfig,consistency=cached,readonly"
]
```

Consequences to state plainly rather than discover:

- **One re-login per workspace**, once. `~/.claude.json` moves from the
  `claude-json-*` volume into the `.claude` volume, and nothing migrates the
  contents across — accepted deliberately (the Feature's own repoint logic
  handles the symlink, not the data). The orphaned `claude-json-*` volumes are
  left on disk for the user to `docker volume prune`.
- **`/usr/local/share/devc/claude-seed`, `/usr/local/share/devc/claude-json`
  and `/usr/local/share/devc/gitconfig-identity` all stop existing** once
  `agents-setup.sh` and `git-setup.sh` are deleted. Nothing else references any
  of the three paths.

### `devc-core/default/` — post-create.sh, scripts/, and onCreateCommand removed

With `agents-setup.sh`, `git-setup.sh` and `bashrc-additions.sh` all gone,
`post-create.sh` has zero `bash "$scripts/…"` lines left and
`devc-core/default/scripts/` is empty. **Remove all three outright** —
`post-create.sh`, `scripts/`, and the `onCreateCommand` key — rather than
leaving an empty orchestrator:

- An empty `scripts/` directory cannot be committed to git at all without a
  placeholder file, so "leave it empty" is not actually a no-edit option.
- Removing cleanly avoids a Dockerfile `COPY scripts/` of nothing, an
  `installBundledAssets` readdir over an absent directory (which would throw,
  not silently no-op), and an `onCreateCommand` that runs a script that does
  nothing.
- `initializeCommand` is unaffected and stays — it runs on the **host**,
  before the container exists, and nothing in this plan touches what it does
  (seed a `.claude` mount source, write `gitconfig-identity`).

If a future baseline addition needs a devc-owned create-time step again,
reintroducing `onCreateCommand`/`post-create.sh` is one file and one
`devcontainer.json` line — cheap to redo, not worth keeping inert in the
meantime.

### `features/devc-config/post-create.sh` — the second fence, and its order

```bash
#!/bin/bash
# … existing header, updated to mention two fenced blocks …
set -e

# devc:devc-config (start)
# … unchanged project-hook block …
# devc:devc-config (end)

# devc:bashrc-additions (start)
BASHRC="$HOME/.bashrc"
# … bashrc-additions.sh's body …
# devc:bashrc-additions (end)
```

**"Move the content" is not "paste the file."** Four specific things must
change on the way in, each of which is a real defect if pasted verbatim:

1. **Drop the `#!/bin/bash` shebang.** It is a file header, not a statement;
   inlined it is a comment, and pasting it invites someone to treat the fence
   as a standalone file later.
2. **The `exit 0` has to become an `if`.** `bashrc-additions.sh` short-circuits
   with `grep -qF "$MARKER" "$BASHRC" 2>/dev/null && exit 0`. Inside a fence
   that is no longer a script's own exit — it ends **`devc-config`'s whole
   `post-create.sh`**. Today it happens to be harmless because this fence is
   last, which is exactly what makes it a landmine: the next fence added to
   this file is silently dead. `agents`' `devc:seed-link` fence contains no
   `exit` at all for this reason — it guards with `if` and `continue`. Do the
   same: wrap the append in `if ! grep -qF "$MARKER" "$BASHRC" 2>/dev/null;
   then … fi`.
3. **`BASHRC="$HOME/.bashrc"` must be a bare assignment at the start of a
   line, inside the fence.** This is the fence's one parameter, and the
   harnesses re-point parameters with `sed -e "s#^BASHRC=.*#…#"` — the same
   mechanism `seed_link_test.sh` uses on `SEED=`/`CLAUDE_DIR=`. Indent it,
   inline it into the `grep`, or fold it into a larger expression, and the
   harness silently rewrites nothing and tests the real `~/.bashrc` of
   whoever ran it.
4. **`set -e` stays out of the new fence.** The file already sets it once at
   the top, and the existing `devc:devc-config` fence carries its own copy
   only because that fence predates having a second one. Do not add a third.

**Two marker conventions live in this one file and must not be harmonized.**
`# devc:bashrc-additions (start)` / `(end)` is the _fence_, read by the test
harness. `# >>> devc bashrc-additions >>>` / `# <<< devc bashrc-additions <<<`
is the _idempotency marker_, written into the user's `~/.bashrc` and grepped
for on the next create — and it lives inside a quoted heredoc, so it is data,
not code. They look alike, they are one word apart, and they do opposite jobs:
"tidying" them into one style breaks either the harness or every existing
container's `~/.bashrc` guard. Changing the `.bashrc` marker text in
particular is a silent double-append for anyone whose `~/.bashrc` carries the
old one.

### `devc/tests/bashrc_additions_test.sh` — and one case fence extraction cannot cover

Follow `devc_config_test.sh`'s shape (extract the fence, run it against a temp
`$HOME`), with one addition drawn from the precedent above: fence extraction
tests a fragment in its own process, so it **cannot** catch the `exit 0`
class of bug or verify that the two fences run in the intended order in one
process. Add at least one case that runs the **whole installed
`post-create.sh`** — the way `git-container-config/test/git_config_test.sh`
runs the real installed hook — against a temp `$HOME` with a project hook
present, asserting both that the hook ran and that `~/.bashrc` got its block.
That single case is the only thing that actually tests the ordering decision
this plan is making.

**Project hook first, bashrc-additions last** — restoring the pre-`devc-config`
historical order (`agents-setup → git-setup → project-hook → bashrc-additions`,
where `bashrc-additions` ran last of all four). That order was lost when
`devc-config`'s own predecessor plan moved `bashrc-additions` ahead of the
project hook as a side effect of the `onCreateCommand` split, and that plan's
own Contracts section named the fix as a fallback ("splitting `post-create.sh`
into two orchestrators… restores the exact order") without implementing it.
Co-locating both blocks in one file, sequenced this way, _is_ that fallback,
reached by a different route.

Both fences stay independently offline-testable, matching how
`agents-setup.sh` already nests a `devc:seed-link` fence inside otherwise
unfenced code — precedent for more than one named fence per file.

### `features/devc-config/devcontainer-feature.json`

```jsonc
{
  "id": "devc-config",
  "version": "0.2.0",
  // … unchanged …
  "installsAfter": [
    "ghcr.io/devc-tools/features/agents",
    "ghcr.io/devc-tools/features/git-container-config"
  ],
  "postCreateCommand": "bash /usr/local/share/devc-features/devc-config/post-create.sh"
}
```

`installsAfter` only has an effect when the named Features are actually being
installed alongside it — a no-op for a consumer who declares `devc-config`
without also declaring `agents`/`git-container-config`. That is correct here:
those two are devc's own choice of how _it_ provisions Claude/git, not
something `devc-config` requires to function on its own.

Bumping the version is a real content change (new `installsAfter`, a second
fenced block) to a Feature already live on ghcr.io. `overlay.ts`'s
`DEVC_CONFIG_FEATURE` moves to `0.2.0` in the same commit;
`workflow_guards_test.sh`'s existing pin guard fails until both agree, same
as it already does for any version drift.

## The Dockerfile stays — but nothing may depend on it

`devc-core/default/Dockerfile` **survives this plan**, holding its base image and
the `ripgrep` install. That is a deliberate decision, not an oversight: removing
it is a manual step the author will take later, by hand, once the swap is proven
working in a real container. **Do not delete it, and do not write a plan or a
follow-up that does.**

What this plan must still guarantee is that the Dockerfile is only ever holding
a **preference**, never a dependency — so that removing it later is a decision
about base images and nothing else. Concretely:

- **Every Feature this plan introduces must stand alone against a plain base
  image.** `agents` and `git-container-config` already do — both install what
  they need in their own `install.sh` and assume no build-time cooperation.
  Do not "simplify" either by moving anything back into a `RUN` step, and do
  not add a Dockerfile line to make a Feature work. If a Feature needs
  something at build time, that belongs in its own `install.sh`.
- **`ripgrep` stays where it is, and must not be turned into a Feature.**
  The Dockerfile's comment about it is misleading and should be read with care:
  it explains why Claude Code can use `rg` _without_ one being installed (the
  Bash tool injects a shell function routing to the copy bundled inside the
  `claude` binary). It is not a statement that Claude needs the package. The
  real reason it is there is that an unrelated tool the author uses wants it —
  a **base-image preference**, not a devc dependency. Nothing in devc, and
  nothing in any Feature here, depends on `rg` being present.

  So it does not want an `installRipgrep` option on `agents`, and it does not
  want a Feature of its own. Leave the `RUN` alone. When the Dockerfile does
  eventually go, `rg` goes with it, and a user who wants extra packages in
  their base supplies their own `Dockerfile` (plus the `devcontainer.json`
  `"build"` stanza naming it) through the existing `~/.config/devc/templates/`
  sparse overlay — the same mechanism that already overrides every other
  bundled file. No new opt-out is needed, and "which tools are in my base
  image" is the user's call rather than something devc has an opinion about.
- **When the manual removal happens, it is not just deleting a file** — noted
  here so it is not a surprise later. `devcontainer.json` switches from
  `"build": { "dockerfile": … }` to a plain `"image"`, and
  `default_config.ts`'s `installBundledAssets` names `${destDir}/Dockerfile` in
  its returned path array with `default_config_test.ts` asserting the bundled
  tree contains it (`assertBundledExcept`, `withRewrites`, and the two
  file-list tests). None of that is this plan's work. All of it is cheaper if
  this plan **adds no new references to the Dockerfile**, which it must not.

## Precedent from `agents` `0.2.0` — what carries, what does not

`agents` has had the most refinement of the three Features involved, so it is
worth stating explicitly which of its lessons transfer to the other two and
which are specific to it. Getting this wrong in either direction — copying a
pattern that does not apply, or ignoring one that does — is the likeliest way
this plan produces something inconsistent with the collection.

**Carried: a path option whose value only ever has one sensible setting should
be a fixed path the consumer mounts onto.** This is what `0.2.0` did to
`seedDir`/`claudeJsonDir`, following `bash-config`'s `dirs/user`.
`git-container-config`'s `identityIncludePath` was the same shape and the same
smell, and
[feature-git-container-config-fixed-identity](archived/feature-git-container-config-fixed-identity.md)
already applied it — landed before this plan, as required, so this plan's own
Contracts declare a bare `{}` and retarget the identity mount rather than pass
the now-removed option. A directory, not a bare `touch`ed file, per that
plan's own Contracts (consistency with `claude-seed` and `dirs/user`). The
file bind already worked either way, since Docker's file-bind restriction
applies to _volumes_, not binds, and devc binds that file today.

One cost that plan accepted, worth restating here since it changes this
plan's own baseline behavior: `identityIncludePath` set to a file that was not
there used to produce a warning, because naming a path was an opt-in that
could visibly fail. A fixed always-present mount point cannot distinguish
"consumer mounted nothing" from "consumer mounted an empty identity", so that
warning is gone — the same trade `agents` accepted for an empty seed.

**Does not carry: `bake()`.** `agents` deleting its baking machinery was a
consequence of having no options left, not a verdict on the technique. A
Feature's options reach `install.sh` as environment variables at **build**
time only; the manifest's `postCreateCommand` takes no arguments and no
substitutions, so a Feature with real create-time options has no other way to
get them across. `git-container-config` has four and keeps them. Do not treat
`agents`' deletion as a reason to strip baking from anything else.

**Already carried, do not re-derive:** the `warn()` helper and the "must exit
0 on every skip path" rule. `git-container-config/post-create.sh` states and
follows both.

**Carries, and is a gap here: the offline harness runs the _real installed
artifact_.** `git-container-config/test/git_config_test.sh` (42 checks) runs
the real `install.sh` into a temp `SHARE_DIR` and executes the hook it
installed, so it cannot drift from what a container gets. That is a stronger
shape than fence extraction, which tests a fragment. It matters for the new
harness this plan adds — see the fence Contracts below.

## Concept boundaries

- **`installsAfter` orders Features devc names, not "everything."** It cannot
  express "run after whatever this consumer happens to declare" — a project's
  own `rust`/`go`/whatever Features are invisible to it. `devc-config`'s hook
  is guaranteed to run after devc's _own_ baseline Features when devc is the
  one assembling the config; it is not guaranteed to run after a project's
  unrelated ones. State this in `devc-config/README.md` rather than let
  someone assume the stronger guarantee.
- **Static declaration (`agents`, `git-container-config` — this plan) vs.
  dynamic injection (`devc-config`, unaffected by this plan).** Two different
  delivery mechanisms living side by side in devc's own bundled config, for
  the reason `devc-inject-project-hook`'s own Superseded section already
  drew: `agents`/`git-container-config` are useful to any devcontainer
  project and need real host mounts + options a Feature cannot self-declare,
  so they get the `bash-config`/`node-nvmrc` treatment (declared once,
  standalone-capable via `devc init`). `devc-config` alone needs to reach
  configs devc does not own, needs no mounts, and is forced with no opt-in —
  the only Feature that gets `baselineFeatures`/exact-pin/dynamic-injection
  treatment stays `devc-config`.
- **Phase-level ordering (`onCreateCommand` before `postCreateCommand`) vs.
  Feature-to-Feature ordering (`installsAfter`) are different levers for
  different problems.** The first plan reached for the phase lever because
  devc's baseline was, at the time, a base-config command competing against a
  Feature's command. This plan reaches for `installsAfter` because all three
  steps are now Features competing against each other in the _same_ phase.
  Conflating the two — assuming `onCreateCommand` still has a role once
  everything is a Feature — is the mistake to name explicitly if it comes up
  in review.
- **`bashrc-additions` moving into `devc-config` is a reach extension.**
  Before this plan, the prompt/title/attach-clear block only ran for configs
  devc materializes or writes (zero-config, `devc init` output). After, it
  reaches a genuinely project-owned `.devcontainer/devcontainer.json` for the
  first time via `devc-config`'s existing dynamic injection — deliberate, and
  the reason `devc-config` (not a new, third Feature) is where this content
  goes: the earlier rename to that name specifically anticipated it becoming
  "the general vehicle for devc-specific contributions," and this is the
  first second use of that vehicle.

## Checklist

- [x] `devc-core/default/devcontainer.json` — `agents`/`git-container-config`
      entries; `onCreateCommand` removed; `claude-json-*` volume deleted and
      the `claude-seed` bind retargeted onto the Feature's fixed path
- [x] `devc-core/default/Dockerfile` — `post-create.sh`/`scripts/` COPY+chmod
      removed; Claude/Copilot `RUN` steps removed
- [x] `devc-core/default/post-create.sh` — deleted
- [x] `devc-core/default/scripts/` — deleted (all three files)
- [x] `devc-core/default_config.ts` — `installBundledAssets`' executable list,
      `scripts/*.sh` loop **and returned path array** trimmed; the
      `onCreateCommand` `replaceAll` rewrite removed; `CLAUDE_SEED_TARGET`
      deleted and `CLAUDE_SEED_HOST_DIR`'s doc comment repointed at the
      `agents` Feature
- [x] `devc-core/default/initialize-command.sh` — the two stale
      `scripts/*.sh` comment references fixed
- [x] `features/devc-config/post-create.sh` — `devc:bashrc-additions` fence
      added, project-hook fence first; shebang dropped, `exit 0` converted to
      an `if`, `BASHRC=` bare at line-start, no second `set -e` (see Contracts
      — pasting the file verbatim is a defect, not a shortcut)
- [x] `features/devc-config/devcontainer-feature.json` — `installsAfter`;
      `version` → `0.2.0`
- [x] `features/devc-config/install.sh` — header comment updated
- [x] `features/devc-config/README.md` — the new fence, the ordering
      guarantee and its limit, the reach extension
- [x] `devc-core/overlay.ts` — `DEVC_CONFIG_FEATURE` → `0.2.0`
- [x] `devc-core/tests/default_config_test.ts` — all six sites in Existing
      touchpoints, `withRewrites` and the retargeted subdirectory-overlay test
      included
- [x] `devc-core/tests/init_test.ts` — all three tests in Existing touchpoints
      (`written` array, the `scripts/` readDir, the `node-setup.sh` assertion)
- [x] `devc/tests/bashrc_additions_test.sh` — new, offline; includes the
      whole-file case that fence extraction cannot cover (fence ordering, and
      the `exit 0` class of bug)
- [x] `devc/README.md` — Claude config / Git setup prose repointed at the
      Features; the three remaining `/usr/local/share/devc/claude-seed`
      statements retargeted; the `~/.claude.json` fold and the one-re-login
      cost documented; fence-harness list updated (drop two stale devc-copy
      lines, add the new harness)
- [x] `docs/manual-verification.md` — new Docker scenarios (see Validation)
- [x] `.plans/PLAN.md` — register, and move this plan to `archived/` on
      completion

## Validation

> **The `devc-core` suite is RED before this plan starts** — 3 failures, all
> `scripts/node-setup.sh` not found (`default_config_test.ts:276`, `:451`,
> `init_test.ts:210`). That file was deleted when the `node-nvmrc` Feature took
> its job; its test assertions were never removed. **Not caused by this plan**
> — verify with `git stash` before assuming otherwise. It is listed here rather
> than left to be rediscovered because all three assertions sit inside the very
> lists this plan edits, so the plan fixes them for free: the correct end state
> is `devc-core` **green**, not "red the same way it started". `devc`,
> `tests/features_test.sh` and `tests/workflow_guards_test.sh` are all green
> today and must stay that way.

- [x] `cd devc-core && deno task check && deno task test` — green, with the
      updated `materializeDefaultConfig`/`init` assertions. This suite goes
      **red → green**; see the note above.
- [x] `cd devc && deno task check && deno task test` — green.
- [x] `bash devc/tests/seed_link_test.sh ../features/agents/post-create.sh`
      — still green, now the only copy.
- [x] `bash devc/tests/devc_config_test.sh features/devc-config/post-create.sh`
      — still green (the project-hook fence is unmoved, unmodified).
- [x] `bash devc/tests/bashrc_additions_test.sh features/devc-config/post-create.sh`
      — new, green.
- [x] `bash tests/workflow_guards_test.sh` — the existing pin guard fails if
      `overlay.ts` and the manifest disagree on `0.2.0`.
- [x] `bash tests/features_test.sh` — green.
- [x] `deno fmt --check` clean.
- [ ] (needs Docker) **`agents` derives `~/.claude` as `/home/vscode/.claude`**
      for this base image/remote user — the path devc's `claude-code-config-*`
      volume already mounts at. `0.2.0` derives this from `$HOME` at create
      time rather than baking it, so a mismatch is now visible in the
      container rather than silent, but it is still unmeasured here.
- [ ] (needs Docker) **Zero-config end-to-end**: `devc up` on a project with
      no config of its own. `~/.claude` seeded and owned correctly,
      `~/.claude.json` symlinked, git identity/LFS/`safe.directory` all set —
      same observable outcome as before this plan, now delivered by two
      Features instead of two scripts.
- [ ] (needs Docker) **The `installsAfter` ordering claim, for real** — not
      just read from source. A hook (via `devc-config`, reached through the
      project's own `devc-post-create.sh`) that checks `git config --get
      user.email` and whether `~/.claude` is populated sees both already set
      up. This is the direct successor to the equivalent check
      `devc-inject-project-hook` ran for the `onCreateCommand` version of
      this guarantee — same property, different mechanism.
- [ ] (needs Docker) **`devc init` output still works standalone.** Scaffold a
      project, bring it up with a plain `devcontainer up` (no `devc` on
      `PATH`) — `agents`/`git-container-config` still provision correctly,
      since they are declared in the scaffolded config itself, not injected.
- [ ] (needs Docker) **The bashrc-additions reach extension.** A genuinely
      project-owned `.devcontainer/devcontainer.json` (devc never wrote it),
      no `devc.json` overlay. `devc up` → the container's interactive shell
      carries the custom `PS1` and title behavior, confirming it now reaches
      project mode as intended.
- [ ] (needs Docker) **Rebuild churn**, same shape as the previous plan's
      open question: confirm this is a one-time image-layer change per
      project, not a recurring cost.

## Open questions to measure, not assume

1. **Does `$HOME` really resolve to `/home/vscode` for
   `mcr.microsoft.com/devcontainers/base:noble` + the `vscode` remote user at
   `postCreateCommand` time?** Assumed equal to devc's own mount target; not
   yet run against a real build. If wrong, the volume mounts somewhere the
   Feature isn't looking, silently losing `~/.claude` persistence — and now
   `~/.claude.json` with it, since `0.2.0` folds that in.
2. **Does `installsAfter` govern lifecycle-command order, or only
   image-build order?** Cited in the Why section as settled devcontainer CLI
   behavior — worth reconfirming against the pinned `@devcontainers/cli`
   version directly (source or a real container), the way the original
   Features-before-config claim was measured, before leaning on it for
   correctness rather than just image-layer tidiness.
3. **Does the `agents` Feature's Copilot install, run at Feature-install
   time, land in the same place devc's Dockerfile `RUN` step did** (so an
   existing image's `~/.local/bin/copilot` is not orphaned by the rename in
   provisioning mechanism)? Likely yes (same install script, same target),
   but not yet confirmed against a real rebuild.

## Not in this plan

- **Any change to what `agents`/`git-container-config` themselves do.** Both
  are consumed as published — `agents` at `0.2.0` (which dropped its three
  path options and folded `~/.claude.json` into `~/.claude`, landed separately
  before this plan runs), `git-container-config` at `0.2.0` (which dropped
  `identityIncludePath` for a fixed mount point, landed separately before this
  plan runs too — see below). If either needs a further behavior change, that
  is a separate plan versioning that Feature on its own.

- **Migrating the contents of the `claude-json-*` volumes.** Deliberately not
  done: one re-login per workspace is the accepted cost, and the orphaned
  volumes are left for the user to prune.
- **Reaching project mode with `agents`/`git-container-config` themselves.**
  Only `devc-config` is dynamically injected. A project-mode repo still gets
  neither Claude config nor git identity restoration from devc unless it
  declares those Features itself — unchanged from today.
- **A general "run after every Feature this consumer happens to declare"
  mechanism.** Named and rejected in Concept boundaries;
  `installsAfter`'s enumerated-list design cannot do this, and no
  alternative is designed here.
- **Deleting `devc-core/default/`'s `Dockerfile` or `initialize-command.sh`
  entirely.** The Dockerfile keeps its base image and `ripgrep` and is
  explicitly **left in place** — the author removes it by hand later, once this
  swap is proven working in a real container. Do not schedule that removal as
  follow-up work; see
  [The Dockerfile stays](#the-dockerfile-stays--but-nothing-may-depend-on-it).
  `initialize-command.sh` keeps a real job independent of all of this
  (host-side identity extraction and mount-source seeding) — unaffected by
  `git-container-config`'s `identityIncludePath` removal, which only moved
  where the container-side bind targets, not what the host side writes.

- **Anything about `ripgrep`.** Not a devc dependency and not a Feature's job —
  a base-image preference. Its `RUN` step stays exactly where it is. See
  [The Dockerfile stays](#the-dockerfile-stays--but-nothing-may-depend-on-it).

- **Dropping `git-container-config`'s `identityIncludePath` for a fixed mount
  point.** Done separately in
  [feature-git-container-config-fixed-identity](archived/feature-git-container-config-fixed-identity.md),
  which landed **before** this plan, as required — while devc still consumed
  neither Feature and the breaking change was free. That plan's own commit
  carried the two amendments to this one (the `features` entry and the
  identity mount), both reflected above.
