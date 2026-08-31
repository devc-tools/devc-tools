# `claude-config` Feature — agent CLIs and their per-workspace config

> **Renamed twice after this plan landed.** The Feature this plan produced was
> published as `claude-config`, then renamed to `agents-config`, then
> shortened to plain **`agents`** — it already installs a second vendor's CLI
> (Copilot), so the plural, vendor-neutral id was the better fit; see
> `features/agents/README.md` ("Relationship to devc") and the completion note
> in `.plans/PLAN.md`. Every `claude-config` below is this plan as originally
> written and as it named things at the time.

## Goal

Publish `ghcr.io/devc-tools/claude-config`: install the Claude Code CLI
(and optionally the GitHub Copilot CLI) at build time, and at create time wire
`~/.claude` and `~/.claude.json` to whatever persistence and seed the consumer
has mounted.

**This is the largest split of the four**, and the one with a real open question
rather than a settled boundary:

- **Feature material**: the CLI installs (today plain `RUN` lines in devc's
  `Dockerfile`), the `~/.claude.json` → volume-file symlink, and the seed-link
  walk _as a mechanism_.
- **The consumer's, unavoidably**: the `~/.claude` **seed** — a **read-only**
  bind of a host directory that must already exist. No Feature can declare either
  half, so it goes in the consumer's `devcontainer.json`. devc happens to be a
  consumer that writes it (`ensureClaudeSeedDir` guarantees
  `~/.config/devc/.claude` host-side); a non-devc project pastes two lines from
  the README. **Not devc-only** — see Standalone below.
- **Undecided until measured**: whether the two **volumes** move into the
  Feature. See "The volume question".

**Copy, don't move.** `scripts/agents-setup.sh`, the Dockerfile installs, and all
three mounts keep working.

## Existing touchpoints

- `devc/default/scripts/agents-setup.sh` — source material. The `devc:seed-link`
  fenced block (lines 13–59) is copied **verbatim**; the `sudo chown` and the
  `~/.claude.json` symlink around it are generalized.
- `devc/default/Dockerfile` lines 28–41 — the two idempotent CLI installs, run as
  the non-root user into `~/.local/bin` so the `~/.claude` volume does not shadow
  them and `claude`/`copilot update` can write.
- `devc/default/devcontainer.json` — the two volumes (`claude-code-config-*`,
  `claude-json-*`), the read-only `claude-seed` bind, and the
  `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` `remoteEnv`. Cited, not edited.
- `devc/tests/seed_link_test.sh` — takes a script path as `$1`, extracts the
  `devc:seed-link` block, and drives it via `SEED` / `CLAUDE_DIR`. **Reused
  against the Feature's copy**, which pins the contract below.
- `devc/default_config.ts` `ensureClaudeSeedDir` — why the host seed dir always
  exists. Cited.

## Contracts

### `features/claude-config/devcontainer-feature.json`

```jsonc
{
  "id": "claude-config",
  // Its own version, independent of the repo tag and of the other Features —
  // see .plans/archived/feature-independent-versions.md.
  "version": "0.1.0",
  "name": "Claude Code config",
  "options": {
    "installClaudeCli": { "type": "boolean", "default": true },
    "installCopilotCli": { "type": "boolean", "default": false },
    "claudeDir": { "type": "string", "default": "" },
    "seedDir": { "type": "string", "default": "" },
    "claudeJsonDir": { "type": "string", "default": "" }
  },
  "postCreateCommand": "bash /usr/local/share/devc-features/claude-config/post-create.sh"
}
```

- `claudeDir` empty → `$_REMOTE_USER_HOME/.claude`. An option only because an
  image with a different home layout exists.
- `seedDir` empty → **no seed linking at all** (the whole step is skipped). This
  is the devc seam: devc will pass `/usr/local/share/devc/claude-seed`.
- `claudeJsonDir` empty → `~/.claude.json` is left alone entirely. Non-empty →
  the symlink dance below. Never invent a location: a consumer with no volume
  wants the plain file Claude Code creates itself.
- `installCopilotCli` defaults **false**. devc installs it today and will pass
  `true` at swap time; a Feature named `claude-config` should not silently
  install a second vendor's CLI for everyone else.

### `install.sh` (root, build time)

1. Place `post-create.sh` under `/usr/local/share/devc-features/claude-config/`,
   `0755` root-owned, with the option values baked in.
2. **CLI installs, as `$_REMOTE_USER`, not root** — copy the guard from the
   Dockerfile verbatim (`[ ! -x "$HOME/.local/bin/claude" ] && ! command -v
   claude`), running under `su - "$_REMOTE_USER" -c` (or `runuser`) so `$HOME`
   resolves to `_REMOTE_USER_HOME`. Installing as root would put the binary
   somewhere the user cannot update — the exact reason devc's Dockerfile switches
   `USER` first.
3. **Pre-create `claudeDir` owned by `$_REMOTE_USER`.** See the volume question.
4. Network is required when either install option is true; a failed download
   fails the build, matching `devc-bridge/install.sh`'s stance (better than a
   container that looks fine until the first `claude`).

### `/usr/local/share/devc-features/claude-config/post-create.sh`

Runs as the remote user, before any user `postCreateCommand`:

1. **Ownership repair** — if `claudeDir` exists and is not owned by the current
   user, `sudo chown` it **non-recursively** (`command -v sudo` guarded,
   best-effort). Non-recursive is a hard requirement copied from
   `agents-setup.sh`: subpaths like `skills/` are bind mounts and must not be
   chowned. Expected to be a no-op if step 3 of `install.sh` works — kept because
   it is cheap and the volume-seeding behavior is unverified.
2. **Seed links** — when `seedDir` is non-empty and exists, the `devc:seed-link`
   block **copied verbatim** from `agents-setup.sh`, parameterized by `SEED` and
   `CLAUDE_DIR` exactly as it is there. Hard requirements, because
   `devc/tests/seed_link_test.sh` is the test:
   - the fence markers stay `# devc:seed-link (start)` / `(end)`;
   - the block stays self-contained — parameterized **only** by `SEED` and
     `CLAUDE_DIR`, no `sudo`, no paths outside them;
   - stale-link cleanup (symlinks pointing into `$SEED` are removed first), the
     dangling-host-symlink skip, the non-regular-file skips, and the
     top-level-files-only rule all survive unchanged.
3. **`~/.claude.json`** — when `claudeJsonDir` is non-empty: chown the directory
   (best-effort), seed `"$claudeJsonDir/claude.json"` with `{}` if absent, and
   replace `$HOME/.claude.json` with a symlink to it unless it already is one.
   A volume can only mount at a directory, which is the whole reason for the
   indirection — keep that comment.

Exit 0 on every skip path.

### Standalone — what a non-devc project pastes

`"claude-config": {}` installs the Claude CLI and does nothing else — useful on
its own, and the bare-`{}` case the scenario must prove. Each further capability
is one paste, and none of them mentions devc:

```jsonc
// persistence: per-workspace auth + config that survives a rebuild
"mounts": [
  "type=volume,source=claude-config-${localWorkspaceFolderBasename},target=/home/vscode/.claude",
  "type=volume,source=claude-json-${localWorkspaceFolderBasename},target=/usr/local/share/claude-json",
  // seed: your own host config, read-only and live
  "type=bind,source=${localEnv:HOME}/.config/claude-seed,target=/usr/local/share/claude-seed,readonly"
],
"initializeCommand": "mkdir -p ${localEnv:HOME}/.config/claude-seed",
"features": {
  "ghcr.io/devc-tools/claude-config:0": {
    "seedDir": "/usr/local/share/claude-seed",
    "claudeJsonDir": "/usr/local/share/claude-json"
  }
}
```

`${localWorkspaceFolderBasename}` in a **consumer's** `mounts` is ordinary,
documented substitution — the open question below is only about whether it works
inside a **Feature's** `mounts`. So per-workspace isolation is available to
every consumer today, whichever way that measurement lands. Say that plainly in
the README; it is the difference between "the Feature can't do this" and "you
write one more line".

### The volume question — measure before deciding

devc's two volumes are named per workspace:
`claude-code-config-${localWorkspaceFolderBasename}` and
`claude-json-${localWorkspaceFolderBasename}`. A Feature _can_ declare
`type=volume` mounts (no `readonly` needed, so the object form is fine), which
would make the Feature self-sufficient for a non-devc consumer.

It turns on one unmeasured fact: **does
`${localWorkspaceFolderBasename}` substitute inside Feature `mounts`?**
`${localEnv:HOME}` provably does (`.plans/archived/devc-bridge-feature.md`
findings); this is a different variable class.

- **If it substitutes** — declare both volumes in the Feature, per-workspace
  isolation intact, and devc drops its two volume mounts at swap time.
- **If it does not** — declaring them yields **one shared volume across every
  project**, which is worse than not declaring them: two repos would share Claude
  auth and history with no way to tell. In that case the Feature declares **no**
  mounts, the consumer declares the volumes, and the README carries the exact two
  lines to copy.

Do not guess. Measure it with a throwaway Feature and `docker inspect`, the way
the mount questions in `devc-bridge-feature` were settled, and record the answer
in `.plans/design/devc-feature-split.md` (open question 2).

Second thing to measure, same session (open question 3): whether a first-use
empty named volume mounted over a build-time-created, user-owned `claudeDir`
inherits that ownership. If yes, step 1 of the hook is belt-and-braces and
`sudo` stops being a prerequisite for this Feature.

## Concept boundaries

- **`claude-config` (Feature) vs `scripts/agents-setup.sh` (devc's copy)** — both
  live during the interim, and the second is named for _agents_ plural while the
  Feature is named for Claude. The Feature README opens by naming both.
- **`~/.claude` (the dir) vs `~/.claude.json` (the file) vs
  `~/.config/devc/.claude` (the host seed) vs `claude-seed` (its container
  mount point).** Four Claude paths, three different lifetimes. Reproduce
  `agents-setup.sh`'s comments rather than paraphrasing.
- **Seed ≠ sync.** Files are **symlinked** from a read-only mount so host edits
  are live and modes (the statusline exec bit) survive. Directories are ignored
  by design — the `devc:skills` fence mounts per-skill binds under
  `~/.claude/skills/`, and linking over a live mountpoint fails.
- **This Feature is not `anthropic.claude-code`** (the VS Code extension devc
  lists under `customizations`). It could declare that extension via
  `customizations.vscode.extensions` — **do not**, without deciding it
  separately; a config Feature that installs editor extensions is a surprise.

## Checklist

- [x] Measure both open questions; record answers in
      `.plans/design/devc-feature-split.md` — unmeasured (no Docker); noted
      there, safe no-mounts path taken
- [x] `features/claude-config/devcontainer-feature.json` — id/version/name, five
      options, `postCreateCommand`, and volumes **only if** measurement says so
      — no volumes declared, per the unmeasured-safe-default decision
- [x] `features/claude-config/install.sh` — hook placement, option baking,
      CLI installs as `$_REMOTE_USER`, `claudeDir` pre-created and owned
- [x] `features/claude-config/post-create.sh` — ownership repair, verbatim
      `devc:seed-link` block, `~/.claude.json` symlink
- [x] `features/claude-config/README.md` — the four Claude paths, what a consumer
      must mount themselves (with the exact read-only seed mount + an
      `initializeCommand` `mkdir` recipe), `installCopilotCli` default, and the
      volume decision either way
- [x] `features/claude-config/test/test.sh` — scenario
- [x] `features/claude-config/test/run-features-test.sh` — wrapper
- [x] `features/README.md` — row
- [x] `devc/README.md` — Development section lists the new harness invocation
- [x] `.plans/PLAN.md` — register

## Validation

- [x] `bash devc/tests/seed_link_test.sh features/claude-config/post-create.sh`
      passes **unmodified** — the existing harness against the Feature's copy. If
      it needs edits, the copy drifted. (Path note: the plan cites
      `devc/tests/seed_link_test.sh`, which is correct as-is — that harness
      itself never moved. Its target script did: the plan cites
      `devc/default/scripts/agents-setup.sh`, which is now
      `devc-core/default/scripts/agents-setup.sh` — see the next item.)
- [x] `bash devc/tests/seed_link_test.sh devc-core/default/scripts/agents-setup.sh`
      still passes (devc's copy untouched; real current path — the plan's cited
      `devc/default/scripts/agents-setup.sh` was renamed to `devc-core/default/`
      before this plan was implemented, same rename `feature-git-config` already
      recorded)
- [ ] (needs Docker) `bash features/claude-config/test/run-features-test.sh` —
      `claude` on `PATH` and executable by the remote user; `~/.claude` owned by
      the remote user; with `seedDir` unset nothing is linked and create still
      succeeds; with a populated `seedDir`, top-level files are symlinks into it
      and a subdirectory is **not** linked; with `claudeJsonDir` set,
      `~/.claude.json` is a symlink and reads back `{}`
- [ ] (needs Docker) **the bare `{}` scenario** — no options, no mounts: `claude`
      is on `PATH`, `~/.claude.json` is left alone, nothing is linked, create
      succeeds
- [ ] (needs Docker) `installCopilotCli: true` puts `copilot` on `PATH`; the
      default leaves it absent
- [ ] (needs Docker, if volumes are declared) two containers from different
      workspace folders get **different** volumes — the failure mode that decides
      the volume question. Moot for this implementation: no volumes are
      declared (the safe unmeasured-default path), so there is nothing here to
      run yet — this stays open for whoever measures open question 2 and adds
      the volumes.
- [x] `deno fmt --check` clean

## Not in this plan

- Any edit to `devc/default/` — `agents-setup.sh`, the Dockerfile installs, and
  all three mounts stay.
- The `devc:skills` per-skill bind mounts, which `devc config` writes into
  `devc.json` as overlay mounts. They are wizard output, not baseline config, and
  nothing about them is Feature-shaped.
- `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`. It exists to protect the terminal title
  set by devc's `bashrc-additions.sh`; as Feature `containerEnv` it would suppress
  a title for consumers who have nothing setting one. It stays devc's `remoteEnv`.
