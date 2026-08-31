# `shell-dirs` Feature — source a project's `*.sh` in every interactive shell

## Goal

Publish `ghcr.io/devc-tools/shell-dirs`: every `*.sh` in one or more
directories is sourced by every interactive container shell, in a defined order,
live (sourced from `~/.bashrc`, not appended into it).

**This one splits — but it is whole standalone.** `"shell-dirs": {}` with no
options, no mounts and no devc gives you the **project layer**: every `*.sh` in
the repo's own `.devcontainer/shell/`, which is the layer most consumers want.

The optional second layer is _personal, host-machine_ scripts, and it needs a
bind mount whose source exists — neither of which a Feature can declare (see
[devc-feature-split](../design/devc-feature-split.md)). That mount belongs to the
**consumer's `devcontainer.json`**, exactly like the devc-bridge token mount:
any project can write it, this plan's README gives them the two lines, and devc
is simply a consumer that writes them automatically and points `userDir` at
where they landed. Nothing here is devc-only.

**Copy, don't move.** `devc:shell-dirs` in `bashrc-additions.sh` keeps running
as-is.

## Existing touchpoints

- `devc/default/scripts/bashrc-additions.sh`, the `devc:shell-dirs` fenced block
  (lines 39–82) — source material, verbatim where possible. Note its position:
  after everything devc sets (so a layer can override `PS1`/`cd`/`precmd`) and
  **before** the `DEVC_ATTACH` block that snapshots `PROMPT_COMMAND`.
- `devc/tests/shell_dirs_test.sh` — takes the script path as `$1`, extracts
  everything between the `devc:shell-dirs` markers, and rewrites the lines
  matching `^USER_SHELL_DIR=` and `^PROJECT_SHELL_DIR=` to point at temp dirs.
  **This plan reuses that harness against the Feature's copy**, which pins the
  contract below.
- `devc/README.md` "Shell setup: `shell/` folders" — the documented behavior the
  Feature must not change.
- `devc/default/devcontainer.json` (the user-layer mount) and
  `initialize-command.sh` (the `mkdir`) — cited, not edited.

## Contracts

### `features/shell-dirs/devcontainer-feature.json`

```jsonc
{
  "id": "shell-dirs",
  // Its own version, independent of the repo tag and of the other Features —
  // see .plans/archived/feature-independent-versions.md.
  "version": "0.1.0",
  "name": "Shell script directories",
  "options": {
    "projectDir": { "type": "string", "default": ".devcontainer/shell" },
    "userDir": { "type": "string", "default": "" }
  }
}
```

- **`projectDir` is workspace-relative**, resolved at shell time against
  `$PROJECT_PATH` (empty disables the layer). Relative because the Feature does
  not know the container workspace path at build time and
  `${containerWorkspaceFolder}` substitution inside Feature metadata is unverified
  (`devc-feature-split`, open question 2). An absolute value is used as-is.
- **`userDir` is an absolute container path**, empty by default. This is the slot
  devc fills with `/usr/local/share/devc/shell` when it swaps over; a non-devc
  consumer can point it at anything already in the image.
- No lifecycle command and no mounts. Everything happens at build time in
  `install.sh` plus at shell time in `~/.bashrc`.

### The `~/.bashrc` block — same markers, same variable names

`install.sh` appends a marker-guarded block (`# >>> shell-dirs >>>` … `# <<< shell-dirs <<<`,
`grep -qF` guarded) to `$_REMOTE_USER_HOME/.bashrc`, containing the
`devc:shell-dirs` fenced block **copied from `bashrc-additions.sh`** with only
the two assignments substituted:

```sh
# devc:shell-dirs (start)
USER_SHELL_DIR=<userDir, or empty>
PROJECT_SHELL_DIR="${PROJECT_PATH:+$PROJECT_PATH/<projectDir>}"
_devc_source_shell_dir() { ... }        # unchanged
_devc_source_shell_dir "$USER_SHELL_DIR"
_devc_source_shell_dir "$PROJECT_SHELL_DIR"
unset -f _devc_source_shell_dir
unset USER_SHELL_DIR PROJECT_SHELL_DIR
# devc:shell-dirs (end)
```

Hard requirements, because `devc/tests/shell_dirs_test.sh` is the test:

- the fence markers stay **`# devc:shell-dirs (start)` / `(end)`**;
- the two assignments stay on their own lines starting `USER_SHELL_DIR=` and
  `PROJECT_SHELL_DIR=` (the harness rewrites them with `sed`);
- the function stays named `_devc_source_shell_dir`, and both it and the two
  variables are still unset at the end (the harness asserts no leaks);
- user layer first, project layer second; `*.sh` only; glob order within a layer;
  a missing or empty directory is a silent no-op.

### Standalone — what a non-devc project pastes

The README must carry both halves, ready to copy. Layer one needs nothing but
the Feature and `PROJECT_PATH`:

```jsonc
"features": { "ghcr.io/devc-tools/shell-dirs:0": {} },
"remoteEnv": { "PROJECT_PATH": "${containerWorkspaceFolder}" }
```

Layer two is three lines the consumer owns, with no devc anywhere in them:

```jsonc
"initializeCommand": "mkdir -p ${localEnv:HOME}/.config/myshell",
"mounts": [
  "type=bind,source=${localEnv:HOME}/.config/myshell,target=/usr/local/share/myshell,readonly"
],
"features": {
  "ghcr.io/devc-tools/shell-dirs:0": { "userDir": "/usr/local/share/myshell" }
}
```

Note the host path is **theirs**, not `~/.config/devc/shell`. The Feature must
never default `userDir` to a devc path — that would make it look like devc
plumbing and quietly bind nothing for everyone else.

### Co-existence with devc's own block

During the interim, a devc container that opts into this Feature via
`additionalFeatures` has **both** blocks, and the project layer is sourced twice.
Idempotent for aliases and `export`, **not** for `PATH=...:$PATH`. So:

- The block records what it sourced in a shell variable
  (`_DEVC_SHELL_DIRS_DONE`, a `:`-separated list of absolute paths) and skips a
  directory already listed. Both copies gain this guard — but devc's copy is
  touched **only** by the swap plan, not here, so the interim protection is
  one-sided and the Feature's README says plainly: _devc already does this; do
  not enable this Feature in a devc container until devc's own block is gone._
- The guard variable is deliberately not exported: it must reset per shell, not
  inherit into subshells that legitimately re-source.

### Ordering hazard — write it down, do not paper over it

Features install **after** the Dockerfile runs, so the Feature's `~/.bashrc`
block lands **after** devc's `bashrc-additions` block — i.e. after the
`DEVC_ATTACH` block that snapshots `PROMPT_COMMAND` into `_DEVC_BASE_PC`. A
sourced file that _assigns_ `PROMPT_COMMAND` (already documented as
discouraged) would then clobber `devc attach`'s first-prompt clear, where today
it is merely overwritten before the snapshot is taken.

- Not fixable from the Feature (`~/.bashrc` append order is not ours).
- Not a regression for non-devc consumers, who have no `DEVC_ATTACH` block.
- Record it in the Feature README **and** in this plan's Notes; the swap plan
  must move devc's `DEVC_ATTACH` block after the Feature's append (or make it
  re-assert itself at first prompt). Flagged here so that plan does not
  rediscover it in a container.

## Concept boundaries

- **`shell-dirs` (Feature) vs `devc:shell-dirs` (fence) vs `~/.config/devc/shell`
  (host dir) vs `.devcontainer/shell/` (project dir).** Four things one word
  away from each other. The README should name all four in one paragraph.
- **`projectDir` relative, `userDir` absolute.** Asymmetric on purpose: one is
  found through the workspace, the other is a fixed container path with a mount
  behind it. An absolute `projectDir` is accepted but bypasses the
  `$PROJECT_PATH` guard.
- **`PROJECT_PATH` is devc's `remoteEnv`.** For a non-devc consumer it is unset
  and the project layer silently does nothing — the same "interactive shells
  only, `PROJECT_PATH` required" caveat `devc/README.md` documents. The Feature
  README must say how to set it (`remoteEnv` in their `devcontainer.json`), or
  the Feature looks broken out of the box. **This is the Feature's sharpest
  usability edge; consider a `workspaceEnvVar` option defaulting to
  `PROJECT_PATH` only if a second variable name is actually needed — do not add
  it speculatively.**

## Checklist

- [x] `features/shell-dirs/devcontainer-feature.json` — id/version/name, two
      options
- [x] `features/shell-dirs/install.sh` — marker-guarded `~/.bashrc` append for
      `$_REMOTE_USER`, option substitution into the two assignments, fence
      markers preserved
- [x] `_DEVC_SHELL_DIRS_DONE` skip-guard in the Feature's copy of the block
- [x] `features/shell-dirs/README.md` — the two layers, ordering, `PROJECT_PATH`
      prerequisite, the "not inside devc yet" warning, the `PROMPT_COMMAND`
      caveat
- [x] `features/shell-dirs/test/test.sh` — `devcontainer features test` scenario
- [x] `features/shell-dirs/test/run-features-test.sh` — wrapper
- [x] `features/README.md` — row
- [x] `devc/README.md` — Development section lists the new harness invocation
- [x] `.plans/PLAN.md` — register

## Validation

- [x] `bash devc/tests/shell_dirs_test.sh features/shell-dirs/install.sh`
      passes **unmodified** — the existing harness, pointed at the Feature. If it
      needs changes to pass, the copy has drifted and the contract above is broken
- [x] `bash devc/tests/shell_dirs_test.sh devc/default/scripts/bashrc-additions.sh`
      still passes (devc's copy untouched)
- [x] A case added to the harness (or a sibling harness) for the
      `_DEVC_SHELL_DIRS_DONE` guard: sourcing the block twice sources each file
      once — a **sibling**, `features/shell-dirs/test/shell_dirs_guard_test.sh`,
      because a case in `shell_dirs_test.sh` would fail against devc's guardless
      copy, which that harness has to keep passing
- [ ] (needs Docker) `bash features/shell-dirs/test/run-features-test.sh` —
      scenario with `remoteEnv.PROJECT_PATH` and a `.devcontainer/shell/10-a.sh`
      that exports a marker: a fresh interactive shell has it; ordering with a
      `userDir` layer is user-then-project; an empty `projectDir` disables it
- [ ] (needs Docker) **the bare `{}` scenario** — no options, no mounts: installs
      cleanly and sources the project layer. The Feature is not allowed to be
      inert without devc, and this is what proves it
- [x] `deno fmt --check` clean

Beyond the plan, since there is no Docker here: a second offline harness,
`features/shell-dirs/test/install_options_test.sh`, runs the real `install.sh`
against a temp `_REMOTE_USER_HOME` and covers what neither block harness reaches —
both options through to both assignments (default, absolute `projectDir`, empty
`projectDir`, `userDir`), the marker guard against a double-append, and the
option-rejection path. And all four `devcontainer features test` scripts were
executed **offline**, against a real `~/.bashrc` written by `install.sh` in a temp
`HOME` with the test lib stubbed, including their `bash -ic` interactive-shell
checks. What that cannot cover is the Docker half: the image build, the CLI's
`PROJECTDIR`/`USERDIR` option plumbing, and `${containerWorkspaceFolder}`
substitution inside each scenario's `onCreateCommand`.

## Notes

**The ordering hazard is real and is not fixed here.** Features install after the
Dockerfile, so this Feature's `~/.bashrc` block lands **after** devc's
`bashrc-additions` block — including the `DEVC_ATTACH` block that snapshots
`PROMPT_COMMAND` into `_DEVC_BASE_PC`. A sourced file that _assigns_
`PROMPT_COMMAND` (already discouraged) therefore clobbers `devc attach`'s
first-prompt clear, where today it is merely overwritten before the snapshot is
taken. Not fixable from the Feature — `~/.bashrc` append order is not ours — and
not a regression for non-devc consumers, who have no `DEVC_ATTACH` block at all.
Recorded in the Feature README under "It runs last". **The swap plan must move
devc's `DEVC_ATTACH` block after the Feature's append, or make it re-assert itself
at the first prompt.**

**The `_DEVC_SHELL_DIRS_DONE` guard is one-sided during the interim, and it happens
to work.** devc's copy has no guard and runs first, so devc sources and this
Feature's copy skips. That is the right outcome by accident of ordering, not by
design; the README says plainly not to enable this Feature in a devc container
until devc's own block is gone.

**One deviation from the contract as written.** The plan sketches
`USER_SHELL_DIR=<userDir, or empty>` unquoted; the block ships it quoted
(`USER_SHELL_DIR=""`), which the harness's `sed` rewrites identically and which
survives a path with a space. `install.sh` refuses an option containing `"`,
`` ` ``, `$` or `\` rather than escaping it — a mangled block would silently source
something other than what was asked for.

**`workspaceEnvVar` was not added**, per the concept-boundaries note. An absolute
`projectDir` already covers the consumer who will not set `PROJECT_PATH`, so a
second variable name has no case yet.

## Superseded — one decision reversed immediately after it landed

Read the Contracts section above as history on one point. **"No lifecycle command
and no mounts" is now "no mounts".** The Feature declares a `postCreateCommand`.

The plan treated `PROJECT_PATH` as an unavoidable prerequisite and said so in the
concept boundaries — _"This is the Feature's sharpest usability edge."_ It then
shipped the edge: a bare `{}` with no `remoteEnv` sourced **nothing**, which fails
the collection's own rule that `"<feature>": {}` must install cleanly _and do
something useful_. The plan's own README instruction ("must say how to set it, or
the Feature looks broken out of the box") is a description of that failure, not a
fix for it.

The reasoning that produced it conflated two times, and only one of them is
constrained:

- **Image build time** — `install.sh`. The workspace is not mounted and its path is
  genuinely unknowable. This half of the plan is correct.
- **Create time** — a lifecycle hook. The CLI computes
  `remoteCwd = remoteWorkspaceFolder || homeFolder` once and passes it to every
  hook, Feature-contributed ones included, so the workspace path is simply
  available. The plan never considered this because it had already decided against
  a lifecycle command.

So `features/shell-dirs/post-create.sh` resolves a workspace-relative `projectDir`
to an absolute path at create time and rewrites the block's `PROJECT_SHELL_DIR=`
line. `PROJECT_PATH` is now an **override**, still preferred when set, so devc and
any consumer who already wrote the `remoteEnv` line are unaffected.

What this deliberately does **not** cost:

- **The drift contract holds.** The two assignment lines were already the defined
  parameterization slot — the harness rewrites them, `install.sh` rewrites them,
  and now `post-create.sh` rewrites one. The block itself is still a verbatim copy
  of devc's, and `devc/tests/shell_dirs_test.sh` still passes unmodified against
  both files.
- **Liveness is untouched.** Only the path is resolved. Every shell still reads the
  directory's contents, so a file added after create still needs no rebuild.
- **devc's copy is not edited.** The rewrite is scoped between this Feature's own
  `# >>> shell-dirs >>>` markers, because devc's block carries an identically named
  assignment and an unscoped `/^PROJECT_SHELL_DIR=/` would rewrite both.

The one assumption it rests on is **open question 1, which is still a source read
rather than a measurement.** Guarded rather than assumed: if `PROJECT_PATH` is unset
_and_ the cwd is the home folder — precisely the CLI's `|| homeFolder` branch — the
hook declines, explains which of the two things to set, and exits 0, leaving the
block deferring to `PROJECT_PATH` exactly as before. And the default
`devcontainer features test` scenario now **measures** the cwd: it asserts the
assignment is an absolute workspace path rather than the deferred form, which is
only true if the CLI handed the hook the workspace folder.

`version` stays `0.1.0` — the Feature was never pushed, so nothing has published and
there is nothing to bump from.

Checklist for the reversal:

- [x] `features/shell-dirs/post-create.sh` — resolve, marker-scoped rewrite,
      decline-on-home-folder guard, idempotent
- [x] `install.sh` — place it under `SHARE_DIR`, bake `projectDir`, `chmod 0755`
- [x] `devcontainer-feature.json` — `postCreateCommand`, option descriptions
- [x] `features/shell-dirs/test/post_create_test.sh` — 33 checks, offline
- [x] `test/bare_no_env.sh` + scenario — one line, no `remoteEnv`, a real fixture
- [x] `test/test.sh` — now measures the hook's cwd
- [x] README — "How the workspace-relative path is found" replaces the
      prerequisite section; the install shrinks to one line

## Not in this plan

- Any edit to `devc/default/` — the mount, `initialize-command.sh`, and the
  `devc:shell-dirs` block all stay. The `DEVC_ATTACH` reordering belongs to the
  swap plan.
- `zsh`/`fish` support. `install.sh` writes bash only; note it as a limitation
  rather than half-implementing it.
