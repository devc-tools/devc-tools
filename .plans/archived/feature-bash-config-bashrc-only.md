# `bash-config` 0.2.0 — `~/.bashrc` only, the login profile dropped entirely

## Goal

Cut `bash-config` down to the one audience it actually serves: an interactive
terminal. Delete the login-profile half — `profile_*.sh`, the
`~/.bash_profile`/`~/.bash_login`/`~/.profile` chain-detection, and
`_bash_config_kind` — rather than keep maintaining a second, rarely-reached
pathway.

The Feature becomes explicitly **cosmetic-scope only**: prompt, aliases,
functions, anything a human looks at in a shell. Anything that must reach a
script, a tool, or an agent deterministically was already out of scope — the
README already tells consumers to use `containerEnv`/`remoteEnv` for that — so
this plan removes machinery that was never the thing carrying that weight, not
a capability anyone depends on.

**Not a split, and not new scope** — a narrowing of an unpublished Feature.
`bash-config` is not on `features/PUBLISH_ALLOWLIST` (confirmed: absent from
the file, only `devc-bridge` and `node-nvmrc` are listed), so there is no
external consumer to break and no compatibility obligation. `version` still
moves to `0.2.0` in the commit that changes it, per this repo's own convention
for a Feature whose observable shape changed — not because anything is
"published," but so the manifest's version history reflects the change
truthfully.

**Copy, don't move — n/a here.** Unlike the `feature-*` split plans, this one
edits `bash-config` in place; there is no sibling Feature or devc baseline
copy of this logic to leave alone.

## Why — what the login-profile half was actually buying

1. **Agent/tool shells don't reach it either, so it wasn't the fallback for
   "non-interactive."** Measured live in this container: the coding-agent tool
   shell here invokes `/usr/bin/zsh -c '...'` — no `-i`, no `-l`, and not even
   bash. Per `bash-config`'s own measured table (`README.md`, "How far this
   actually reaches"), a plain `bash -c` gets **neither** `bashrc_*.sh` nor
   `profile_*.sh` — the login-profile pathway was never what an agent or a
   scripted tool invocation would hit. Nothing that mattered for driving tool
   behavior was ever safely reachable through `profile_*.sh`; that was already
   the README's stated ceiling, not a new finding.
2. **Real terminals in a devcontainer are plain interactive, not login.** VS
   Code's integrated terminal (and most devcontainer terminal launches) starts
   `bash` without `-l`. `bashrc_*.sh` is what a human actually sees;
   `profile_*.sh` fires only for an explicit `bash -l` or a true login-style
   session, which is the edge case in this environment, not the common path.
3. **The login-profile half carried the one genuinely hazardous choice in this
   Feature.** `install.sh`'s own comments call the
   `~/.bash_profile`/`~/.bash_login`/`~/.profile` chain-detection out by name:
   bash reads only the _first_ of the three, so inventing the wrong one shadows
   `~/.profile` and, on a Debian-derived image, takes `~/.bashrc` down with it
   (measured in the original `feature-bash-config` plan). Removing the second
   block removes that hazard outright rather than continuing to guard it.
4. **`_bash_config_kind` existed only to pick between two globs over the same
   two directories.** With one kind, the appended block collapses from
   `_bash_config_kind=bashrc` + `. init.sh` (two lines) to `. init.sh` alone,
   and the "misuse" no-op branch (`_bash_config_kind` unset or misspelled)
   disappears because there is no longer a variable to misuse.
5. **The once-per-shell dedup guard's reason for keying on `<kind>@<path>`
   disappears with the kind, but the guard itself does not.** Its remaining
   job — not double-sourcing `dirs/user` and `dirs/project` if they ever
   resolve to the same physical directory, and not re-running the directory
   scan if something manually re-sources `~/.bashrc` mid-session — has nothing
   to do with there being two kinds. The key simplifies to the resolved path
   alone.

## Existing touchpoints

- `features/bash-config/init.sh` — drop `_bash_config_kind`, the misuse
  no-op guard, and the `${_bash_config_kind}_` glob prefix; source
  `bashrc_*.sh` unconditionally. Simplify the dedup guard's key. No longer
  needs to run correctly under `dash` — it is sourced only from `~/.bashrc`,
  which only bash reads — though there is no requirement to _introduce_
  bashisms; POSIX `sh` style may stay if it costs nothing.
- `features/bash-config/install.sh` — delete `LOGIN_PROFILE` resolution (the
  `.bash_profile`/`.bash_login`/`.profile` loop) and the second
  `append_block` call; `append_block` drops its `<kind>` parameter and the
  block it writes drops the `_bash_config_kind=%s` line.
- `features/bash-config/post-create.sh` — **untouched.** It has no notion of
  "kind"; the project symlink and `env.sh` are unaffected.
- `features/bash-config/devcontainer-feature.json` — `version` → `0.2.0`,
  `description` no longer mentions the login profile or `profile_*.sh`.
- `features/bash-config/README.md` — the sections built around the two
  audiences: "Which file sources which" (collapses to one row), "How far this
  actually reaches" (drop the `bash -lc`/`bash -ilc` rows), "`profile_*.sh`
  must be POSIX `sh`" (deleted section), the "What it does" walkthrough of the
  login-profile chain, the static-block example (now one line inside the
  markers), and the Tests section's mention of the dash pass and the
  `login_shell` scenario.
- `features/bash-config/test/init_test.sh` — drop every `profile`-kind case;
  drop the dash re-run (case 10) unless kept as a no-cost sanity check; keep
  everything about ordering, the symlink, the dedup guard (simplified), the
  "nothing left behind" cases.
- `features/bash-config/test/install_options_test.sh` — drop case 4 (the
  `.bash_profile`/`.bash_login`/`.profile` chain) and every profile-kind
  assertion in cases 2, 6, and 9; keep the `projectDir` validation cases (7,
  8) and the fixed-path agreement case (3) unchanged.
- `features/bash-config/test/post_create_test.sh` — drop the `profile_10.sh`
  fixture and the login-shell probes in cases 1 and 9 (or repoint them to
  assert a login shell now gets _nothing_ from this Feature, if worth keeping
  as an explicit ceiling check).
- `features/bash-config/test/login_shell.sh` — **deleted**, and its entry
  removed from `test/scenarios.json`.
- `features/bash-config/test/both_dirs.sh`, `bare_no_env.sh`, `live_edit.sh`,
  `run-features-test.sh` — no profile references found; unaffected.
- `features/README.md:14` — the collection-table row's description.
- `.plans/PLAN.md` — register this plan in the Pending list, in the same
  style as `feature-node-nvmrc-container-wide`; the existing `Completed` row
  for `feature-bash-config` and the archived plan itself stay as written —
  they are the historical record of what `0.1.0` did, not current behavior.

## Contracts

### `features/bash-config/devcontainer-feature.json`

```jsonc
{
  "id": "bash-config",
  "version": "0.2.0",
  "name": "Bash config directories",
  "description": "Sources every bashrc_*.sh from ~/.bashrc out of two fixed container directories: dirs/user (empty, yours to mount or fill) and dirs/project (a symlink a create-time hook points at your workspace). The block appended to ~/.bashrc is a static one line naming a fixed path, so nothing ever rewrites it; both directories are read fresh by every shell, so a file added after the build applies to the next shell with no rebuild.",
  "documentationURL": "https://github.com/devc-tools/devc-tools/tree/main/features/bash-config",
  "options": {
    "projectDir": {
      "type": "string",
      "default": ".devcontainer/shell",
      "description": "Workspace-relative directory that dirs/project is linked to, resolved at create time. An absolute value is linked as-is. Empty creates no symlink at all."
    }
  },
  "postCreateCommand": "bash /usr/local/share/devc-features/bash-config/post-create.sh"
}
```

`options` and `postCreateCommand` are unchanged from `0.1.0` — `projectDir`
and the create-time hook have nothing to do with which startup file gets a
block.

### The block appended to `~/.bashrc`

```sh
# >>> bash-config >>>
. /usr/local/share/devc-features/bash-config/init.sh
# <<< bash-config <<<
```

One line inside the markers, not two — there is no kind to assign. Still
marker-guarded against a double-append on rebuild, exactly as today.
**Nothing is appended to the login profile.** If a target image already
carries a `bash-config` block in its login profile from a `0.1.x` install
(pre-`PUBLISH_ALLOWLIST`, so only ever a locally-tested image), this Feature
does not remove it — cleanup of a stale block on rebuild is out of scope; see
"Not in this plan."

### `init.sh` — the sourcing logic

Contract, replacing the `_bash_config_kind`-gated version:

- Sources `dirs/env.sh` if readable, before anything else — unchanged.
- For `dirs/user` then `dirs/project`, in that order: skip unless `[ -d ]`,
  then source every `"<dir>/bashrc_"*.sh` that passes `[ -f ]`. No kind
  variable is read or required.
- The once-per-shell dedup guard keys on the **resolved path alone** now
  (`$_BASH_CONFIG_DONE` holds a colon-joined list of real paths, not
  `kind@path` pairs). It still exists to protect against `dirs/user` and
  `dirs/project` resolving to the same physical directory, and against a
  manual `source ~/.bashrc` re-running the scan mid-session.
- Leaves no helper function, no loop variable, and `$?` at 0 — unchanged.
- No "misuse" no-op branch: there is nothing left to misuse, so the sourcing
  always runs when `init.sh` is sourced at all.

### `install.sh` — build time, root

- `append_block` takes one argument (`<file>`), not two; it writes the
  one-line block above.
- Exactly one call: `append_block "$USER_HOME/.bashrc"`.
- No `LOGIN_PROFILE` resolution, no `.bash_profile`/`.bash_login`/`.profile`
  chain, no `~/.bash_profile`-must-never-be-invented guard — the hazard is
  gone with the code that created it.
- Everything about `dirs/user`, `config.sh`, the `projectDir` validation, and
  the `chown` of `dirs/` is unchanged.

## Concept boundaries

- **`bashrc_*.sh` vs the now-dead `profile_*.sh` prefix.** A file named
  `profile_10.sh` dropped in either directory is no longer sourced by
  anything — it is just an ignored file, the same as a stray `.txt` or
  `README.md` today. Do not reintroduce a prefix-routing branch to "handle"
  it; the fix for a consumer who has one is to rename it.
- **`_bash_config_kind` is gone, not renamed or defaulted.** A reader who
  finds it in git history, in the archived `feature-bash-config` plan, or in
  the `0.1.0` `Completed` entry in `.plans/PLAN.md` should not reintroduce it
  here — those documents describe what `0.1.0` did, not current behavior.
- **The dedup guard's key changes shape** (`kind@path` → `path`) but its
  purpose — same physical directory reached under two names counts once —
  does not. Do not read its removal of `kind` as the guard itself being
  removed.
- **This is unrelated to `shell-dirs`.** `shell-dirs` never had a
  login-profile half to begin with; nothing about its relationship to
  `bash-config` (documented in `bash-config/README.md#relationship-to-shell-dirs`)
  changes here.

## Checklist

- [x] `features/bash-config/devcontainer-feature.json` — `0.2.0`, description
      rewritten
- [x] `features/bash-config/init.sh` — kind removed, one glob, guard keyed on
      path alone
- [x] `features/bash-config/install.sh` — `LOGIN_PROFILE` chain and the
      second `append_block` call deleted; `append_block` takes one arg
- [x] `features/bash-config/README.md` — rewritten: one audience, one table
      row, the static block shown as one line, the dash/POSIX requirement on
      `init.sh` dropped, Tests section updated
- [x] `features/bash-config/test/init_test.sh` — profile-kind cases removed,
      dash pass removed, guard test updated to the new key shape
- [x] `features/bash-config/test/install_options_test.sh` — the
      `.bash_profile`/`.bash_login`/`.profile` chain case deleted, profile
      assertions removed elsewhere
- [x] `features/bash-config/test/post_create_test.sh` — profile fixture and
      login-shell probes removed / repointed to assert "nothing"
- [x] delete `features/bash-config/test/login_shell.sh`; remove its entry
      from `features/bash-config/test/scenarios.json`
- [x] `features/bash-config/test/test.sh` (the default Docker scenario) —
      profile assertions trimmed the same way (found while implementing;
      not listed above, but the same class of change)
- [x] `features/README.md:14` and the `bash-config`/`shell-dirs` comparison
      paragraph — row text and the "two-line block ... and in the login
      profile" phrasing
- [x] `.plans/PLAN.md` — register this plan under Pending

## Validation

Offline (no Docker) — all run and passing:

- [x] `bash features/bash-config/test/init_test.sh` — only `bashrc_*.sh` is
      ever sourced; `profile_*.sh` files are ignored like any other
      non-matching file; ordering, symlink liveness, the guard (new key
      shape), and the "nothing left behind" cases all still pass
- [x] `bash features/bash-config/test/install_options_test.sh` — exactly one
      block, in `~/.bashrc` only; no `.profile`/`.bash_profile`/`.bash_login`
      is ever created or touched; `projectDir` validation unchanged
- [x] `bash features/bash-config/test/post_create_test.sh` — unaffected
      (`post-create.sh` did not change) aside from the fixture/assertion
      trims above
- [x] `bash tests/features_test.sh` — collection walk, `0.2.0` parses
- [x] `deno fmt --check` clean

Needs Docker — `bash features/bash-config/test/run-features-test.sh`:

- [ ] _(default)_, `bare_no_env`, `both_dirs`, `live_edit` — all still pass
      with no profile-related assertions. **Not run in this session — no
      Docker available.** `test.sh` (the default scenario) was updated and
      read back carefully, including the base-image-ships-`~/.profile`
      correction below, but is unverified against a real container.
- [x] `login_shell` scenario file removed; **no replacement scenario is
      added** — the ceiling ("a login shell gets nothing from this Feature")
      is asserted offline in `install_options_test.sh`/`post_create_test.sh`

### One correction made while implementing, worth recording

The default Docker scenario's base image **ships `~/.profile`** (that is
what the original plan's `feature-bash-config` measurements relied on — the
login-profile block used to land there). A first draft of `test.sh` asserted
`test ! -e "$HOME/.profile"`, which would have failed against the real image
for a reason unrelated to this change. Fixed to assert the file has no
`bash-config` block, rather than that it doesn't exist. Noted here because
this is exactly the kind of thing offline harnesses can't catch — nothing
in this repo runs `run-features-test.sh` in this environment, so this file
is unverified end to end.
instead of needing its own container scenario

## Not in this plan

- **Cleaning up a stale login-profile block on an already-built image.** This
  Feature has never been published, so the only images carrying a `0.1.x`
  profile block are locally built test images; a rebuild from a fresh base
  image has none to begin with. If that ever matters, it is a separate,
  explicit migration step, not a silent removal grafted onto this change.
- **Any `BASH_ENV`-based mechanism to reach `bash -c`.** Raised only to note
  it was considered and rejected: it would reopen exactly the "reaches a
  non-interactive shell sometimes, depending how it's invoked" surface this
  plan exists to get rid of, and README already directs behavior-critical
  needs to `containerEnv`/`remoteEnv` instead.
- **zsh or fish support.** Unchanged — still bash only, still deliberately
  unwritten for other shells.
- **Any edit to `shell-dirs` or devc's baseline.** Neither references the
  login-profile half of `bash-config`; nothing here touches them.
