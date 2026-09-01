# git-container-config (devcontainer Feature)

Re-applies, on every container create, the **user-scope** git settings a devcontainer needs
and cannot keep — LFS filters, `worktree.useRelativePaths`, `safe.directory`, and your
identity.

```jsonc
"features": {
  "ghcr.io/devc-tools/features/git-container-config:0": {}
}
```

No required options. A bare `{}` applies all three container-scope settings, and reads your
git **identity** from a fixed mount point if you have bound one there — see
[Identity](#identity-the-one-thing-a-container-cannot-invent).

It installs neither git nor git-lfs — see [What this is not](#what-this-is-not).

> The tag tracks **this Feature's own** version line, not the devc-tools release. It is
> `:0` while this Feature is pre-1.0.

## Why every create, not just the first

`~/.gitconfig` is container-local and wiped on every rebuild, while the repo's working tree
and `.git` are host bind mounts. Anything git needs at *user* scope therefore has to be
re-applied every time the container is (re)created — that is why this is a
`postCreateCommand` rather than something baked into the image.

It runs as the **remote user**, which is the whole point: `git config --global` writes that
user's own `~/.gitconfig`, where the settings actually need to live. A `git-lfs` Feature
installs its binary at build time as root, and if it also ran `git lfs install` the filters
would land in `/root/.gitconfig`, which you never see.

## Options

| Option                  | Default | Meaning                                                                                                                                                                                 |
| ----------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lfsFilters`            | `true`  | Run `git lfs install --force --skip-repo` for the remote user when `git-lfs` is on `PATH`.                                                                                              |
| `lfsSkipSmudge`         | `true`  | Add `--skip-smudge` to the LFS install — see [below](#the---skip-smudge-consequence).                                                                                                   |
| `worktreeRelativePaths` | `true`  | Set `worktree.useRelativePaths`, so a container-side `git worktree add` writes relative links, not absolute paths the host can't resolve.                                               |
| `safeDirectory`         | `"*"`   | Passed to `git config --global --replace-all safe.directory`. Empty disables the setting entirely; any other value is used as-is (scope it to one path instead of `*` if you'd rather). |

Your git identity is not an option — see
[Identity](#identity-the-one-thing-a-container-cannot-invent) for the fixed mount point it
reads from instead.

`safeDirectory` rejects a value containing a double quote, backtick, dollar sign, backslash
or newline — the build fails naming the option, rather than silently producing a script that
does something else.

## What it does

At create time, in this order:

1. **Identity include, first.** When a file exists at the fixed mount point
   `/usr/local/share/devc-features/git-container-config/identity/gitconfig`, it is added as
   `include.path`. First on purpose, so every setting below overrides anything the identity
   file carries — a container's own requirements must not be overridable by whatever
   happens to be in a mounted file. Nothing mounted there is a silent no-op, not an error.
2. **A warning on the effective identity.** If `user.email` or `user.name` comes back empty,
   it warns on stderr. Warn only — never fail create over it.
3. **LFS filters**, when `lfsFilters` is true and `git-lfs` is on `PATH`. No `git-lfs`
   warns and continues rather than failing create.
4. **`worktree.useRelativePaths`**, when `worktreeRelativePaths` is true. Worktree links
   must stay relative: absolute paths differ between host (`/Users/…`) and container
   (`/workspaces/…`), and a container-side `git worktree add` would otherwise write paths
   the host cannot resolve, corrupting a `.git` both sides share.
5. **`safe.directory`**, when `safeDirectory` is non-empty. The workspace binds in and can
   present a different owner than the container user, which makes git refuse to operate
   with "detected dubious ownership".

Every warning path still exits `0`. A failing `postCreateCommand` aborts container creation,
and none of these warnings is worth an unbootable container.

## The `--skip-smudge` consequence

With `lfsSkipSmudge` at its default (`true`), a fresh checkout does **not** materialize LFS
objects — the pointer files stay pointer files on disk. Most work in a container does not
need the actual binaries, and checkouts stay fast.

When you do need them:

```sh
git lfs pull                      # everything
git lfs checkout -- path/to/file  # one file, targeted
```

The LFS **clean filter** stays active either way, so a file you did materialize still reads
as unmodified to `git status` — `--skip-smudge` only affects what a checkout writes, not how
git compares what is already on disk.

## Identity: the one thing a container cannot invent

`user.name` / `user.email` live on your **host**. This Feature cannot read them (a Feature
cannot declare an `initializeCommand`) and cannot mount them in itself (a Feature cannot
declare a host bind mount). Only your own `devcontainer.json` can do both, and the fixed
mount point is the seam: a directory this Feature only ever reads, which your own
`initializeCommand` + mount produces a file inside of.

```jsonc
// extract an allowlist of two keys, host-side, into a file the container may read
"initializeCommand": "sh -c 'f=$HOME/.config/gitid; : > $f; git config --null --get user.name | xargs -r -0 -I{} git config --file $f user.name {}; git config --null --get user.email | xargs -r -0 -I{} git config --file $f user.email {}; exit 0'",
"mounts": [
  "type=bind,source=${localEnv:HOME}/.config/gitid,target=/usr/local/share/devc-features/git-container-config/identity/gitconfig,readonly"
],
"features": {
  "ghcr.io/devc-tools/features/git-container-config:0": {}
}
```

Three things worth carrying with the recipe, or it is cargo cult:

1. **An allowlist, not the whole `~/.gitconfig`.** Host paths, credential helpers and
   signing config do not work inside a container, and binding the whole file would drag them
   in.
2. **`git config --file`, not `echo`.** A `user.name` containing `#`, `;`, `"` or `\` is
   quoted the way git's own parser expects to read it back — `echo "$name" >> $f` would
   corrupt the file for exactly the names most likely to contain a `#` (an initial) or a `"`
   (a nickname).
3. **`--null` / `xargs -0`, not the plain pipe.** `xargs` treats a quote or a backslash in
   its input as its own quoting syntax by default, so a name like `O'Brien` — a real name,
   not an edge case — silently loses everything from the apostrophe onward. `git config
   --null` emits the value NUL-terminated with no shell-style interpretation, and `xargs -0`
   reads it the same way, so the value arrives byte-for-byte regardless of what it contains.

And it must `exit 0`. A non-zero `initializeCommand` aborts container creation, and having
no git identity is a warning (step 2 above), not a failure.

**If you use devc, this is already done for you.**
[`devc-core/default/initialize-command.sh`](../../devc-core/default/initialize-command.sh)
runs the equivalent extraction into `~/.config/devc/gitconfig-identity`, and devc's bundled
config binds that onto this Feature's mount point.

## What this is not

**Not `ghcr.io/devcontainers/features/git`** (which installs git) **and not `git-lfs`**
(which installs the `git-lfs` binary). This Feature installs nothing; it configures a git
that is already there. Pair it with either or both — `installsAfter` orders this Feature
behind `git-lfs` so the binary is on `PATH` by the time this Feature checks for it, though
that check warns rather than assumes, so the order only affects tidiness.
