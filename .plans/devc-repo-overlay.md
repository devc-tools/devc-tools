# devc-repo-overlay

A third overlay level, between the user overlay and the project overlay: one
`devc.jsonc` per **git repository**, stored under `~/.config/devc/repos/`, and
applied to the primary checkout and every linked worktree of that repository.
Configure a repo once and every worktree you create later picks it up, with
nothing written into any checkout.

## Decisions

1. **Identity is the canonical common git dir.** For a folder, walk up with
   `findRepoRoot` (`devc-core/overlay.ts`) to the checkout root, then:
   - `<root>/.git` is a directory → the git dir is `<root>/.git`.
   - `<root>/.git` is a file → the git dir is the value of its first line
     matching `/^gitdir:\s*(.+?)\s*$/m` (the regex `resolveWorktree` already
     uses), resolved against `<root>` when relative.
   - Read `<gitdir>/commondir`. If present, the common dir is its trimmed
     content, resolved against `<gitdir>` when relative (git writes `../..`). If
     absent (ENOENT), the common dir is the git dir.
   - Canonicalize with `realpath` from `node:fs/promises`.

   So `~/code/app`, `~/code/app.worktrees/feat` and `/elsewhere/feat-b` all
   resolve to `~/code/app/.git`. A submodule's git dir (`.git/modules/<name>`)
   has no `commondir`, so it is its own repo. A worktree of a bare repo resolves
   to the bare repo's directory. Separate clones are separate repos. Remote URLs
   and branch names play no part.

   **No subprocesses.** Everything is file reads, for the same `core.fsmonitor`
   reason `findRepoRoot` gives. `resolveWorktree` and the mount code are not
   touched: their `/worktrees/` inference is about mountability, which is a
   separate question.

2. **The overlay path is derived from the identity, not looked up.** There's no
   registry. The path is
   `<configDir>/repos/<repoKey>/devc.jsonc`, falling back to `devc.json` (first
   hit wins, matching the user level). `<configDir>` is `CONFIG_DIR`
   (`~/.config/devc`). `repoKey(commonDir)`:
   - name: `basename(dirname(commonDir))` when `basename(commonDir)` is `.git`,
     otherwise `basename(commonDir)` with one trailing `.git` stripped. Replace
     `[^a-zA-Z0-9_.-]` with `-`. If the result is empty, use `repo`.
   - hash: the first 8 hex characters of SHA-256 over
     `commonDir.toLowerCase()`, UTF-8. This is the same scheme as `projectKey`
     in `merged_config.ts`, and it shares that function's case-folding
     tradeoff.
   - key: `<name>-<hash>`, e.g. `app-1a2b3c4d`.

   Consequences, which the docs should state:
   - **Unlink:** delete or rename the directory.
   - **After moving a repo:** the key changes. `devc status` prints the
     expected path, and `mv` the old directory to it.
   - **A missing file means no repo layer.**

3. **Precedence**, lowest first: base config (project's own or bundled default)
   → user overlay → **repo overlay** → project overlay. These are three separate
   layers in `DevcOverlays.layers`; they are never pre-merged. This applies in
   both project and zero-config modes. `baselineFeatures` is
   `user && repo && project`. The repo file is loaded with `loadOverlayFile`, so
   its parse errors, mount checks, unknown-key warnings, and `gitProtect` /
   `bridgeClientMount` validation are identical to the other two levels.

4. **Identity failures never fail a start.** Not being in a git repository
   gives no repo layer, silently. A metadata problem has the same effect: an
   unreadable `.git`, a `.git` file with no `gitdir:` line, an unreadable
   `commondir`, or a `realpath` failure. In that case `ensureMergedConfig`
   warns via `logWarning`, once:
   `devc: no repo overlay for <localFolder> — <reason>`. It warns **only when
   `<configDir>/repos/` exists**, so users who never adopted repo overlays see
   nothing new. A repo overlay that exists but is invalid **does** fail, exactly
   as an invalid user overlay does today (decision 3).

5. **Path semantics are those of the user overlay.** Relative paths are not
   rebased onto `~/.config/devc/repos/<key>/`. `${localWorkspaceFolder}` is the
   active checkout. Cache paths, container names and bridge keys stay keyed on
   the workspace folder (`projectKey`). Two worktrees share config, never a
   container.

6. **CLI:** `devc config --repo [PATH]`.
   - It runs the existing project wizard, including the first-run global step,
     targeting the repo overlay instead of `resolveProjectOverlayTarget`.
   - When PATH is not in a git repo, or decision 4 finds a metadata problem, it
     exits 1 with
     `devc: <abs PATH> is not in a git repository — --repo needs one`, or
     `devc: cannot resolve the git repository for <abs PATH> — <reason>`, and
     writes nothing.
   - `--repo` with `--global` exits 2 with
     `devc config: --global and --repo cannot be combined`.
   - `devc config` arguments get a real parser, `parseConfigArgs` in
     `devc/args.ts`: flags `--global` and `--repo`, at most one positional. Any
     other flag, or a second positional, exits 2 with
     `unexpected argument '<arg>'`, matching `parseAttachArgs`. Today unknown
     flags are silently ignored, and that change is intended.

7. **Wizard in repo scope.**
   - Header lines: `Configuring devc mounts at <displayPath(overlay)>`, then
     `(creating a new repo overlay, shared by every checkout of <displayPath(commonDir)>)`
     or
     `(updating the existing repo overlay, shared by every checkout of <displayPath(commonDir)>)`.
   - A new repo overlay is seeded with:

     ```jsonc
     {
       // Repo devc overlay for <displayPath(commonDir)>, managed by `devc config --repo`.
       // Applies to every checkout and worktree of this repository.
       // Also supports "features" and "remoteEnv" — see devc's README.
       "mounts": []
     }
     ```

     The parent directory is created when writing.
   - The pinned "this project (always mounted)" row, the fences, the review
     screen and `recentSkills` persistence are unchanged.
   - The rebuild step is unchanged and acts on PATH's container only. After it,
     when the apply `changed`, print
     `Other checkouts of this repo pick this up on their next \`devc build\`.`
   - Project scope (`devc config` without `--repo`) behaves exactly as today.

8. **`devc status`** prints one new line after the git-protection section and
   before the bridge lines:
   - `repo overlay: <displayPath(path)>` when the file exists
   - `repo overlay: none — create with \`devc config --repo\` (<displayPath(path)>)`
     when it does not
   - `repo overlay: none (not a git repository)`
   - `repo overlay: none (<reason>)` for a decision-4 metadata problem
   - nothing when `ensureMergedConfig` failed, because git protection already
     reports `unknown — <message>`.

   `devc up --print-config` stdout is unchanged: merged JSON only.

## Gotchas

- **`findRepoRoot` walks up past the workspace.** A subfolder of a repo, or an
  un-`git init`ed folder under a dotfiles repo at `~`, gets that ancestor's repo
  overlay. That is consistent with what the CLI mounts, and with
  `git_root_guard.ts`, which already asks before creating such a container.
  Keep it.
- **A worktree's `gitdir:` may be absolute** (`git worktree add` writes absolute
  paths unless `worktree.useRelativePaths` is set). Identity must accept both.
  Only mountability rejects absolute links, and this plan does not touch
  mountability.
- **`commondir` resolves against the git dir, not the checkout.**
  `<gitdir>/commondir` = `../..` from `.git/worktrees/feat` is `.git`.
- **`realpath` is required for identity.** Without it, `~/code` reached through
  a symlink (or `/var` vs `/private/var` on macOS) hashes to a different key.
- **`applySelection` and `runProjectConfigWizard` each call
  `resolveProjectOverlayTarget` themselves** (`wizard_apply.ts`,
  `config_flow.ts`). Both must take the resolved target, meaning path,
  `creating`, and seed text, from the caller, or repo scope will write the
  project file.
- **`main.ts`'s `config` dispatch currently picks PATH with
  `Deno.args.find(a => !a.startsWith('--'))`.** Replace it with
  `parseConfigArgs`.
- **`loadOverlays` is exported from `@devc-tools/core`.** Its return type gains
  a field, which is additive. Keep the `(localFolder, configDir)` signature.

## Checklist

- [ ] `devc-core/repo.ts` (new): `resolveRepo(localFolder)` returning `{ checkoutRoot, gitDir, commonDir }`, `null` (not a repo), or a typed error carrying the decision-4 reason. Also `repoKey(commonDir)` and `repoOverlayDir(commonDir, configDir)`. Imports only `node:fs/promises`, `crypto.subtle` and `./posix.ts`. Move `findRepoRoot` (and the `statKind` it needs) here and re-export it from `overlay.ts`, so the two modules don't import each other. Export from `mod.ts`; add to `devc-core/deno.json` `check`
- [ ] `devc-core/overlay.ts`: `findRepoOverlayPath`; `loadOverlays` loads three layers (decision 3), and returns the repo resolution for status (`repo: { commonDir, path, exists } | { reason } | null`); the decision-4 warning; update the `DevcOverlays` doc comments that say "two"
- [ ] `devc-core/merged_config.ts`: carry the repo resolution onto `MergedConfig` as `repoOverlay`; update the `ensureMergedConfig` layer-order comment to `devc → git-protect → base → user → repo → project`
- [ ] `devc-core/wizard_apply.ts`: `applySelection` takes an `OverlayTarget` plus seed text instead of resolving one; add the repo seed text (decision 7) beside `NEW_OVERLAY_TEXT`; create parent dirs
- [ ] `devc/args.ts`: `parseConfigArgs` (decision 6)
- [ ] `devc/main.ts`: `config` dispatch through `parseConfigArgs`; `--repo` resolution and the exit-1 messages; `devc status` repo line (decision 8)
- [ ] `devc/tui/config_flow.ts`: `runProjectConfigWizard` takes a scope; repo header lines; the post-rebuild note (decision 7)
- [ ] `devc/help.ts`: `config` usage `Usage: devc config [PATH] [--global | --repo]`, option `--repo    Configure the overlay shared by every checkout of PATH's git repository`
- [ ] Tests (listed under Validation): `devc-core/tests/repo_test.ts` (new), `overlay_test.ts`, `merged_config_test.ts`, `wizard_apply_test.ts`; `devc/tests/args_test.ts`, `config_flow_test.ts`, `help_test.ts`
- [ ] `devc/README.md`: in "Optional overlay: `devc.json`", add the repo row to the "Where it can live" block between user and project, then a "Repo overlay" subsection covering decisions 1, 2 (with unlink and move), 5, and `devc config --repo`; add `--repo` to the Commands block
- [ ] `devc-core/README.md`: any mention of the two overlay levels becomes three
- [ ] `.plans/design/devc-design.md`: the overlay-location paragraph near "Both project overlay locations are first-class" gains the repo level; "Starting the wizard" step 3 names the repo target under `--repo`
- [ ] `deno fmt` on every touched file, including this plan and `.plans/PLAN.md`

## Validation

- [ ] `cd devc-core && deno task check && deno task test` passes, including new tests proving:
  - `repo_test.ts`, with fixtures written as plain files (no git):
    - a `.git` dir checkout gives `commonDir` = `<root>/.git`, from both the root and a subdirectory
    - a `.git` file `gitdir: ../app/.git/worktrees/feat` plus `commondir` `../..` gives `<app>/.git`, and the absolute-path spelling of the same link gives the same `commonDir`
    - two worktrees in unrelated directories give the same `commonDir` and `repoKey`
    - an absolute `commondir` value is honored
    - a symlinked path to the checkout gives the same `repoKey` as the real path
    - a submodule (`gitdir: ../.git/modules/sub`, no `commondir`) gets its own key, not the parent's
    - a bare-backed worktree (`gitdir: /x/app.git/worktrees/w`, `commondir` `../..`) gives `/x/app.git` and key name `app`
    - a non-repo folder gives `null`
    - a `.git` file with no `gitdir:` line, or pointing at a missing dir, gives an error with a reason
    - `repoKey('/home/u/code/app/.git')` is `app-` + the first 8 hex of `sha256('/home/u/code/app/.git')`
  - one `repo_test.ts` case built with real `git init` and `git worktree add` in a temp dir: primary and worktree resolve to the same `commonDir`
  - `grep -nE "child_process|Deno\.Command|spawn|exec" devc-core/repo.ts` prints nothing
  - `overlay_test.ts`, with a temp `configDir`:
    - user `{"mounts":[A]}`, repo `{"mounts":[B]}`, project `{"mounts":[C]}` merge to A, B, C in that order
    - repo `{"remoteEnv":{"X":"r"}}` with project `{"remoteEnv":{"X":"p"}}` gives `p`
    - repo `{"remoteEnv":{"$replace":true,"Y":"r"}}` drops the user's `remoteEnv` keys and keeps the project's
    - repo `"features": null` clears the user's features
    - repo `baselineFeatures: false` makes the effective value `false` while user and project are `true`
    - with no repo file, layers equal today's `[user, project]` output plus an empty middle layer, and the merged result is byte-identical
    - an invalid repo file rejects with an error naming its path
    - a metadata error with `<configDir>/repos/` present logs exactly one warning starting `devc: no repo overlay for`; with it absent, it logs nothing
  - `merged_config_test.ts`:
    - a repo overlay mount reaches the merged config in both project and zero-config modes
    - two worktrees of one repo get different `mergedConfigPath`s and identical repo layers
  - `wizard_apply_test.ts`:
    - applying to a repo target creates `<configDir>/repos/<key>/devc.jsonc` with the decision-7 seed comment lines, and creates nothing under the project folder
    - re-applying preserves a hand-written comment and a `remoteEnv` key in that file
- [ ] `cd devc && deno task check && deno task test` passes, including:
  - `args_test.ts`: `parseConfigArgs` for `[]`, `['p']`, `['--repo']`, `['--repo','p']`, `['p','--repo']`, `['--global']`; `['--global','--repo']` throws the decision-6 message; `['--bogus']` and `['a','b']` throw `unexpected argument`
  - `config_flow_test.ts`:
    - the repo-scope flow writes through the injected `apply` to the repo target and prints both decision-7 header lines
    - with `changed: true` it prints the "Other checkouts" line, and a project-scope run never prints it
    - a cancelled repo-scope run writes nothing
  - `help_test.ts`: `COMMAND_HELP.config` matches decision 6 / the Checklist text exactly
- [ ] `deno fmt --check` is clean at the repo root
- [ ] (user) In a scratch repo with `git worktree add ../scratch.worktrees/a`: run `devc config --repo` in the primary and pick one extra source folder. `git status` in both checkouts is clean, and `ls ~/.config/devc/repos/` shows one `scratch-<hash>` dir. `devc up --print-config | jq .mounts` from the worktree includes the picked folder
- [ ] (user) `devc status` in the worktree prints `repo overlay: ~/.config/devc/repos/scratch-<hash>/devc.jsonc`. In `/tmp` (no repo), it prints `repo overlay: none (not a git repository)`
- [ ] (user) `devc config --repo /tmp` exits 1 with the decision-6 message and creates nothing under `~/.config/devc/repos/`
- [ ] (user) `devc up` in the primary and in the worktree yields two containers (`docker ps --filter label=devcontainer.local_folder`)

## Relevant Files

- `devc-core/repo.ts` (new)
- `devc-core/overlay.ts`
- `devc-core/merged_config.ts`
- `devc-core/wizard_apply.ts`
- `devc-core/mod.ts`
- `devc-core/deno.json`
- `devc-core/README.md`
- `devc-core/tests/repo_test.ts` (new)
- `devc-core/tests/overlay_test.ts`
- `devc-core/tests/merged_config_test.ts`
- `devc-core/tests/wizard_apply_test.ts`
- `devc/args.ts`
- `devc/main.ts`
- `devc/help.ts`
- `devc/tui/config_flow.ts`
- `devc/tests/args_test.ts`
- `devc/tests/config_flow_test.ts`
- `devc/tests/help_test.ts`
- `devc/README.md`
- `.plans/design/devc-design.md`
- `.plans/PLAN.md`
