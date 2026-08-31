# git-container-config (devcontainer Feature)

Re-applies, on every container create, the **user-scope** git settings a devcontainer
needs and cannot keep. It installs neither git nor git-lfs — see
[What this is not](#what-this-is-not).

```jsonc
"features": {
  "ghcr.io/devc-tools/git-container-config:0": {}
}
```

No required options. A bare `{}` applies all four behavior switches this Feature
knows about — LFS filters (plus `--skip-smudge`), `worktree.useRelativePaths`,
`safe.directory` — all of which are pure container scope, plus reads your git
**identity** from a fixed mount point if you've bound one there; see
[Identity](#identity-the-one-thing-a-container-cannot-invent).

> The tag tracks **this Feature's own** version line, not the repo's — see
> [../README.md#versions](../README.md#versions). It is `:0` while this Feature is
> pre-1.0.

## Why every create, not just the first

`~/.gitconfig` is container-local and wiped on every rebuild, while the repo's working
tree and `.git` are host bind mounts. Anything git needs at _user_ scope therefore has
to be re-applied every time the container is (re)created — that is the whole reason
this is a `postCreateCommand` rather than something baked into the image at build time.

## What it does

At **build time** (as root) it places one file and touches no git config at all:
`/usr/local/share/devc-features/git-container-config/post-create.sh`, with the options
baked in — the manifest's `postCreateCommand` takes no arguments, so that is how they
cross over. Running any `git config --global` at build time would write into
`/root/.gitconfig` (build time has no remote user yet), which is exactly the bug class
this Feature exists to fix — so `install.sh` runs none.

At **create time** (as the **remote user**, which is the entire point — see below)
`post-create.sh` runs five steps, in this order:

1. **Identity include, first.** When a file exists at the fixed mount point
   `/usr/local/share/devc-features/git-container-config/identity/gitconfig`:
   `git config --global --replace-all include.path "<path>"`. Included first so every
   setting below overrides anything the identity file carries. Nothing mounted there is
   a silent no-op, not an error — a non-devc consumer mounts nothing, and that path is a
   genuinely absent file rather than a named-but-missing one, so there is nothing to
   warn about.
2. **Warn on the effective identity.** If `git config --get user.email` or `user.name`
   comes back empty, warn on stderr. Warn only — never fail create over it. (No
   `--global` scope flag on the `--get`: that flag does not follow `include.path`, so it
   would report nothing even on a correctly configured setup.)
3. **LFS filters**, when `lfsFilters` is true and `git-lfs` is on `PATH`:
   `git lfs install --force --skip-repo`, plus `--skip-smudge` when `lfsSkipSmudge` is
   true (the default). See [The `--skip-smudge` consequence](#the---skip-smudge-consequence)
   below. No `git-lfs` on `PATH` warns and continues rather than failing create.
4. **`worktree.useRelativePaths true`**, when `worktreeRelativePaths` is true.
5. **`safe.directory`**, via `--replace-all`, when `safeDirectory` is non-empty.

Every warning path still exits `0`. A `postCreateCommand` that fails aborts container
creation, and none of these warnings is worth an unbootable container. The one path
that is genuinely fatal is a `git config` invocation itself failing — this script uses
`set -e` and does not catch that.

### Why the remote user, not root

A `git-lfs` Feature installs the `git-lfs` binary at build time, as root — and if it
also ran `git lfs install`, the filters would land in `/root/.gitconfig`, which the
remote user never sees. This Feature's `postCreateCommand` runs later, at create time,
as the remote user, so `git config --global` writes the remote user's own
`~/.gitconfig` — where the LFS filters, the worktree setting and `safe.directory`
actually need to live for `git` invoked as that user to see them.

| Option                  | Default | Meaning                                                                                                                                                                                 |
| ----------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lfsFilters`            | `true`  | Run `git lfs install --force --skip-repo` for the remote user when `git-lfs` is on `PATH`.                                                                                              |
| `lfsSkipSmudge`         | `true`  | Add `--skip-smudge` to the LFS install above — see below.                                                                                                                               |
| `worktreeRelativePaths` | `true`  | Set `worktree.useRelativePaths`, so a container-side `git worktree add` writes relative links, not absolute paths the host can't resolve.                                               |
| `safeDirectory`         | `"*"`   | Passed to `git config --global --replace-all safe.directory`. Empty disables the setting entirely; any other value is used as-is (scope it to one path instead of `*` if you'd rather). |

Your git identity is not an option — see
[Identity](#identity-the-one-thing-a-container-cannot-invent) for the fixed mount point
it reads from instead.

`safeDirectory`, the one option pasted into a shell assignment, rejects a value
containing a double quote, backtick, dollar sign, backslash or newline — the build
fails loudly naming the option, rather than silently producing a script that does
something else.

## The `--skip-smudge` consequence

With `lfsSkipSmudge` at its default (`true`), a fresh checkout does **not** materialize
LFS objects — the pointer files stay pointer files on disk. Most work in a container
does not need the actual binaries, and checkouts stay fast.

When you do need them:

```sh
git lfs pull                    # everything
git lfs checkout -- path/to/file  # one file, targeted
```

The LFS **clean filter** stays active either way (it is not skipped), so a file you did
materialize this way still reads as unmodified to `git status` — `--skip-smudge` only
affects what a checkout writes, not how `git` compares what is already on disk.

## Identity: the one thing a container cannot invent

`user.name` / `user.email` live on your **host** machine. This Feature cannot read them
(no `initializeCommand` — a Feature can declare none) and cannot mount them in itself
(no Feature can declare a host bind mount — see
[../README.md](../README.md#layout)). Only your own `devcontainer.json` can do both, and
the fixed mount point below is the seam: a directory this Feature only ever reads,
which your own `initializeCommand` + mount produces a file inside of.

### The recipe (non-devc projects paste this)

```jsonc
// extract an allowlist of two keys, host-side, into a file the container may read
"initializeCommand": "sh -c 'f=$HOME/.config/gitid; : > $f; git config --null --get user.name | xargs -r -0 -I{} git config --file $f user.name {}; git config --null --get user.email | xargs -r -0 -I{} git config --file $f user.email {}; exit 0'",
"mounts": [
  "type=bind,source=${localEnv:HOME}/.config/gitid,target=/usr/local/share/devc-features/git-container-config/identity/gitconfig,readonly"
],
"features": {
  "ghcr.io/devc-tools/git-container-config:0": {}
}
```

Three things worth carrying with the recipe, or it is cargo cult:

1. **An allowlist, not the whole `~/.gitconfig`.** Host paths, credential helpers and
   signing config do not work inside a container, and binding the whole file would drag
   them in.
2. **`git config --file`, not `echo`.** A `user.name` containing `#`, `;`, `"` or `\` is
   quoted the way git's own parser expects to read it back — `echo "$name" >> $f` would
   corrupt the file for exactly the names most likely to contain a `#` (an initial) or a
   `"` (a nickname).
3. **`--null` / `xargs -0`, not the plain pipe.** `xargs` treats a quote or a backslash in
   its input as its own quoting syntax by default, so a name like `O'Brien` — a real name,
   not an edge case — silently loses everything from the apostrophe onward (`xargs` prints
   an "unmatched single quote" warning and moves on). `git config --null` emits the value
   NUL-terminated with no shell-style interpretation, and `xargs -0` reads it the same way,
   so the value reaches `git config --file` byte-for-byte regardless of what it contains.
   Verified against `O'Brien`/`"JD"`/`#`, a bare `\`, and a `;`, each read back unchanged.

And it must `exit 0`. A non-zero `initializeCommand` aborts container creation, and
having no git identity is a warning (from this Feature's step 2 above), not a failure.

### devc's own copy, for reference (not to paste)

devc runs the equivalent extraction for you, with its own host-side path — the same
two-key allowlist and the same `git config --file` quoting, implemented with a shell
variable instead of `xargs`, so it has no need of the `--null` fix above:
[`devc-core/default/initialize-command.sh`](../../devc-core/default/initialize-command.sh)
extracts into `~/.config/devc/gitconfig-identity`. That host file binds onto this
Feature's fixed mount point — the host extraction is unchanged from before devc
consumed this Feature; only where the bind lands moved.

## Relationship to devc

**devc no longer carries its own copy of this script.** It used to run an equivalent
`devc-core/default/scripts/git-setup.sh` against its own
`/usr/local/share/devc/gitconfig-identity` path; that script is retired, and devc now
declares this Feature directly in its bundled `devcontainer.json` (see
[`.plans/archived/devc-swap-baseline-features.md`](../../.plans/archived/devc-swap-baseline-features.md)),
with its identity bind retargeted onto this Feature's fixed mount point instead.

Why the identity target moved into this Feature's own namespace rather than staying an
option: a path option whose value only ever has one sensible setting is configuration
the consumer should not have to supply — the same reasoning `agents` applied to its
`claude-seed` mount and `bash-config` applied to `dirs/user`. **Mount onto a known path**
rather than **tell the Feature where you mounted**.

## What this is not

**Not `ghcr.io/devcontainers/features/git`** (which installs git from source) **and not
`git-lfs`** (which installs the `git-lfs` binary). This Feature installs nothing; it
configures a git that is already there. Pair it with either or both — `installsAfter`
orders this Feature behind `git-lfs` so the binary is on `PATH` by the time this
Feature's create-time hook checks for it, though that check is written to warn rather
than assume, so the order only affects tidiness, not correctness.

## Tests

No Docker needed:

```sh
bash features/git-container-config/test/git_config_test.sh
```

Runs the real, installed `post-create.sh` against a temp `HOME` with
`GIT_CONFIG_GLOBAL` pointed into it, and a temp `SHARE_DIR` standing in for
`/usr/local/share/devc-features/git-container-config/` — no container, no root.
Covers: the identity include set when a file is placed at the fixed
`identity/gitconfig` path and skipped silently when nothing is there;
`worktree.useRelativePaths` and `safe.directory` present with the defaults;
`safeDirectory: ""` omitting the setting entirely; a second run being idempotent (no
duplicate `include.path`, no duplicate `safe.directory`); the missing-identity warning
landing on **stderr** with the exit code still `0`; and `git-lfs` absent from `PATH`
warning and exiting `0` while the other settings still apply.

Needs Docker and a network:

```sh
bash features/git-container-config/test/run-features-test.sh
```

The default scenario is the bare `{}` case — no options, no mounts — asserting the
three container-scope settings land in the **remote user's** `~/.gitconfig`, not
`/root/`'s, and that create succeeds with only a stderr warning about the missing
identity. `test/scenarios.json` adds a scenario with the git-lfs Feature also enabled
(`filter.lfs.clean` set for the remote user, `filter.lfs.smudge` carrying `--skip`) and
one with a mounted identity file (the include resolves, and a container-mandated key
the identity file also sets is won by the container).

## Publishing

This Feature is **not** on
[`features/PUBLISH_ALLOWLIST.txt`](../PUBLISH_ALLOWLIST.txt) — it does not publish to
ghcr.io yet. See [../README.md#the-publish-allowlist](../README.md#the-publish-allowlist)
for what that gate is and isn't.
