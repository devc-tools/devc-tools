# `git-container-config` 0.2.0 — `identityIncludePath` becomes a fixed mount point

## Goal

Remove the `identityIncludePath` option. The identity file arrives at one fixed
container path the consumer bind-mounts onto, instead of at a path the consumer
both names _and_ mounts.

This is [`agents` 0.2.0](PLAN.md)'s change applied to the one Feature that still
has the shape it removed, and for the same reason: a path option whose value
only ever has one sensible setting is configuration the consumer should not have
to supply. It follows `bash-config`'s `dirs/user` and `agents`' `claude-seed` —
**mount onto a known path** rather than **tell the Feature where you mounted**.

After this, `git-container-config`'s remaining four options are all genuine
behavior switches (`lfsFilters`, `lfsSkipSmudge`, `worktreeRelativePaths`,
`safeDirectory`), none of which name a path.

## Why now, and not after the devc swap

**devc does not consume this Feature yet.** `devc-core/default/devcontainer.json`
declares no `git-container-config` entry; `devc-core/default/scripts/git-setup.sh`
still does the work. Verified — no reference in `devc-core/` or `devc/`.

That makes this breaking change **free right now** and expensive later:

- Today, the only consumers are external ones this repo does not know about,
  and the Feature is young enough that there may be none.
- [`devc-swap-baseline-features`](devc-swap-baseline-features.md) declares it in
  devc's bundled config at the floating `:0` tag, and devc ships as a **compiled
  binary with that config baked in**. From then on, publishing a breaking change
  reaches every already-released devc binary on its users' next container
  create, because `:0` floats forward. Ordering commits cannot fix that; it
  needs a coordinated release or a deprecation window.

So: **this plan lands and publishes before the swap plan**, which then declares
the final option surface once. See that plan's own Contracts, which currently
pass `identityIncludePath` and must be updated by this one.

## Existing touchpoints

- `features/git-container-config/devcontainer-feature.json` — `identityIncludePath`
  removed from `options`; `version` → `0.2.0`. The `description` mentions "an
  include.path to an identity file if one has been mounted in", which stays true
  and gets more specific.
- `features/git-container-config/install.sh` — `IDENTITY_INCLUDE_PATH_OPT` and
  its `check_opt identityIncludePath` call deleted, along with one `bake()` call.
  Gains a `mkdir -p "$SHARE_DIR/identity"`. **`bake()` itself stays** — four real
  options still cross into `post-create.sh`, and a Feature's options reach only
  `install.sh`, at build time. `check_opt` stays for `safeDirectory`.
- `features/git-container-config/post-create.sh` — the baked
  `IDENTITY_INCLUDE_PATH="${IDENTITY_INCLUDE_PATH-}"` line becomes a fixed
  assignment; step 1's `if [ -n … ]` / `if [ -f … ]` pair collapses (see
  Contracts). The `warn()` helper, the exit-0 discipline, and the
  identity-runs-first ordering are all unchanged.
- `features/git-container-config/README.md` — the options table drops a row; the
  "Relationship to devc" section's claim that "`identityIncludePath`'s default
  stays empty precisely so no option here names a devc path" is **the argument
  this plan reverses** and must be rewritten, not just edited. The
  `initializeCommand` + mount recipe (~line 115) loses its `identityIncludePath`
  line and gains the fixed target.
- `features/git-container-config/test/git_config_test.sh` — the offline harness.
  Cases keyed on `IDENTITYINCLUDEPATH` (case 8 at ~line 170, case 1's
  empty-include assertion at ~line 112) re-key onto placing a file at the fixed
  path inside the temp `SHARE_DIR`. This harness runs the real `install.sh` and
  the real installed hook, so it needs no new mechanism — the fixed path is
  already under the `SHARE_DIR` it overrides.
- `features/git-container-config/test/test.sh` — `check "identityIncludePath
  baked empty"` (~line 27) asserts a baked line that no longer exists; replace
  with the fixed-path assertions (see Contracts).
- `features/git-container-config/test/scenarios.json` + `test/mounted_identity.sh`
  — the scenario passes `identityIncludePath`; it instead writes its identity
  file to the fixed path in `onCreateCommand`, the way `agents`' `with_seed`
  scenario writes into `claude-seed`.
- `.plans/devc-swap-baseline-features.md` — its Contracts block passes
  `identityIncludePath`, and its mounts section says `git-container-config`
  needs no mount change. **Both become false**; amend in the same pass that
  lands this (see Contracts).
- `.plans/PLAN.md` — register, then move to `archived/` on completion.

## Contracts

### The fixed path

```
/usr/local/share/devc-features/git-container-config/identity/gitconfig
```

A **directory** mount point holding a well-known filename, not a bare file path.
`install.sh` creates `identity/` empty at build time; the Feature only ever reads
it and never writes there — same contract as `agents`' `claude-seed`.

**Decided, not open.** The bare-file alternative below was considered and
rejected on review; do not re-litigate it. Directory, for consistency with the
two Features that already work this way:

- It is the shape `bash-config` (`dirs/user`) and `agents` (`claude-seed`)
  already use. One precedent, not two.
- A consumer can bind either the whole directory or just the file into it, and
  a directory mount point tolerates both. A bare-file mount point errors
  confusingly when a consumer binds a directory onto it.
- "Nothing mounted" stays a genuinely absent file, so **no `include.path` is
  written at all** — rather than an `include.path` pointing at an empty file,
  which would be harmless but would put a meaningless line in every
  `~/.gitconfig`.

_Alternative considered and rejected:_ a bare file at `…/identity`, `touch`ed
empty at build time, with step 1 testing `-s` instead of `-f`. Simpler by one
path component and it does work — devc already binds this file as a file today.
Rejected for consistency: two Features in this collection already expose a
directory to mount onto, and a third shape earns nothing. Recorded so the
question stays answered rather than rediscovered.

### `post-create.sh` step 1

The baked assignment becomes fixed, and the two nested conditionals collapse to
one. The `warn` on a named-but-missing file **goes away** — see Concept
boundaries.

```sh
IDENTITY_INCLUDE_PATH=/usr/local/share/devc-features/git-container-config/identity/gitconfig

if [ -f "$IDENTITY_INCLUDE_PATH" ]; then
  git config --global --replace-all include.path "$IDENTITY_INCLUDE_PATH"
fi
```

Keep the assignment **bare and at the start of a line**. It is no longer baked,
but it is still the file's one identity parameter, and every harness in this
collection re-points parameters with `sed -e "s#^VAR=.*#…#"`.

The "no git identity found" warning immediately below it is unchanged and is now
the _only_ identity warning — which is correct: it reports on the **effective**
identity (`git config --get user.email`), which is what the consumer actually
cares about, rather than on whether a mount landed.

### `install.sh`

```sh
mkdir -p "$SHARE_DIR/identity"
```

Root-owned, and never written to by this Feature — the `agents`/`claude-seed`
comment applies verbatim and is worth copying. No `chown`: the create-time hook
runs as the remote user but only reads.

### `test/test.sh` — replacing the baked-option assertion

The deleted `IDENTITY_INCLUDE_PATH=""` check is replaced by the pair `agents`'
`install_options_test.sh` uses to keep two files agreeing on one fixed path:

```sh
check "the hook names the same identity path install.sh creates" \
  grep -qxF 'IDENTITY_INCLUDE_PATH=/usr/local/share/devc-features/git-container-config/identity/gitconfig' \
  "$SHARE/post-create.sh"
check "the identity mount point was created, empty" test -d "$SHARE/identity"
```

This is what replaces the guarantee `bake()`'s own `grep -qxF` used to give for
this option: nothing else catches a rename that silently un-wires the path.

### Amendments to `devc-swap-baseline-features.md`

Two edits, in the same commit that lands this:

1. Its `features` Contracts block drops the `identityIncludePath` line, leaving
   `"ghcr.io/devc-tools/features/git-container-config:0": {}` — a bare `{}`,
   like `bash-config`'s.
2. Its mounts section currently says "`git-container-config` needs no mount
   change: its `identityIncludePath` still names the `gitconfig-identity` bind
   devc already declares." That becomes a **retarget**, exactly parallel to the
   `claude-seed` one it sits beside. The host source does not move:

   ```jsonc
   // RETARGETED. Host source unchanged; devc's initialize-command.sh still writes it.
   "type=bind,source=${localEnv:HOME}/.config/devc/gitconfig-identity,target=/usr/local/share/devc-features/git-container-config/identity/gitconfig,consistency=cached,readonly"
   ```

   A file bind onto a path inside a directory the image already created. devc's
   host side — `initialize-command.sh`'s identity extraction — is untouched.

## Concept boundaries

- **This removes a warning, and that is the accepted cost.** Today, naming a
  file that is not there is a visible mistake: the consumer asked for that path,
  so the Feature warns. A fixed always-present mount point cannot distinguish
  "consumer mounted nothing" from "consumer mounted an empty identity", so the
  warning has no trigger. `agents` accepted exactly this trade for an empty
  seed. What remains is the better signal anyway — the effective-identity
  warning, which fires when the outcome is actually wrong rather than when one
  input is missing.
- **`bake()` is not what this plan is about.** `agents` 0.2.0 deleted its baking
  machinery, but only because removing its last option left nothing to bake.
  Four real options remain here, and options reach a Feature only as environment
  variables in `install.sh` at build time — the manifest's `postCreateCommand`
  takes no arguments and no substitutions. Baking stays, and stays justified.
- **`/usr/local/share/devc-features/git-container-config/` vs
  `/usr/local/share/devc/`.** The first is this Feature's namespace; the second
  is devc's own baseline namespace, which no Feature writes into. This plan
  moves the identity target across that line — from devc's namespace, where the
  option pointed it, into the Feature's. That is the point: the path stops being
  devc's to choose.
- **The identity file's _contents_ remain entirely the consumer's business.**
  This Feature has never read, parsed or validated it, and still does not. Only
  the path stops being configurable.

## Checklist

- [x] `devcontainer-feature.json` — option removed, `version` → `0.2.0`,
      description sharpened
- [x] `install.sh` — option plumbing and one `bake()` call removed; `identity/`
      created empty; `bake()` and `check_opt` retained for what still needs them
- [x] `post-create.sh` — step 1 collapsed onto the fixed path, assignment bare
      at line-start
- [x] `README.md` — options table row dropped; the mount recipe retargeted; the
      "Relationship to devc" argument rewritten rather than patched
- [x] `test/git_config_test.sh` — identity cases re-keyed onto the fixed path
- [x] `test/test.sh` — baked-option assertion replaced by the two-file agreement
      pair
- [x] `test/scenarios.json` + `test/mounted_identity.sh` — scenario writes to the
      fixed path instead of passing an option
- [x] `.plans/devc-swap-baseline-features.md` — Contracts block and mounts
      section amended (both edits above)
- [x] `.plans/PLAN.md` — register, and move this plan to `archived/` on
      completion

## Validation

- [x] `bash features/git-container-config/test/git_config_test.sh` — green. It
      runs the real `install.sh` and the real installed hook, so it is the
      binding check that the fixed path is wired end to end.
- [x] `bash tests/features_test.sh` — green (manifest shape, allowlist).
- [x] `bash tests/workflow_guards_test.sh` — green.
- [x] `deno fmt --check` clean.
- [x] Both suites that this plan does **not** touch stay green:
      `cd devc && deno task test`. `devc-core`'s suite is red for unrelated
      reasons (missing `node-setup.sh` under a materialized cache dir — see
      `devc-swap-baseline-features.md`'s Validation note) — and this plan
      neither fixes nor worsens it.
- [ ] (needs Docker) `devcontainer features test` — the default scenario (bare
      `{}`, empty `identity/`, no `include.path` written) and the retargeted
      `mounted_identity` scenario.
- [ ] (needs Docker) **A file bind onto `identity/gitconfig` actually lands**,
      given `identity/` was created in an image layer. Expected to work — this
      is an ordinary file bind onto an existing directory — but it is the one
      mechanism this plan newly depends on, and the swap plan's devc mount uses
      exactly this shape.

## Not in this plan

- **Any change to the other four options.** `lfsFilters`, `lfsSkipSmudge`,
  `worktreeRelativePaths` and `safeDirectory` are behavior switches, not paths,
  and none of the `agents` 0.2.0 reasoning applies to them.
- **Anything in `devc-core/default/`.** `git-setup.sh` keeps running unchanged;
  devc does not consume this Feature until the swap plan lands. Copy, don't
  move — the same rule `agents` 0.2.0 followed.
- **Pinning bundled Features to exact versions in devc's config.** The floating
  `:0` is what makes this plan's ordering matter (see "Why now"), and switching
  the statically-declared Features to exact pins the way `devc-config` is pinned
  would remove that constraint — at the cost of a devc release per Feature bump.
  A real question, deliberately not reopened here.
