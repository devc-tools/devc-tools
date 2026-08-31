# `node-nvmrc` 0.2.0 — the pinned Node for every process, not every interactive shell

## Goal

Make the workspace's `.nvmrc` decide the Node version **every process in the
container** gets — `sh -c`, `docker exec`, an agent CLI, a task, an editor
extension — and delete the interactive-shell half of the Feature entirely.

The Feature becomes what it should always have been: **an extension of
`ghcr.io/devcontainers/features/node` that drives the version from `.nvmrc`
instead of from a Feature option.** It still installs neither Node nor nvm.

Two moving parts replace the `~/.bashrc` block:

1. a **static PATH entry** the Feature declares in `containerEnv`, naming a
   directory it owns;
2. a **symlink** the create-time hook points at the pinned version's `bin`.

Nothing is appended to any startup file, so nothing depends on a shell being
interactive, being bash, or existing at all.

**`autoUseOnCd` and the `cd` override are removed, not deprecated.** This is a
breaking change to a published Feature; `version` goes to `0.2.0` and the README
says so. `:0` is the documented license for that while this Feature is pre-1.0
(`features/README.md#versions`).

**Copy, don't move.** `devc/default/scripts/node-setup.sh` and the nvm lines in
`devc/default/scripts/bashrc-additions.sh` are untouched and keep running,
including devc's own `cd` override. Swapping devc onto this Feature stays a
later plan.

## Why — seven things measured in this devcontainer

Recorded because the current design is defensible only under assumptions that
turn out to be false, and a cold reader will otherwise re-litigate them.

1. **The `~/.bashrc` block reaches only interactive bash.** `~/.bashrc:5-8` is
   the stock `case $- in *i*) ;; *) return;; esac` guard. `~/.profile:12-17`
   sources `~/.bashrc` unconditionally, but the guard returns first — so
   `bash -lc 'declare -F cd'` reports **no override**. Only `bash -ic` /
   `bash -lic` see the block, which is why `test/with_nvmrc.sh` had to assert
   through `bash -lic`.

2. **The consumers that matter here are neither interactive nor bash.** Claude
   Code's Bash tool in this container is **zsh 5.9** with `$-` = `569JNRXghkl`
   (no `i`). Its parent is `claude`, itself launched from `/bin/bash -l`. The
   tool shell inherits `claude`'s **frozen** PATH, so the Node version an agent
   sees is whatever the launching terminal had selected, for the whole session,
   regardless of `cd`. Copilot CLI spawns `$SHELL` the same way.

3. **`containerEnv` PATH injection works, and the upstream node Feature already
   proves it.** PID 1's environment here carries
   `PATH=…:/usr/local/share/nvm/current/bin:…`, `NVM_DIR=/usr/local/share/nvm`
   and `NVM_SYMLINK_CURRENT=true`, and `bash -c`, `sh -c` and `bash -lc` all
   resolve `node` through `/usr/local/share/nvm/current/bin/node`. That is the
   mechanism this plan adopts.

4. **`$NVM_DIR/current` is container-global mutable state** (`nvm.sh:4184`
   rewrites it on every `nvm use` when `NVM_SYMLINK_CURRENT=true`). Measured: a
   `nvm use` inside an unrelated subshell moved the symlink's mtime
   (`09:26:22` → `09:41:37`) for the entire container. So today's `cd` hook lets
   any terminal repoint Node for every other process — the secondary goal
   actively fights the primary one.

5. **`nvm install` exports `NVM_BIN`** (it runs `nvm use` implicitly), which is
   the pinned version's `bin` directory outright — no version-string parsing
   needed. Measured in this container: `NVM_BIN=/usr/local/share/nvm/versions/node/v26.7.0/bin`.

6. **`nvm install` does not move the `default` alias.** `nvm_ensure_default_set`
   (`nvm.sh:2302`) writes it only when none exists, and the node Feature already
   wrote one (`/usr/local/share/nvm/alias/default` reads `node` here). So the pin
   currently lives nowhere in nvm's own state.

7. **`nvm use --silent` on an uninstalled pinned version is completely silent** —
   exit 3, no stdout, no stderr, version unchanged. Measured. Today's `cd` hook
   therefore fails with no signal at all, and `return 0` hides the status too.

## Existing touchpoints

- `features/node-nvmrc/devcontainer-feature.json` — gains `containerEnv` and
  `projectDir`, loses the `autoUseOnCd` option, `version` → `0.2.0`.
- `features/node-nvmrc/install.sh` — **most of it is deleted**: the
  `devc:nvm-use` heredoc, the two markers, the `~/.bashrc` grep guard and
  append, the block's own bake+verify, the `_REMOTE_USER_HOME` resolution and
  the `chown` of `~/.bashrc`. What stays is `mkdir`/`cp`/bake, plus two new
  steps (the `pin/` directory and option validation).
- `features/node-nvmrc/post-create.sh` — every existing guard is kept verbatim
  (silent exit on no `.nvmrc`, warn-and-exit-0 on missing nvm, the narrow
  `node_modules` chown, fatal `nvm install`); only the `cd` above them changes,
  and two steps are appended after `nvm install`.
- `devc/default/devcontainer.json:58` — the `node_modules` volume mount, cited in
  the chown discussion below. **Not edited** (copy-don't-move).
- `features/node-nvmrc/README.md` — the shell-hook sections go; a "what reaches
  what" statement, `projectDir`, and a `0.2.0` breaking-change note arrive.
- `features/node-nvmrc/test/nvm_use_test.sh` — **deleted.** It exists solely to
  exercise the block being removed.
- `features/node-nvmrc/test/test.sh`, `with_nvmrc.sh`, `no_nvmrc.sh`,
  `scenarios.json` — rewritten assertions (below).
- `features/README.md:16` — the row's "and selects it on `cd`" is now false.
- `.plans/design/devc-feature-split.md:103` — same phrase in the split table.
- `.plans/design/devc-feature-split.md:179-188` — the open question about a
  Feature-declared `postCreateCommand`'s cwd. **Still open and still
  load-bearing**; `with_nvmrc` remains what measures it.

## Contracts

### `features/node-nvmrc/devcontainer-feature.json`

```jsonc
{
  "id": "node-nvmrc",
  "version": "0.2.0",
  "name": "Node from .nvmrc",
  "description": "...",
  "documentationURL": "https://github.com/devc-tools/devc-tools/tree/main/features/node-nvmrc",
  "options": {
    "nvmDir": { "type": "string", "default": "/usr/local/share/nvm" },
    "projectDir": { "type": "string", "default": "" },
    "installOnCreate": { "type": "boolean", "default": true },
    "fixNodeModulesOwnership": { "type": "boolean", "default": true }
  },
  "installsAfter": ["ghcr.io/devcontainers/features/node"],
  "containerEnv": {
    "PATH": "/usr/local/share/devc-features/node-nvmrc/pin/bin:${PATH}"
  },
  "postCreateCommand": "bash /usr/local/share/devc-features/node-nvmrc/post-create.sh"
}
```

`installsAfter` now carries weight it did not before: it puts this Feature's
`ENV` line **after** the node Feature's, so `${PATH}` already contains
`…/nvm/current/bin` and this entry lands **in front of it**. That ordering is
the whole precedence story and it is the one thing here that cannot be measured
offline — see the `pin_outranks_current` scenario.

`autoUseOnCd` is **gone**. Not `default: false`, not deprecated — a consumer who
passes it gets the CLI's unknown-option behavior, which is the honest signal.

### `projectDir` — where the Node project is

Not every repo keeps its Node project at the workspace root. This option names
the directory that **is** the Node project, and the whole create-time hook runs
there: it is where `.nvmrc` is looked for and where `node_modules` is repaired.
One directory, one `cd`, both halves following it.

It is emphatically _not_ the multi-`.nvmrc` case this plan rejects — exactly one
`.nvmrc` is read, once, at create time. `projectDir` chooses **which one**.

- **Workspace-relative** by default; an **absolute** value is used as-is. Empty
  (the default) means the workspace root, which is today's behavior exactly.
  Same resolution policy as `bash-config`'s `projectDir`.
- **A directory, not a file.** There is deliberately no way to point at a
  differently-named version file: `nvm install` resolves `.nvmrc` by that name
  from its cwd and has no flag to override it, so an option that appeared to
  accept `.node-version` would silently install from something else.
- **A `projectDir` that does not exist** warns on stderr and exits 0. It is a
  misconfiguration, not a reason to make the container uncreatable.

The hook changes directory there and runs `nvm install` with no arguments, so
**nvm's own parser reads the file** — it accepts comments and `key=value` lines
(`nvm.sh:550`, `nvm_nvmrc_invalid_msg`), and reimplementing that here would drift
from it. Nothing in this Feature parses `.nvmrc`.

**The existing `[ -f .nvmrc ]` guard becomes load-bearing rather than
belt-and-braces.** `nvm install` with no arguments walks _up_ the tree
(`nvm_find_nvmrc` → `nvm_find_up`, `nvm.sh:542-548`), so with `projectDir` set to
a subdirectory that has no `.nvmrc`, nvm would silently fall back to the
workspace root's — the option would appear to work while pinning something else
entirely. Checking the exact directory first is what makes it mean what it says.

**Explicit misses warn; the default miss stays silent.** The hook tells them
apart by comparing the baked value against the empty default — no extra baked
flag:

| `projectDir` | no `.nvmrc` there | why                                                                                      |
| ------------ | ----------------- | ---------------------------------------------------------------------------------------- |
| default      | silent, 0         | the Feature must stay safe to leave enabled in a repo pinning nothing                    |
| explicit     | warn, 0           | the consumer named a directory; silence would send them hunting for where Node came from |

Still exit 0 either way — a missing pin is not worth an uncreatable container,
same grading as the missing-nvm path.

#### What moving the chown costs, and why it is still right

The `node_modules` repair now happens at `<projectDir>/node_modules`. That is a
real behavior change for anyone who sets the option, so it is recorded rather
than assumed harmless.

The repair is guarded by `[ -d node_modules ]`, and the case it exists for is a
**named volume**: that is the thing which is present at create time _and_
root-owned, and it is unfixable afterwards because `npm ci` as the remote user
cannot write into it. Mounting one is the consumer's choice, so following
`projectDir` means the repair lands where someone with a subdirectory project
would have mounted it.

It is **not** true that a volume is the only way the directory can exist — the
plan should not claim it, because `chown -R` has consequences and an implementer
will reason from this paragraph. A bind-mounted workspace can already carry a
`node_modules` from host-side development; an `onCreateCommand` or
`updateContentCommand` runs before this hook and may have installed one; an image
can ship one. In those cases the chown fires on files that are not a volume.
That is **pre-existing behavior at the workspace root**, unchanged in kind and
merely relocated by this option — and it stays bounded the same way: `sudo -n` so
it cannot hang, `2>/dev/null || true` so it cannot fail the create, and never the
workspace itself. Worth one line in the README rather than a redesign.

The case it stops covering: a volume mounted at the **workspace root** while
`projectDir` points elsewhere. devc's bundled config does exactly that —
`devc/default/devcontainer.json:58` mounts
`${containerWorkspaceFolder}/node_modules` — so a devc user who sets
`projectDir` gets a root-owned volume at the root that nothing repairs. It is
also a volume nothing writes to, since their `npm ci` runs in the project
directory. The README's answer is one line: mount the volume where the project
is. Not worth a second option, and **not** worth repairing both — "only
`node_modules`, only when it already exists, never the workspace itself" is the
narrowness the current code states outright, and two chown targets is the first
step away from it.

Anyone who leaves `projectDir` alone sees no change at all.

### The two paths, and who owns them

```
/usr/local/share/devc-features/node-nvmrc/
  post-create.sh   root:root 0755   (unchanged — test.sh already asserts this)
  pin/             $_REMOTE_USER    created empty at build time
  pin/bin          symlink → $NVM_BIN, created at create time
```

`pin/` is a **separate, user-owned subdirectory** rather than chowning
`$SHARE_DIR` itself, exactly as `bash-config` does with `dirs/`: the create-time
hook runs unprivileged and must create a symlink under a root-owned
`/usr/local/share`, but `post-create.sh` must stay root-owned. Non-recursive
`chown` of one subdirectory satisfies both.

A user-writable directory on the container-wide PATH is a recorded decision, not
an oversight: the remote user already has `~/.local/bin` on PATH and, in a
typical devcontainer, passwordless sudo. This adds no vector that was not
already there.

### `features/node-nvmrc/install.sh`

Root, build time. Fetches nothing. In order:

1. `mkdir -p "$SHARE_DIR"`, `cp` + `chmod 0755` `post-create.sh` — unchanged.
2. **Validate `nvmDir` and `projectDir` before baking them.** A value containing
   `"`, `` ` ``, `$`, `\` or a newline **fails the build**, naming the option.
   Both are pasted into shell assignments; today neither is checked, and
   `nvmDir='/opt/n"; touch /tmp/PWNED; :"'` bakes to
   `NVM_DIR="/opt/n"; touch /tmp/PWNED; :""` **and passes the existing verify
   `grep`**, because the grep is built from the same unescaped value. Same policy,
   same wording and the same character set as `shell-dirs`/`bash-config` — and
   `projectDir` needs no rule beyond that one, since it names a directory and the
   hook resolves it at runtime.
3. **Bake through `awk -v`, not `sed`**, and verify with `grep -qxF` — so a `&`
   or `|` in a path is data on both sides. `shell-dirs` already made this change
   after copying `node-nvmrc`'s `sed`; this closes the loop. Five assignments:
   `NVM_DIR`, `PROJECT_DIR`, `INSTALL_ON_CREATE`, `FIX_NODE_MODULES_OWNERSHIP`
   and `SHARE_DIR`. A failed rewrite still dies naming the variable.

   `${VAR-default}`, **not** `${VAR:-default}`, for `PROJECT_DIR` — an explicitly
   empty `projectDir` means the workspace root and must not fall back to
   anything. `shell-dirs` made the same distinction for the same reason.
4. `mkdir -p "$SHARE_DIR/pin"` and `chown "$_REMOTE_USER" "$SHARE_DIR/pin"` when
   `_REMOTE_USER` is set (non-recursive, best-effort as today's `~/.bashrc`
   chown was).

`SHARE_DIR` keeps its `${SHARE_DIR:-…}` override for the offline harnesses.

### `/usr/local/share/devc-features/node-nvmrc/post-create.sh`

Remote user, create time. The existing guards and their comments survive
verbatim; the only structural change is that the single `cd` now resolves through
`projectDir`, after which **every existing step runs unchanged in that
directory** — `[ -f .nvmrc ]`, the nvm check, the `node_modules` repair,
`nvm install`:

```sh
WORKSPACE="${PROJECT_PATH:-$PWD}"

# Absolute is used as-is; anything else is workspace-relative; empty is the root.
case "$PROJECT_DIR" in
  '') TARGET="$WORKSPACE" ;;
  /*) TARGET="$PROJECT_DIR" ;;
   *) TARGET="$WORKSPACE/$PROJECT_DIR" ;;
esac

cd "$TARGET" 2> /dev/null || {
  echo "node-nvmrc: projectDir '$PROJECT_DIR' does not exist under $WORKSPACE." >&2
  exit 0
}

# Unchanged from here, except that a miss is only silent at the default.
if [ ! -f .nvmrc ]; then
  [ -z "$PROJECT_DIR" ] || echo "node-nvmrc: no .nvmrc in $PWD — nothing pinned." >&2
  exit 0
fi
```

After `nvm install`, two steps:

```sh
# after `nvm install` — NVM_BIN is exported by the `nvm use` it runs implicitly
[ -n "${NVM_BIN:-}" ] || die 'nvm install succeeded but NVM_BIN is unset'
ln -sfn "$NVM_BIN" "$SHARE_DIR/pin/bin"
```

`-n` is required, not stylistic: without it a second run resolves the existing
symlink-to-directory and creates `pin/bin/bin`.

Then, **best-effort with a stderr note on failure**:

```sh
nvm alias default "$(nvm current)" > /dev/null 2>&1 || \
  echo "node-nvmrc: could not set nvm's default alias; PATH still names the pinned version" >&2
```

The PATH entry is authoritative; the alias only keeps nvm's own state from
disagreeing with it (measurement 6). It must not be able to fail the create.

Grading of the existing failure paths is unchanged and is a hard requirement:
no `.nvmrc` at the default location → silent exit 0; **no `.nvmrc` under an
explicit `projectDir`, or a `projectDir` that does not exist → warn, exit 0**;
no nvm → warn, exit 0, **no symlink**; `installOnCreate: false` → exit 0, **no
symlink**; `nvm install` failing → fatal.

### The inert case

With no `.nvmrc` (or `installOnCreate: false`, or no nvm), `pin/bin` is never
created. A PATH entry naming a nonexistent directory is silently skipped by every
shell and by `execvp`, so lookup falls through to whatever else provides `node`.
That preserves the collection's rule that the Feature is safe to leave enabled in
a repo that pins nothing — and it must be asserted, not assumed.

### Precedence, stated once

- **Container-wide**, the pin wins: `pin/bin` sits ahead of `…/nvm/current/bin`,
  so nothing a human's `nvm use` does to nvm's global symlink (measurement 4) can
  override the workspace pin for other processes.
- **Inside one interactive shell**, the human still wins: `nvm use` prepends the
  _versioned_ directory to that shell's own PATH, ahead of `pin/bin`.
- **Interactive shells agree by default.** `/etc/bash.bashrc:97-98` sources
  `nvm.sh`, whose `nvm_auto use` resolves `nvm_ls_current` — which is now the
  pinned version, because `pin/bin` won — and re-selects it. No block in
  `~/.bashrc` is needed to make a terminal consistent with everything else.

## Concept boundaries

- **`$NVM_DIR/current` vs `$SHARE_DIR/pin/bin`.** Both are "the symlink". nvm's
  is container-global and moved by _any_ `nvm use` in _any_ shell; this
  Feature's is moved only by its own create-time hook. An agent told to "fix the
  symlink" has a coin flip unless the distinction is in the code comments. This
  is also why the directory is named `pin/` and **not** `current/`.
- **`NVM_BIN`** is nvm's exported variable (the source of the link target);
  `pin/bin` is this Feature's link name. Do not rename one after the other.
- **Four files must agree on one literal path** —
  `/usr/local/share/devc-features/node-nvmrc` appears in the manifest's
  `containerEnv` and `postCreateCommand`, in `install.sh`'s `SHARE_DIR` default,
  and in `post-create.sh`'s baked `SHARE_DIR`. Nothing but a test catches a
  rename; `bash-config`'s `install_options_test.sh` already does this and is the
  shape to copy.
- **This Feature vs `ghcr.io/devcontainers/features/node`.** Unchanged and now
  the headline framing: that Feature installs Node and nvm, this one chooses the
  version. `installsAfter`, still not `dependsOn` — the existing README section
  explaining why stays as written.
- **devc's copies are not this.** `devc/default/scripts/bashrc-additions.sh:13-17`
  keeps its unconditional `cd` override. It is _not_ the thing this plan deletes
  and must not be touched; the copy-don't-move rule is what keeps
  `devc/tests/` passing.
- **Removed, not renamed.** `autoUseOnCd`, the `devc:nvm-use` fence and
  `nvm_use_test.sh` disappear. A reader who finds them in git history or in
  devc's baseline should not reintroduce them here.
- **`projectDir` here vs `projectDir` in `bash-config`.** Same name, same
  resolution policy, **different subject**: there it is a directory of shell
  scripts to source (`.devcontainer/shell`), here it is the Node project itself
  (`packages/app`). Both can appear in one `devcontainer.json` with different
  values and both be correct. The name is reused deliberately — the collection
  should have one answer to "how is a path option resolved" — but each README
  must say what _its_ directory contains in the option table, not just how it is
  resolved.
- **`projectDir` (which project is the pin) vs per-directory switching (which
  this Feature does not do).** They sound alike and are opposites: one names a
  single directory read once at create time; the other would mean the version
  changes as you move around, which is dropped as a goal. The README must not
  describe `projectDir` as "monorepo support" — a monorepo whose packages pin
  _different_ versions is still out of scope, and this option picks one of them.
- **`$PROJECT_PATH`/`$WORKSPACE` (the workspace root) vs `$TARGET` (the resolved
  project directory).** Identical whenever `projectDir` is left alone, which is
  what makes conflating them easy. Only `$TARGET` is ever `cd`'d into; the
  workspace root is used for nothing but resolving a relative value.

## Checklist

- [x] `features/node-nvmrc/devcontainer-feature.json` — `0.2.0`, `containerEnv`,
      `projectDir` added, `autoUseOnCd` removed
- [x] `features/node-nvmrc/install.sh` — delete the block half; add `nvmDir` and
      `projectDir` validation, `awk -v` baking with `grep -qxF` verification, and
      the user-owned `pin/`
- [x] `features/node-nvmrc/post-create.sh` — baked `PROJECT_DIR` (with `${VAR-}`,
      not `${VAR:-}`) + `SHARE_DIR`, the resolved single `cd`, the silent/warn
      miss distinction, the `ln -sfn`, the best-effort `nvm alias default`; every
      existing step unchanged below the `cd`
- [x] `features/node-nvmrc/README.md` — rewrite: what reaches what (now
      "everything"), the `pin/bin` mechanism, precedence, the `.nvmrc`-changed
      → rebuild caveat, `projectDir` (**one pin, not monorepo support**, plus
      the "mount the volume where the project is" line), and a
      **Changed in 0.2.0** note naming the removed option and the new one
- [x] delete `features/node-nvmrc/test/nvm_use_test.sh`
- [x] `features/node-nvmrc/test/install_options_test.sh` — new, offline
- [x] `features/node-nvmrc/test/post_create_test.sh` — new, offline
- [x] `features/node-nvmrc/test/test.sh` — drop the `~/.bashrc` checks, keep the
      bake and root-ownership checks, add `pin/` ownership and the inert-PATH case
- [x] `features/node-nvmrc/test/with_nvmrc.sh` — assert through `bash -c` and
      `sh -c`, not `bash -lic`
- [x] `features/node-nvmrc/test/no_nvmrc.sh` — assert `pin/bin` absent and the
      node Feature's Node still resolves
- [x] `features/node-nvmrc/test/pin_outranks_current.sh` + `scenarios.json` entry
- [x] `features/node-nvmrc/test/project_subdir.sh` + `scenarios.json` entry
- [x] `features/README.md:16` — row text
- [x] `.plans/design/devc-feature-split.md:103` — row text
- [ ] `.plans/PLAN.md` — register

## Validation

Offline (no Docker) — the shapes `bash-config` already uses:

- [x] `bash features/node-nvmrc/test/install_options_test.sh` — all four options
      reach `post-create.sh`; `nvmDir` **and `projectDir`** values containing `"`,
      `` ` ``, `$`, `\` and a newline each **fail** naming the option; a value
      containing `&` and `|` bakes **verbatim** (the `sed`→`awk` fix, which fails
      on the old code); an **empty** `projectDir` bakes as empty and is not
      replaced by a default (the `${VAR-}` vs `${VAR:-}` distinction, which fails
      if written the other way); `pin/` exists and no `~/.bashrc` is created or
      appended to under any option combination; the four-file agreement on the
      `SHARE_DIR` literal, manifest included
- [x] `bash features/node-nvmrc/test/post_create_test.sh` — against a temp
      `SHARE_DIR` and a fake `nvm.sh` that exports `NVM_BIN`: the symlink is
      created and resolves; a **second run** replaces it and does **not** create
      `pin/bin/bin`; no `.nvmrc` → silent exit 0, no symlink; missing nvm → the
      existing stderr warning, exit 0, no symlink; `installOnCreate: false` → no
      symlink; a failing `nvm alias default` warns on stderr and still exits 0;
      a failing `nvm install` is **fatal**
- [x] Same harness, `projectDir` cases: a subdirectory value installs from
      **that** directory (the fake `nvm` logs its cwd, which must be the
      subdirectory) and chowns **that** `node_modules`, not the workspace root's
      — including when **both** exist, which is the case a relocated chown gets
      wrong silently; no `node_modules` anywhere → no chown attempted at all;
      an absolute value is used as-is; a nonexistent `projectDir` warns and exits
      0 without reaching nvm; an explicit `projectDir` with no `.nvmrc` warns and
      exits 0 while the default with no `.nvmrc` stays **silent**; and — the one
      that would otherwise pass by accident — with a `.nvmrc` at the workspace
      root _and_ an explicit `projectDir` that has none, the hook **declines**
      rather than letting `nvm_find_nvmrc` walk up and pin the root's version
- [x] `bash tests/features_test.sh` — the collection walk, `0.2.0` parses
- [x] `deno fmt --check` clean

Needs Docker — `bash features/node-nvmrc/test/run-features-test.sh`:

- [ ] _(default)_ bare `{}` on the no-nvm base image: `post-create.sh` root-owned,
      `pin/` owned by the remote user, the three bakes, **no `~/.bashrc` block**,
      and `node` lookup unaffected by the dangling PATH entry
- [ ] `with_nvmrc` — node Feature installs `lts`, `.nvmrc` pins `20`. The
      assertion moves to the thing that actually matters: `bash -c 'node -v'`,
      `sh -c 'node -v'` and `bash -lc 'node -v'` all report **v20**. This also
      still measures the cwd open question — a hook that ran elsewhere finds no
      `.nvmrc` and the first check fails
- [ ] `no_nvmrc` — `pin/bin` absent, create silent, the node Feature's Node still
      resolves in a non-interactive shell
- [ ] `project_subdir` — `onCreateCommand` writes `packages/app/.nvmrc` pinning
      `20` and **no root `.nvmrc`**, with `"projectDir": "packages/app"`;
      `bash -c 'node -v'` reports v20. The gap against the node Feature's `lts`
      is what makes it observable, same technique as `with_nvmrc`
- [ ] `pin_outranks_current` — **the ordering test, and the only one that can
      isolate it.** After create, repoint nvm's global symlink at the other
      version (`bash -c '. $NVM_DIR/nvm.sh; nvm use --silent lts'`, which
      rewrites `$NVM_DIR/current` per measurement 4), then assert a _fresh_
      `bash -c 'node -v'` still reports the pinned major. Without this, a
      `containerEnv` ordering that landed this entry _behind_ `…/current/bin`
      would pass every other scenario by accident, because `nvm install` happens
      to leave `current` on the pinned version at create time

Not verifiable here (no Docker): everything in the second list. Record it in
`.plans/PLAN.md` on completion the way the other Feature plans do, and note that
`docs/manual-verification.md` needs no change — nothing about publishing moves.

### One correction, found while implementing

The validation list says an **empty `projectDir`** pins the `${VAR-}` vs
`${VAR:-}` distinction and "fails if written the other way". It does not, and
cannot: `projectDir`'s default is the **empty string**, and with an empty default
`${VAR-}` and `${VAR:-}` are behaviorally identical — both yield `""` whether the
variable is unset or set-but-empty. Confirmed by rewriting `install.sh` to
`${PROJECTDIR:-}` and re-running the harness: ALL PASS. (`shell-dirs`, which the
plan cites as precedent, has a **non-empty** default, where the two forms really
do differ — that is the difference the plan carried over without re-checking.)

Both forms are still written as the plan specifies, because the form is what
documents the intent and what survives someone later giving the option a default.
What pins it is two checks rather than one: a **source-form** assertion that
`install.sh` and `post-create.sh` literally use `${…-}`, and a **behavioral**
assertion that an empty value bakes as `PROJECT_DIR=""`. The second is the one
with teeth — it fails the moment a non-empty default appears, which is the only
way the distinction can ever bite. Confirmed by rewriting `install.sh` to
`${PROJECTDIR:-.}`: 3 checks fail.

The other two deliberate-break verifications the plan asks for behaved as
described: reverting the bake to `sed` + `grep -q` fails 3 checks in
`install_options_test.sh` (the `&` and `|` cases), and leaving the `node_modules`
repair at the workspace root while `.nvmrc` moves fails 2 checks in
`post_create_test.sh`'s both-directories-exist case. A fourth, unasked-for break
— weakening the `[ -f .nvmrc ]` guard so nvm could walk up — fails 6.

## Not in this plan

- **Per-directory switching, in any form.** No `cd` hook, no `PROMPT_COMMAND`,
  no exec-time shims, no walking the workspace for secondary `.nvmrc` files. The
  Feature pins **one** version container-wide. `projectDir` chooses _which_
  project is that one pin; it does not make the version vary by directory. A
  monorepo whose packages pin different versions is out of scope and the README
  should say so plainly rather than half-serve it.
- **Parsing `.nvmrc`.** The hook resolves a path and changes directory; nvm reads
  the file. No version string is ever extracted here.
- **A `postStartCommand`** that re-points the symlink on restart. It would make
  "edit `.nvmrc`, restart" work without a rebuild, but it adds a second lifecycle
  hook and a start-time network call whenever the version is absent. The
  rebuild requirement is documented instead. Reconsider once the `containerEnv`
  ordering is measured.
- **Any edit to `devc/default/`.** Both devc copies keep running, `cd` override
  included.
- **zsh or fish support.** With no startup file written, there is nothing left to
  port — the PATH entry reaches them already, which is the point.
- **Retiring `shell-dirs`, or swapping devc onto any published Feature.**
