# devc-bridge as a devcontainer Feature

> **Partly superseded (`b513800`, `0d46b51`).** The Feature itself shipped as
> described and is current. Two decisions about **devc's** relationship to it
> were reversed shortly after this plan landed, so anything below about devc
> consuming the Feature is history:
>
> - devc's bundled config does **not** reference the Feature. A ref in the
>   bundled default makes every `devc up` depend on that ref resolving. It is
>   opt-in via `additionalFeatures` in a user- or project-level `devc.json`.
> - devc does **not** create the mount sources. The `devc:bridge-placeholder`
>   block is deleted; the host bridge seeds `~/.config/devc-bridge/` itself on
>   `start`. Installing the host bridge first is now the same prerequisite for
>   devc and non-devc projects alike — so decision 5's deliberate asymmetry, and
>   the "inert rather than fatal" argument for it, no longer apply.
>
> See `.plans/PLAN.md`'s Completed entry for the reasoning.

## Goal

Make the container half of devc-bridge a published devcontainer Feature, so any
project — devc or not — opts in with one line:

```jsonc
"features": { "ghcr.io/devc-tools/devc-bridge:1": {} }
```

devc's bundled config consumes the same Feature rather than carrying its own
mounts, so there is **one** mechanism instead of two.

### Why

[devc-bridge-client-mount](devc-bridge-client-mount.md) put two bind mounts and
a PATH-symlink step into `devc/default/`, which reaches every devc container
with no per-project wiring. That is the right shape for devc users and the wrong
shape for everyone else: a project that does not use devc has to hand-copy two
mount strings and a post-create step into its own `devcontainer.json`, and devc
carries bridge-specific config that has nothing to do with running containers.

A Feature is the packaging the ecosystem already has for "one opt-in addition to
a devcontainer".

## Findings — measured, not assumed

The design hinged on two questions about Feature-declared mounts. Both were
answered empirically with a throwaway Feature (since deleted — everything it
established is recorded here). The devcontainer CLI generated:

```
--mount type=bind,source=/Users/bingles/.config/devc-bridge/run,target=/probe/str
--mount type=bind,src=/Users/bingles/.config/devc-bridge/run,dst=/probe/obj
--mount type=bind,source=/Users/bingles/.config/devc-bridge/run,target=/probe/ro,readonly
```

1. **`${localEnv:HOME}` is substituted in Feature mounts** — both forms. A
   Feature can name a host home-relative path.
2. **A Feature mount written as a _string_ is passed through verbatim, so
   `readonly` survives** (`docker inspect` → `RW=false`). The **object** form is
   re-serialized (note `src=`/`dst=`), and that is the path that drops
   `readonly` — the CLI's `Mount` interface has no such field. This mirrors
   `devcontainer.json` exactly, where string mounts pass through and the overlay
   does not.
3. **Unspecified, though.** The published Feature schema allows objects only,
   with `additionalProperties: false`. String mounts work in the current CLI and
   are widely relied on, but nothing in the spec guarantees them — which is why
   [cli#881](https://github.com/devcontainers/cli/issues/881) is still open.
4. **Features cannot declare `initializeCommand`.** Their five lifecycle hooks
   all run inside the container, and `--mount type=bind` errors on a missing
   source. So a Feature **cannot create its own mount sources** — see decision 4.

## Decisions

1. **Mounts are declared as strings, and that is load-bearing.** The object form
   cannot carry `readonly` (finding 2). Anyone editing this file must keep the
   string form; converting it to objects silently makes both mounts writable.
2. **The client keeps arriving by read-only bind mount**, not by download at
   create time. Downloading was only ever a workaround for a `readonly`
   restriction that turned out not to exist, and it would make this plan depend
   on [release-and-installer](release-and-installer.md) shipping first, decouple
   the client version from the host that installed it, and require network at
   create.
3. **The Feature owns the namespace, not devc.** Mount target becomes
   `/usr/local/share/devc-bridge/client`, not `/usr/local/share/devc/...` — a
   Feature used by projects that have never heard of devc should not plant
   things in devc's directory. `/run/devc-bridge` is unchanged, since it is the
   client's built-in `DEVC_BRIDGE_TOKEN_FILE` default.
4. **The Feature requires the host bridge to be installed first, and says so.**
   It cannot create its mount sources (finding 4), so a project that adds it on
   a host with no `~/.config/devc-bridge/{run,client}` fails container creation
   with a Docker "bind source path does not exist" error. That is acceptable for
   an opt-in add-on — you add it _because_ you use the bridge — but it is a real
   behavior change from today's inert-when-absent mounts, and belongs in the
   Feature's README as the first thing it says.
5. **devc keeps its `initialize-command.sh` block.** devc's bundled config
   references the Feature for _every_ devc container, including users who never
   installed the bridge — so devc, which _does_ have a host-side hook, keeps
   creating the two dirs and the placeholder. This is what preserves
   inert-when-absent on the devc path while the standalone path takes decision
   4's harder line. Same reason the placeholder stays: without it the PATH
   symlink dangles and bash reports a bare "No such file or directory".
6. **The PATH symlink moves into the Feature's `install.sh`, and gets simpler.**
   Feature install scripts run as **root at image-build time**, which drops the
   `sudo`-when-not-writable branch that `bridge-client-link.sh` needs today.
   Build time is also _before_ the mount exists — which is exactly why the
   existing "link unconditionally, it heals when the mount appears" design
   survives the move unchanged. A guard would break it.
7. **Move the pidfile out of the mounted dir**: `config.ts`'s
   `pidfile: join(run, 'tray.pid')` → `join(base, 'tray.pid')`. With `readonly`
   working this is no longer required, but decision 8 leaves compose users with
   a writable `run/`, and this is what keeps that from being a way to feed
   `devc-bridge stop` an arbitrary PID.

   It does **not** make a writable `run/` harmless, and the token mount stays
   `readonly` on its own merits: `ensureToken` (`token.ts`) _adopts_ an existing
   token file rather than regenerating, so a container able to write
   `run/token` pins the host's shared secret to a value of its choosing across
   host restarts, and deleting the file no longer rotates it. Dropping
   `readonly` on the token mount therefore buys nothing — the client mount
   already forces the string form — while giving up token integrity. Hardening
   `ensureToken` to always regenerate would close that, and is only worth doing
   as part of decision 2's rejected alternative.
8. **Docker Compose is out of scope, documented, not worked around.** For
   compose-based devcontainers the string form emits a literal `path,readonly`
   rather than compose's `:ro` — the substance of cli#881. Supporting both would
   mean the object form, which loses `readonly` for everyone. Image- and
   Dockerfile-based devcontainers get the correct mount; compose users are told
   the Feature is unsupported. Decision 7 blunts the worst of it for anyone who
   ignores the warning but does not eliminate it — see the token note there.
   The caveat is attributable **entirely to the client mount**: it is the only
   mount that cannot function writable, so it is the only reason the string
   form is mandatory. Removing it (decision 2's alternative) is the sole path
   to object-form, compose-compatible mounts, and would additionally require
   the `ensureToken` hardening above.
9. **Findings 1 and 2 get a regression test**, because they are undocumented CLI
   behavior (finding 3) that this design silently depends on. Without one, a CLI
   upgrade that stops substituting `${localEnv:HOME}` or stops honoring
   `readonly` on a string mount surfaces as a mysteriously writable mount in
   someone's container rather than as a failing test here.

## Implementation

### `features/devc-bridge/` (new, repo root)

`devcontainer-feature.json` — `id: devc-bridge`, version in lockstep with the
repo tag (see [release-and-installer](release-and-installer.md) decision 8), and
the two **string** mounts:

```jsonc
"mounts": [
  "type=bind,source=${localEnv:HOME}/.config/devc-bridge/run,target=/run/devc-bridge,consistency=cached,readonly",
  "type=bind,source=${localEnv:HOME}/.config/devc-bridge/client,target=/usr/local/share/devc-bridge/client,consistency=cached,readonly"
]
```

`install.sh` — the PATH symlink, carrying over the `devc:bridge-client-link`
fence and its reasoning from `devc/default/scripts/bridge-client-link.sh`, minus
the sudo branch (decision 6). Options: none for now; the paths above are the
contract on both sides and an option that changes one would have to change the
mount, which Feature metadata cannot interpolate.

`README.md` — decision 4's prerequisite first, then compose (decision 8).

### `devc/default/` — stop carrying the bridge

- `devcontainer.json`: delete the two bridge mounts; add the Feature to
  `features`. Everything else unchanged.
- `scripts/bridge-client-link.sh`: **deleted** — the Feature's `install.sh`
  replaces it.
- `post-create.sh`: drop the link step.
- `initialize-command.sh`: **keep** the `devc:bridge-placeholder` block
  (decision 5).

Note the two mounts must be removed in the same change that adds the Feature, or
every devc container fails on duplicate mount points.

### `devc-bridge/host/config.ts` — the pidfile move

`pidfile` moves from `run/` to `base/` (decision 7). Pre-release, so no
migration path: a tray started before the change writes the old location and a
post-change `stop` will report `not running` and leave it orphaned. Worth one
line in the bridge README; not worth code.

### `features/devc-bridge/test/` — the regression test

Use the Features tooling's own harness (`devcontainer features test`), which
builds a container from the Feature and runs assertions **inside** it — enough to
cover decision 9 without parsing `docker inspect`:

- `/run/devc-bridge` exists and contains `token` → the `${localEnv:HOME}` source
  resolved (finding 1). An unsubstituted source cannot produce a populated mount.
- Writing into `/run/devc-bridge` **fails** → `readonly` survived the string form
  (finding 2).
- `devc-bridge` resolves on `PATH` and is a symlink to the mounted client.

Precondition: the host must have `~/.config/devc-bridge/{run,client}` populated,
i.e. the bridge installed — the same prerequisite decision 4 puts on real users.
State it in the Feature README next to that one. Needs Docker, so this is run
deliberately, not from `deno task test`.

### Publishing

A GitHub Action publishing `features/devc-bridge/` to
`ghcr.io/devc-tools/devc-bridge`, using the devcontainers publish
tooling. Separate workflow from the binary release, same tag trigger, and the
same version guard: the Feature's `version` is bumped with the repo tag and the
workflow fails if the two disagree — identical in spirit to
[release-and-installer](release-and-installer.md) decision 8, and for the same
reason (a published artifact must not disagree with the commit it claims).

**This must land before devc consumes the Feature.** An ordinary project can
reference an unpublished Feature by relative path, but devc's bundled config
cannot: it is materialized into a cache dir, where `./features/…` does not
resolve to anything. So within this plan the order is: build the Feature →
publish it → point `devc/default/devcontainer.json` at the published ref and
delete devc's mounts. Doing the devc change first breaks every devc container.

## Notes from the build — two deviations from the text above

1. **The Feature is referenced as `:0`, not `:1`.** The repo's version is
   `0.1.0` (`devc/help.ts`), and the devcontainers publish tooling tags a
   `0.1.0` Feature `latest`/`0`/`0.1`/`0.1.0` — there is no `1` to resolve, so
   the `:1` in this plan's Goal would fail to pull. It becomes `:1` when the
   repo does.
2. **`devcontainer features test` needs a collection layout this repo does not
   use.** It insists on `<project>/src/<id>/` + `<project>/test/<id>/`, while
   `devcontainer features publish` (and this plan) want the Feature
   self-contained at `features/<id>/`. Rather than split one Feature across two
   trees, `features/devc-bridge/test/run-features-test.sh` stages a throwaway
   copy in the layout the test command expects and invokes it there.

Also: the `bridge_client_link_test.sh` harness moved to
`features/devc-bridge/test/install_link_test.sh` (alongside the container
scenario, in the Feature it now tests) and defaults its argument to the
Feature's own `install.sh`.

## Checklist

- [x] `features/devc-bridge/devcontainer-feature.json` — id/version/name + the
      two **string** mounts with `readonly`
- [x] `features/devc-bridge/install.sh` — unconditional PATH symlink, fenced, no
      sudo branch
- [x] `features/devc-bridge/README.md` — host-bridge-first prerequisite, compose
      limitation
- [x] `devc/default/devcontainer.json` — bridge mounts removed, Feature added
      (same change)
- [x] `devc/default/scripts/bridge-client-link.sh` — deleted
- [x] `devc/default/post-create.sh` — link step dropped
- [x] `devc/default/initialize-command.sh` — placeholder block kept, comment
      updated to say the Feature consumes it
- [x] `devc-bridge/host/config.ts` — `pidfile` moves to `base/`
- [x] `devc/tests/default_config_test.ts` — mount assertions replaced by a
      Feature-reference assertion; `bridge-client-link.sh` out of both
      expected-file lists
- [x] `devc/tests/bridge_client_link_test.sh` — moved/retargeted at the Feature's
      `install.sh`
- [x] `features/devc-bridge/test/` — `devcontainer features test` scenario
      asserting substitution, read-only, and the PATH symlink
- [x] `.github/workflows/` — Feature publish workflow
- [x] `devc/README.md`, `devc-bridge/README.md` — one mechanism; the bridge
      section becomes "add the Feature"
- [x] `.plans/PLAN.md` — register

## Validation

- [x] `deno task check` / `test` / `fmt --check` clean — 269/269 in `devc/`,
      `deno check` clean in `devc-bridge/host/`, `deno fmt --check` clean
      repo-wide. The other three shell harnesses (`seed_link`, `shell_dirs`,
      `project_hook`, `initialize_command`) still pass unchanged.
- [x] Feature `install.sh` harness passes (link created dangling, heals, is
      idempotent, repoints a stale link) — `features/devc-bridge/test/install_link_test.sh`,
      all 5 cases
- [ ] (user, needs Docker) `devcontainer features test` passes: populated
      `/run/devc-bridge`, a failed write into it, and `devc-bridge` on `PATH` —
      the two findings this design rests on. Written and syntax-checked
      (`features/devc-bridge/test/test.sh`, run via `test/run-features-test.sh`);
      not run — no Docker in the implementing environment.
- [ ] (user) A **non-devc** project with only the Feature line and an
      image-based `devcontainer.json` → `devc-bridge ping test` prints `pong`.
      This is the whole point of the plan.
- [ ] (user) A devc project → same result, with no duplicate-mount error
- [ ] (user) `touch /run/devc-bridge/x` and
      `touch /usr/local/share/devc-bridge/client/x` both fail
- [ ] (user) A host that never installed the bridge: a **devc** container still
      builds (decision 5), and a **standalone Feature** project fails with the
      bind-source error (decision 4) — both are intended, and the difference is
      the thing most likely to be misremembered later
- [ ] (user) Client installed while a container is already running still heals
      with no rebuild
- [ ] (user) `devc-bridge stop` works with the pidfile at its new path

## Relevant Files

- `features/devc-bridge/` — new
- `devc/default/devcontainer.json`, `post-create.sh`, `initialize-command.sh`
- `devc/default/scripts/bridge-client-link.sh` — deleted
- `devc-bridge/host/config.ts` — pidfile path
- `devc/tests/default_config_test.ts`, `devc/tests/bridge_client_link_test.sh`
- `features/devc-bridge/test/` — the regression harness
- `devc/README.md`, `devc-bridge/README.md`
- `.plans/PLAN.md`

## Follow-on (not this plan)

- **Decoupling the tray from the host install** — `core.ts` already owns the
  server and keepawake and `tray.ts` already degrades headless, so the coupling
  is only in `start`'s `deno desktop` build + `open -g`. Removing it makes the
  host binary shippable, deletes two release assets and the `iconutil`
  constraint, and makes `persistEnvSettings` unnecessary (it exists only because
  LaunchServices drops the shell env). Its own plan.
- **A Linux keepawake command.** `Keepawake` dispatches `start`/`stop` to an
  allowlisted _script_, so this is a `systemd-inhibit` script in `commands/` plus
  a platform-aware default — no engine change.
