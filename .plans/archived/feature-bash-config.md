# `bash-config` Feature — two known directories, sourced by `~/.bashrc` and `~/.profile`

## Goal

Publish `ghcr.io/devc-tools/features/bash-config`: source every `bashrc_*.sh` from
`~/.bashrc` and every `profile_*.sh` from the login profile, out of **two fixed
container directories** — one the consumer populates (a mount, a copy, anything),
one a symlink to the workspace that a create-time hook points at the project.

This supersedes [`shell-dirs`](../features/shell-dirs/README.md) and exists because
`shell-dirs` grew a class of complexity that its shape made unavoidable: the whole
sourcing block lives _inside_ `~/.bashrc`, so both `install.sh` and `post-create.sh`
rewrite lines within it — `bake()` plus two `awk` passes plus four verification
`grep`s plus marker scoping plus a `cp`-not-`mv` dance, with the empty/absolute/
relative policy written out twice.

**The fix is that nothing rewrites anything.** `~/.bashrc` and the login profile get
a _static_ two-line block naming a fixed path. All configuration lives in files the
Feature owns outright. The paths in the block never change, so they never need to be
patched.

**Copy, don't move.** `devc/default/scripts/bashrc-additions.sh` keeps running
unchanged, and `features/shell-dirs/` stays in the tree until `bash-config` has been
verified under Docker. Retiring both is a later plan.

## Why this shape — the measurements behind it

Every one of these was measured in this repo's devcontainer against
`/etc/skel/.bashrc`, not reasoned about. They are the constraints the contracts below
encode.

1. **`~/.bashrc` reaches interactive shells only.** The stock `case $- in *i*) ;; *)
   return;; esac` guard sits at the top, and the Feature appends at the bottom.
   Measured: `bash -c 'echo $VAR'` → unset; `bash -ic` → set.
2. **`~/.profile` reaches login shells, not non-interactive ones.** Measured:
   `bash -lc` → set; `bash -c` → still unset. Adding a profile block widens coverage
   to `bash -lc` and `bash -il`; **it does not "fix the non-interactive case."** Plain
   `bash -c` reads no startup file at all. Only `containerEnv` reaches it, and a
   Feature cannot produce a dynamic `containerEnv` — measured: a feature manifest's
   `containerEnv` gets **no** substitution, neither `${containerWorkspaceFolder}` nor
   `${option}`. Interactive + login is this Feature's ceiling and the README must say so.
3. **Creating `~/.bash_profile` is destructive.** bash reads the _first_ of
   `~/.bash_profile`, `~/.bash_login`, `~/.profile`. This image ships only
   `~/.profile`, and `~/.profile:14` is what sources `~/.bashrc`. Measured: with a
   naive `~/.bash_profile` present, an interactive login shell ran **neither**
   `~/.profile` nor `~/.bashrc`. `install.sh` must target whichever file bash will
   actually read, never invent `~/.bash_profile`.
4. **`bashrc_*` runs before `profile_*` in an interactive login shell**, because
   `~/.profile` sources `~/.bashrc` before reaching the appended block. In a plain
   terminal only `bashrc_*` runs; in `bash -lc` only `profile_*`. They are two
   audiences with partial overlap, **not two ordered layers**.
5. **`~/.profile` is read by dash.** Measured: `sh -l` executed the profile block. So
   the sourcing logic and anything it sources at profile level is POSIX `sh`, not bash.
6. **A symlinked directory globs live.** Measured: adding and deleting a file in the
   workspace changed what a fresh shell sourced with no re-run of anything; a dangling
   symlink and an empty directory were both silent no-ops at `rc=0`. This is what lets
   the block be static _and_ keep `shell-dirs`' liveness property.
7. **Feature option values do get `${containerWorkspaceFolder}` substituted**, before
   any container exists. Not used by the contracts below, but it is the escape hatch if
   the create-time hook ever proves insufficient — recorded so it is not re-derived.

## Existing touchpoints

- `features/shell-dirs/` — source material for the sourcing loop, the option
  validation, and the README's mount recipe. **Not edited, not deleted by this plan.**
- `features/node-nvmrc/install.sh` + `post-create.sh` — the
  install-copies-a-script-into-`/usr/local/share` pattern this Feature follows. Note
  the deviation: `node-nvmrc` _bakes_ options into the copied script; this Feature
  writes a config file the hook sources instead.
- `features/README.md` — gains a row in the published-Features table and, once this
  Feature is in use, a note that `shell-dirs` is superseded.
- `features/PUBLISH_ALLOWLIST` — `bash-config` is **not** added. It stays invisible to
  ghcr.io while under development, exactly as `shell-dirs` does today.
- `.plans/design/devc-feature-split.md` — the rules this inherits: `{}` must work, no
  host bind mount, no option defaulting to a devc path.
- `devc/default/devcontainer.json` and `devc/default/scripts/bashrc-additions.sh` —
  cited, **not edited**. devc's swap is a later plan.

## Contracts

### Fixed paths

```
/usr/local/share/devc-features/bash-config/
  post-create.sh          # internal: the create-time hook the manifest names
  init.sh                 # internal: the sourcing logic, shipped verbatim, never rewritten
  config.sh               # internal: written by install.sh, sourced by post-create.sh
  dirs/
    user/                 # PUBLIC CONTRACT — real directory, created empty, never populated
    project               # PUBLIC CONTRACT — symlink, created by post-create.sh
    env.sh                # written by post-create.sh; sourced by init.sh if present
```

`dirs/user/` is the Feature's published surface: a consumer bind-mounts onto it, or
copies into it, or leaves it empty. **The Feature never writes into it and never
learns where its contents came from** — that is what keeps devc out of this Feature.

`dirs/project` is a symlink, not a copy, so the workspace stays the source of truth
and edits are live.

### `features/bash-config/devcontainer-feature.json`

```jsonc
{
  "id": "bash-config",
  // Its own version, independent of the repo tag — see
  // .plans/archived/feature-independent-versions.md.
  "version": "0.1.0",
  "name": "Bash config directories",
  "options": {
    "projectDir": {
      "type": "string",
      "default": ".devcontainer/shell"
    }
  },
  "postCreateCommand": "bash /usr/local/share/devc-features/bash-config/post-create.sh"
}
```

One option, because one thing is genuinely per-project: where in the workspace the
files live. There is no `userDir` — that directory is now a fixed path. There is no
off-switch — an empty or absent directory is already a silent no-op.

`projectDir` accepts a workspace-relative path (the default), an absolute container
path (linked as-is), or `""` (no project symlink is created).

### `init.sh` — the sourcing logic

Shipped verbatim by `install.sh`; **never rewritten by anything**. Must be POSIX `sh`,
because `~/.profile` is read by dash (measurement 5).

Contract:

- Reads `$_bash_config_kind` (`bashrc` or `profile`) to select the glob prefix.
- Sources `dirs/env.sh` if readable, before anything else, so layer scripts see
  `PROJECT_PATH`.
- For `dirs/user` then `dirs/project`, in that order: skip unless `[ -d ]`, then source
  every `"<dir>/${_bash_config_kind}_"*.sh` that passes `[ -f ]` (which is also the
  unmatched-glob and empty-directory guard).
- Leaves no helper function or loop variable behind, and leaves `$?` at 0.
- Sources each directory at most once per shell, keyed on the resolved path — a
  container that also has devc's `devc:shell-dirs` block must not source a layer twice.
  **Corrected in implementation: the key is `<kind>@<resolved path>`, not the path
  alone.** In an interactive login shell the `bashrc` pass runs first over these same
  two directories (measurement 4), so a path-only key would mark them done and silently
  disable every `profile_*.sh`. The guard still does what this line intends; a test
  fails when the kind is removed from the key.

User directory first, project second, so a project's committed settings win — the same
`system → global → local` order git uses, and the same order `shell-dirs` documents.

### The block appended to `~/.bashrc` and to the login profile

Identical apart from the kind. Static — no substitution at install time, no rewrite at
create time:

```sh
# >>> bash-config >>>
_bash_config_kind=bashrc
. /usr/local/share/devc-features/bash-config/init.sh
# <<< bash-config <<<
```

Marker-guarded so a rebuild does not double-append. `init.sh` unsets
`_bash_config_kind`; the block does not, so that a missing `init.sh` cannot leave the
shell in a broken state mid-source.

### `install.sh` — build time, root

- Writes `config.sh` with `PROJECT_DIR=<projectDir>`. **Not** a `sed` bake of
  `post-create.sh`: a sourced config file has no rewrite to verify and no replacement-side
  escaping hazard. (`shell-dirs`' `bake()` uses `sed` with the raw option on the
  replacement side, where an `&` back-references the match and a `|` breaks the
  expression — both confirmed. Nothing here reproduces that.)
- Rejects a `projectDir` containing `"`, `` ` ``, `$`, `\` or a newline, failing the
  build and naming the option.
- Creates `dirs/user/` and `chown`s `dirs/` to `$_REMOTE_USER` — **required**, because
  `/usr/local/share` is root-owned and `post-create.sh` runs as the remote user, so it
  could not otherwise create the symlink.
- Appends the block to `$_REMOTE_USER_HOME/.bashrc`.
- Appends the block to the login profile, chosen as **the first existing of**
  `~/.bash_profile`, `~/.bash_login`, `~/.profile`, creating `~/.profile` only when none
  exists. Never creates `~/.bash_profile` (measurement 3).
- `chown`s any file it created to `$_REMOTE_USER`.

### `post-create.sh` — create time, remote user

Sources `config.sh`, then:

- Resolves the workspace: `$PROJECT_PATH` if set, else its own cwd — the CLI hands every
  lifecycle hook the workspace folder. If `PROJECT_PATH` is unset **and** the cwd equals
  `$HOME`, that is the CLI's `remoteWorkspaceFolder || homeFolder` fallback firing; the
  hook declines, says which of the two things to set, and exits 0.
- Points `dirs/project` at `<workspace>/$PROJECT_DIR` (or at `$PROJECT_DIR` when
  absolute) with `ln -sfn`. Removes the symlink when `PROJECT_DIR` is empty.
- Writes `dirs/env.sh` containing `export PROJECT_PATH="${PROJECT_PATH:-<workspace>}"` —
  guarded, so an inherited value still wins.
- Is idempotent: running it twice leaves the same two files.

## Concept boundaries

Four things one word apart, and one trap:

- **`bash-config`** — this Feature.
- **`shell-dirs`** — the Feature this supersedes. Still in the tree, still with its own
  `devc:shell-dirs` block. A container with both enabled sources the project layer
  twice unless the once-per-shell guard catches it.
- **`devc:shell-dirs`** — the fence in `devc/default/scripts/bashrc-additions.sh`.
  **`bash-config` deliberately does not use it, and is not pinned to it.**
  `devc/tests/shell_dirs_test.sh` extracts that fence from `install.sh` and must pass
  against both `shell-dirs` and devc — that shared harness is precisely what forced
  `shell-dirs`' inline-block shape and therefore its complexity. `bash-config`'s block
  is a different block; it gets its own tests and shares none.
- **`dirs/user` vs `userDir`** — `shell-dirs` had a `userDir` _option_ naming an
  arbitrary path. `bash-config` has a fixed `dirs/user` _path_ and no such option.
- **`bashrc_` / `profile_` are targets, not ordering.** They select which file sources
  the script. They do not imply that `profile_` runs after `bashrc_` — that is true only
  in an interactive login shell (measurement 4).

## Tests

Offline, no Docker — the shapes `shell-dirs` and `node-nvmrc` already use:

- `test/init_test.sh` — `init.sh` against temp directories: both kinds, prefix routing,
  user-before-project ordering, project-wins-on-conflict, live add/delete through the
  symlink, dangling symlink, empty directory, non-`.sh` files, subdirectories, no leaks,
  `$?` at 0, double-source guard, and **running under `dash`** (measurement 5).
- `test/install_options_test.sh` — options through to `config.sh`, both blocks appended,
  the marker guard against a double-append, the refusal path, `dirs/user` created and
  owned correctly, and the login-profile selection across all four states of the
  `~/.bash_profile` / `~/.bash_login` / `~/.profile` chain (measurement 3).
- `test/post_create_test.sh` — symlink created from cwd, `PROJECT_PATH` preferred over
  cwd, the cwd-equals-`$HOME` refusal, absolute and empty `projectDir`, `env.sh`
  contents and its guard, and idempotency.

`devcontainer features test` scenarios, needing Docker:

| Scenario      | What it pins                                                             |
| ------------- | ------------------------------------------------------------------------ |
| _(default)_   | A bare `{}` installs; the hook resolved a real symlink from its own cwd. |
| `bare_no_env` | No `remoteEnv`, a committed project folder — a new shell has it.         |
| `login_shell` | `profile_*.sh` fires under `bash -lc`; `bashrc_*.sh` does not.           |
| `both_dirs`   | User directory before project; project wins on conflict.                 |
| `live_edit`   | A file added after create is sourced by the next shell.                  |

Each scenario writes its fixtures from its own `onCreateCommand`, which runs before
every `postCreateCommand` — `devcontainer features test` generates the workspace itself,
so there is no committed fixture that could already be there.

## Open questions — measure, do not assume

1. **Does `userEnvProbe` pick up `dirs/env.sh` on first create?** The CLI defaults to
   `loginInteractiveShell` (`defaultUserEnvProbe:"loginInteractiveShell"`, running
   `bash -lic`), so anything the profile exports is captured and propagated to processes
   the CLI starts. Whether that probe runs _before_ or _after_ `postCreateCommand` on a
   first create is **unmeasured**. If after, `PROJECT_PATH` reaches VS Code's process
   environment too; if before, only from the second container start. Do not document the
   wider reach until a scenario shows it.
2. **Ownership of `dirs/` under a non-root remote user in an image that is not
   Debian-derived.** `install.sh` uses `$_REMOTE_USER`; the `chown` is the one step that
   fails loudly if that assumption is wrong. Confirm in the default scenario.

## Checklist

- [x] `features/bash-config/devcontainer-feature.json` — id, `0.1.0`, one option
- [x] `features/bash-config/init.sh` — POSIX `sh`, both kinds, both directories
- [x] `features/bash-config/install.sh` — config file, `dirs/`, both blocks, profile chain
- [x] `features/bash-config/post-create.sh` — symlink, `env.sh`, refusal path
- [x] `features/bash-config/README.md` — bare `{}`, the mount recipe with **no devc path**,
      and the coverage ceiling stated plainly (interactive + login bash; not `bash -c`,
      not `sh`, not exec'd binaries — with the `containerEnv` line for those who need it)
- [x] `features/bash-config/test/` — three offline harnesses, `test.sh`, `scenarios.json`,
      `run-features-test.sh` copied byte-identical from a sibling
- [x] `features/README.md` — table row; note that `shell-dirs` is superseded
- [x] `PUBLISH_ALLOWLIST` — deliberately **not** touched
- [x] `.plans/PLAN.md` — Pending bullet + Development Phases row
- [x] Run: all three offline harnesses, `tests/features_test.sh`,
      `tests/workflow_guards_test.sh`, `deno fmt --check`
