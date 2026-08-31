# `git-container-config` Feature — the git settings a container needs each create

## Goal

Publish `ghcr.io/devc-tools/git-container-config`: re-apply, on every
container create, the **user-scope** git settings a devcontainer needs and cannot
keep — LFS filters for the remote user, `worktree.useRelativePaths`,
`safe.directory`, and an `include.path` to an identity file if one has been
mounted in.

**This one splits, and the split is the sharpest of the four — but `{}` still
does the majority of the job.** With no options, no mounts and no devc, the
Feature applies LFS filters, `worktree.useRelativePaths` and `safe.directory`:
three of the four settings in `git-setup.sh`, and the three that are pure
container scope.

The fourth is your **identity**, and it is the one thing in this whole exercise
that genuinely cannot come from a container: `user.name` / `user.email` live on
your host machine. A Feature can neither read them nor mount them
(`devc-feature-split`). But the **consumer's `devcontainer.json`** can do both —
`initializeCommand` extracts, a read-only bind delivers — and this plan's README
carries that recipe verbatim. devc runs the identical recipe for you; a non-devc
project pastes it. The Feature's role either way is one `include.path`, told
where the file landed.

**Copy, don't move.** `devc/default/scripts/git-setup.sh` keeps running.

## Existing touchpoints

- `devc/default/scripts/git-setup.sh` — source material, all four settings and
  the reasoning comments that must survive the copy.
- `devc/default/initialize-command.sh` lines 19–33 — the host-side identity
  extraction and its allowlist rationale. Cited, not edited.
- `devc/default/devcontainer.json` — the `gitconfig-identity` read-only bind.
  Cited, not edited.
- `devc/README.md` "Git setup" — the documented behavior.

## Contracts

### `features/git-container-config/devcontainer-feature.json`

```jsonc
{
  "id": "git-container-config",
  // Its own version, independent of the repo tag and of the other Features —
  // see .plans/archived/feature-independent-versions.md.
  "version": "0.1.0",
  "name": "Git container config",
  "options": {
    "identityIncludePath": { "type": "string", "default": "" },
    "lfsFilters": { "type": "boolean", "default": true },
    "lfsSkipSmudge": { "type": "boolean", "default": true },
    "worktreeRelativePaths": { "type": "boolean", "default": true },
    "safeDirectory": { "type": "string", "default": "*" }
  },
  "installsAfter": ["ghcr.io/devcontainers/features/git-lfs"],
  "postCreateCommand": "bash /usr/local/share/devc-features/git-container-config/post-create.sh"
}
```

- `install.sh` (root, build time) writes the hook script with the option values
  baked in, `0755` root-owned. The hook itself runs **as the remote user** — which
  is the entire point, since `git config --global` writes `$HOME/.gitconfig` and
  the whole bug class here is settings landing in `/root/.gitconfig`.
- `safeDirectory: ""` disables that setting; any other value is passed through.
  A string rather than a boolean so a consumer can scope it to a path instead of
  `*`.
- `installsAfter` the git-lfs Feature so `git-lfs` is on `PATH` if the consumer
  uses it — though the check below is runtime, so order only affects tidiness.

### `/usr/local/share/devc-features/git-container-config/post-create.sh`

The order is a correctness requirement, not a style choice — copy it from
`git-setup.sh` and keep the comments that say why:

1. **Identity include first.** When `identityIncludePath` is non-empty and the
   file exists: `git config --global --replace-all include.path "<path>"`.
   Included first so the container-mandated settings below win over anything the
   identity file carries. When the option is empty, skip silently — a non-devc
   consumer has no such file and this is not an error.
2. **Warn on the effective identity.** If `git config --get user.email` or
   `user.name` is empty, warn on stderr. No `--global` scope flag: `--global
   --get` does not follow `include.path` and would report nothing even on a
   correct setup. Warn only — never fail create over it.
3. **LFS filters** when `lfsFilters` and `command -v git-lfs`:
   `git lfs install --force --skip-repo [--skip-smudge]`. Keep all three flag
   rationales verbatim from `git-setup.sh` (`--skip-repo`: the repo config is
   host-shared and rewriting it churns host state; `--force`: own the filter
   values; `--skip-smudge`: don't materialize LFS objects on checkout). No
   `git-lfs` on `PATH` → warn and continue.
4. **`worktree.useRelativePaths true`** when enabled.
5. **`safe.directory`** via `--replace-all` when the option is non-empty.

The script must exit 0 in every path except a genuine `git config` failure. A
`postCreateCommand` that fails aborts container creation, and none of these
warnings is worth an unbootable container.

### Standalone — what a non-devc project pastes

`"git-container-config": {}` needs nothing else and is a complete, useful
install. For identity, the README carries devc's own approach with the devc
paths removed — the consumer owns all of it:

```jsonc
// extract an allowlist of two keys, host-side, into a file the container may read
"initializeCommand": "sh -c 'f=$HOME/.config/gitid; : > $f; git config --get user.name | xargs -r -I{} git config --file $f user.name {}; git config --get user.email | xargs -r -I{} git config --file $f user.email {}; exit 0'",
"mounts": [
  "type=bind,source=${localEnv:HOME}/.config/gitid,target=/usr/local/share/gitid,readonly"
],
"features": {
  "ghcr.io/devc-tools/git-container-config:0": {
    "identityIncludePath": "/usr/local/share/gitid"
  }
}
```

Carry across the two reasons `initialize-command.sh` gives, or the recipe is
cargo cult: (1) an **allowlist**, not the whole `~/.gitconfig`, because host
paths, credential helpers and signing config do not work in a container; (2)
`git config --file` rather than `echo`, so a value containing `#`, `;`, `"` or
`\` is quoted the way git's parser expects to read it back. And it must
`exit 0` — a non-zero `initializeCommand` aborts container creation, and having
no git identity is a warning, not a failure.

The devc equivalent, for reference rather than for copying, is
`devc/default/initialize-command.sh` plus the `gitconfig-identity` mount.

## Concept boundaries

- **`git-container-config` (Feature) vs `devc/default/scripts/git-setup.sh`
  (devc's copy).** Same behavior, two files, both live during the interim. The
  Feature README and the script header must each say which is which; an agent
  editing "the git setup script" otherwise has a coin flip.
- **Identity vs configuration.** The line this plan draws: _who you are_ comes
  from the host and stays devc's; _how git must behave in a container_ is the
  Feature's. `identityIncludePath` is the seam, and it is deliberately a dumb
  path option — the Feature never reads, parses, or validates the file's
  contents.
- **`include.path` vs `--replace-all`.** Both appear in one script.
  `include.path` is replaced wholesale each create (idempotence), and the
  container-mandated keys are set after it so include order decides precedence.
- **Not `ghcr.io/devcontainers/features/git`** (which installs git from source)
  nor `git-lfs` (which installs the binary). This Feature installs nothing; it
  configures. Say so in the first line of the README.

## Checklist

- [x] `features/git-container-config/devcontainer-feature.json` — id/version/name,
      five options, `installsAfter`, `postCreateCommand`
- [x] `features/git-container-config/install.sh` — hook placement + option baking
- [x] `features/git-container-config/post-create.sh` — the five steps in order,
      rationale comments carried over, exit 0 on every warning path
- [x] `features/git-container-config/README.md` — what it does _not_ install, the
      identity seam (with the exact devc mount + `initialize-command.sh` recipe a
      non-devc consumer can copy), the `--skip-smudge` consequence (`git lfs pull`)
- [x] `features/git-container-config/test/test.sh` — scenario
- [x] `features/git-container-config/test/run-features-test.sh` — wrapper
- [x] `features/git-container-config/test/git_config_test.sh` — offline harness
- [x] `features/README.md` — row
- [x] `.plans/PLAN.md` — register (already listed under Pending; moved to Completed
      as part of archiving, per the standard plan-orchestrating flow)

## Validation

- [x] `bash features/git-container-config/test/git_config_test.sh` — runs the hook
      against a temp `HOME` with `GIT_CONFIG_GLOBAL` pointed into it (no
      container, no root): identity include set when the file exists and skipped
      when the option is empty; `worktree.useRelativePaths` and `safe.directory`
      present; `safeDirectory: ""` omits it; a second run is idempotent (no
      duplicate `include.path`, no duplicate `safe.directory`); the missing-identity
      warning goes to **stderr** and the exit code is still 0 — 40 checks, ALL PASS
- [x] Same harness with `git-lfs` absent from `PATH`: warns, exits 0, other
      settings still applied — case 1 of `git_config_test.sh`
- [ ] (needs Docker) `bash features/git-container-config/test/run-features-test.sh`
      — settings land in the **remote user's** `~/.gitconfig`, not `/root/`;
      with the git-lfs Feature also enabled, `git config --get filter.lfs.clean`
      is set for that user and `filter.lfs.smudge` carries `--skip`
- [ ] (needs Docker) A scenario with a mounted identity file: `git config --get
      user.email` resolves through the include, and a container-mandated key the
      identity file also sets is won by the container
- [ ] (needs Docker) **the bare `{}` scenario** — no options, no mounts: the
      three container-scope settings are applied and create succeeds with only a
      stderr warning about the missing identity
- [x] The README's `initializeCommand` recipe, run on this machine against a
      throwaway `$HOME`: produces a file git can read back, including for a
      `user.name` containing `#` and `"`, and exits 0 when no identity is set.
      **Found and fixed a real bug while doing this**: the recipe as first
      written piped `git config --get user.name` into `xargs -I{}`, and `xargs`
      applies its own quote parsing by default — a name containing an apostrophe
      (`O'Brien`) or a `"` silently lost everything from that character onward
      (`xargs: unmatched single quote`), while `exit 0` masked the failure. Fixed
      to `git config --null --get ... | xargs -r -0 -I{} ...`, which passes the
      value through with no shell-style interpretation; re-verified against
      `Jane "JD" O'Brien #1`, a bare `\`, and a `;`, each read back
      byte-for-byte, plus the plain and no-identity cases, all exit 0.
- [x] `deno fmt --check` clean

## Not in this plan

- Any edit to `devc/default/` — `git-setup.sh`, `initialize-command.sh`, and the
  identity mount all stay exactly as they are.
- Credential helpers, commit signing, or anything else from the host
  `~/.gitconfig`. The allowlist stays two keys; the reasons are in
  `initialize-command.sh` and have not changed.
- A host-side identity extractor shipped by the Feature. There is no hook to run
  it from. If a non-devc consumer wants one, the README gives them the recipe to
  wire into their own `initializeCommand`.
