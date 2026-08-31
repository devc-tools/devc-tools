# devc-bridge — download the client, and let the consumer own the mount

## Goal

Make the Feature's security independent of **undocumented devcontainer CLI
behavior**. Today both guarantees it offers rest on `readonly` surviving into
`docker run --mount`, which the published Feature schema cannot express and the
CLI honors only as an accident of string passthrough.

| What                        | Today                             | After                                                    |
| --------------------------- | --------------------------------- | -------------------------------------------------------- |
| Client binary               | read-only bind mount, string form | **downloaded at image build time** — no mount            |
| Token                       | read-only bind mount, string form | mount declared by the **consumer's `devcontainer.json`** |
| `devcontainer-feature.json` | two off-schema string mounts      | **no `mounts` key at all**                               |

The Feature ends up doing one thing — install the client — and declaring nothing
the spec does not sanction. The single mount the arrangement still needs moves to
`devcontainer.json`, where the string form and `readonly` are **specified**.

### Why

The Feature declares its mounts as JSON **strings** because
`generateMountCommand` passes a string to Docker verbatim but rebuilds an object
from scratch as `type=,src=,dst=`, dropping every other field. The published
Feature `Mount` schema has `additionalProperties: false` and no `readonly`, so
the supported form _cannot_ carry it. The string form works, is off-schema, and
is load-bearing for security — a combination with no good failure mode: a future
CLI that normalizes string mounts would silently make both mounts writable.

Two independent moves remove the dependency rather than defending it:

- The **client** does not have to come from the host at all. It is already a
  published release asset, so the Feature fetches it at build time and owns it as
  a root-owned file in an image layer. The vector `readonly` defended against —
  one container rewriting a binary every other container executes — stops
  existing rather than being blocked.
- The **token** must cross at runtime, so it stays a mount. But nothing requires
  the _Feature_ to declare it. In `devcontainer.json` the string form is in the
  schema and `readonly` is real, so the consumer declares it and gets a
  guarantee the spec actually makes.

## Findings — measured, not assumed

Schemas from `devcontainers/spec` @ `main`; CLI source from `devcontainers/cli` @
`main`, read locally. The filesystem findings were run inside this repo's own
devcontainer.

1. **A Feature cannot express `readonly`, in either the schema or the CLI.**
   `devContainerFeature.schema.json` types `mounts` as `items: {$ref: Mount}` —
   objects only — and `Mount` is `additionalProperties: false` over exactly
   `source` / `target` / `type`. The CLI's interface
   (`containerFeaturesConfiguration.ts:102-107`) adds only `external`.
   `generateMountCommand` (`dockerfileUtils.ts:280-294`) returns
   `['--mount', <string>]` untouched for a string, and otherwise emits exactly
   `type=…,src=…,dst=…`. No object form keeps `readonly`.

2. **`devcontainer.json` is different, and says so.** `devContainer.base.schema.json`
   types `mounts` as `anyOf: [Mount, string]` and describes it as _"See Docker's
   documentation for the --mount option for the supported syntax."_ The string
   form is not tolerated there, it is specified, and it is specified to be
   Docker's syntax — which is what makes `readonly` a promise rather than an
   accident. This is the whole basis for the plan.

3. **Host file permissions cannot substitute for `readonly`.** Docker Desktop
   shares host paths through `fakeowner` (`/proc/mounts`), which does not enforce
   DAC. Measured on the `rw` bind: an unprivileged `vscode` (uid 1000) overwrote a
   file that was `root:root`, mode `0400` — 6 bytes to 13, content replaced, exit
   0, **no sudo**. `ls -l` reports whatever owner suits the caller. The `ro` flag,
   by contrast, is enforced and stops root:
   `sudo touch /run/devc-bridge/probe` → `Read-only file system`.

4. **A container can plant symlinks in a writable bind mount.** `ln -s /etc/passwd …`
   succeeds and the target is stored verbatim, as is a relative
   `../../../../etc/hostname`; the host resolves those in its **own** namespace.
   Inert when the mount is `ro`, which is why it never mattered before — and why
   it matters for any consumer who omits `readonly` or uses compose.

5. **Compose drops `readonly` regardless of form.** `dockerCompose.ts:525` parses
   the mount and `:738` emits only `source:target`. Compose consumers therefore
   get a writable token mount no matter what they write.

6. **The host is already authoritative in memory.** `core.ts:213` compares
   `req.token !== opts.token`, loaded once at `main.ts:147`, before
   `startServer` opens its listener (`core.ts:171`). A container writing
   `run/token` while the bridge runs authorizes nothing. The single escalation is
   `ensureToken` (`token.ts:13-19`) adopting a non-empty file on the **next**
   start, letting a container pin an attacker-chosen secret across a restart.

7. **Regenerating the token is transparent to running containers.** The client
   re-reads the token file on **every invocation** (`client/devc-bridge.ts:81`),
   and `run/` is mounted as a live directory. Adoption buys nothing that
   regeneration loses.

8. **`run/` holds the token and nothing else** (`config.ts:20`). The pidfile was
   already moved to `base/` (`config.ts:38-44`) because a container-writable PID
   picks which host process `stop` sends SIGTERM to. Nothing else host-side reads
   from `run/`.

9. **Feature-declared mounts collide with consumer-declared ones.**
   `devc/default/devcontainer.json:61-63` records it: declaring the bridge mounts
   there _as well_ fails the create with Docker's `Duplicate mount point`. So
   today a consumer who wants to adjust the mount cannot — the Feature owns it and
   any attempt to override is a hard failure. Moving it out removes the footgun.

10. **devc's baseline cannot carry the mount, and its overlay cannot either.**
    Found while implementing, and the reason decision 6 was revised.

    `0d46b51` ("devc: stop creating devc-bridge directories on every host")
    deleted the `mkdir -p ~/.config/devc-bridge/{run,client}` from
    `initialize-command.sh` on purpose: _"A host that never uses the bridge should
    not carry directories for it… a devc project and a non-devc project now have
    exactly the same prerequisite."_ An unconditional mount in the bundled default
    would therefore make **every** devc create fail on a bridge-less host —
    `--mount type=bind` errors on a missing source, and `default/devcontainer.json`
    is copied verbatim into projects with no filtering by source existence.
    `devc/tests/default_config_test.ts:336` pins that invariant and **must keep
    passing unchanged**; do not re-propose relaxing it or restoring the mkdir.

    The devc.json overlay is not the escape hatch either: overlay mounts become
    `devcontainer up --mount` args, and `MOUNT_SPEC_RE` (`devc/overlay.ts:50-68`,
    `devc/README.md:222-228`) rejects `readonly` for the same re-serialization
    reason that rules out Feature mounts. A `devcontainer.json` `mounts` array is
    the only place a read-only bind can be expressed at all.

    What remains is the config devc _materializes_ for zero-config mode
    (`default_config.ts:117` picks the mode, `:252` writes the file) — devc's own
    artifact, and the one surface it may write to. devc has deliberately no code
    path that writes into a project's `.devcontainer/` (`wizard_apply.ts:8-13`);
    that stays true.

11. **`${localEnv:HOME}` in Feature mounts is the same substitution pass** as
    `devcontainer.json` (`imageMetadata.ts:310` → `variableSubstitution.ts:97`).
    Undocumented for Features, documented for `devcontainer.json` — and after this
    plan the Feature has no mounts, so the question is moot.

12. **The client is already a release asset.** `release.yml:228` publishes
    `devc-bridge-client-$VERSION-{x86_64,aarch64}-unknown-linux-gnu.tar.gz`, and
    `install.sh:277` already fetches and checksum-verifies exactly that name.

13. **Arch detection inside the container is the easy direction.** `uname -m` in
    the build is the image's own architecture, which is what the client must
    match. Contrast `install.sh:65-93`, where `CLIENT_TRIPLE` must be derived from
    the _host_ and is flagged as the easy thing to get backwards.

## Decisions

1. **The client is downloaded in `install.sh`, not mounted.** Feature installs run
   as root at image build time, so the binary lands root-owned `0755` in an image
   layer. No shared host file means no cross-container tamper vector. A
   root-capable container can still overwrite its own copy — as it can any binary
   in its own image — which affects only itself.

2. **The destination path does not change.** Still
   `/usr/local/share/devc-bridge/client/devc-bridge`, symlinked from
   `/usr/local/bin/devc-bridge`. This keeps the developer story free:
   bind-mounting a locally built client dir over that path shadows the downloaded
   copy, live, with `build-client.sh`'s atomic same-dir rename still working.

3. **Downloads are checksum-verified against the release's `checksums.txt`,** by
   the same rule `install.sh` states: nothing is placed outside a temp dir until
   the hash matches, and a mismatch fails the build.

4. **The version defaults to the Feature's own version.** The publish workflow
   already fails when `devcontainer-feature.json`'s `version` disagrees with the
   tag (`publish-feature.yml:41-43`). A `clientVersion` option overrides it.

5. **The Feature declares no mounts. The consumer declares the token mount.**
   This is the core of the plan. In `devcontainer.json` the string form is in the
   schema (finding 2), `readonly` is enforced even against root (finding 3), and
   `${localEnv:HOME}` is documented. The Feature file becomes trivially valid, the
   duplicate-mount footgun (finding 9) disappears, and the consumer can adjust the
   mount without fighting the Feature. Cost: a standalone project copies **one**
   mount line in addition to the Feature line — down from two mounts plus a
   post-create step before the Feature existed, and the line is now
   security-relevant text the consumer should see rather than inherit invisibly.

6. **devc injects the mount into the config it _materializes_, when and only when
   the Feature is opted into.** (Revised during implementation — the original
   decision said devc's _bundled default_ carries it, which cannot work; see
   finding 13.)

   The bundled default stays bridge-free, so a devc container still comes up on a
   host that never installed the bridge, and `initialize-command.sh` still creates
   no bridge directories. In **zero-config** mode devc materializes its own
   `devcontainer.json` into `~/.cache/devc/default`; that file is devc's artifact,
   so injecting there touches neither the bundled default nor a project's config.
   In **project mode** devc uses the project's own `devcontainer.json` and must not
   write to it — those users declare the mount themselves, exactly like a non-devc
   project. That asymmetry is the one wrinkle in "a devc project and a non-devc
   project have the same prerequisite", and it is documented in `devc/README.md`.

   Injection fires on the resolved overlay's `additionalFeatures` containing the
   Feature id, tag ignored, matched on the last path segment — so `:0`, `:1`, a
   pinned `:0.1.0`, a bare id and a local `./features/devc-bridge` all count. A
   Feature named `devc-bridge` from any registry counts too: it needs the same
   token mount whoever published it, and guessing otherwise would silently
   withhold it.

   This _is_ a devc-only shortcut, of the kind `0d46b51` set out to remove, so it
   has to earn itself: it is materialization-time only (no host-side side
   effects, nothing created on disk outside devc's own cache), opt-in only, and
   unavoidable — `readonly` cannot survive any other route (findings 1 and 13),
   and without it a container can pin the host's token.

7. **The host regenerates the token on every `start` instead of adopting it.**
   Kept even though `readonly` is back, because it closes the pinning bug that
   exists _today_ (finding 6) and because the security must not depend on every
   consumer remembering `readonly` — compose consumers cannot have it at all
   (finding 5). Safe because of finding 7.

8. **Token writes are symlink-safe.** Write a temp file in the **same directory**
   and `rename` over the target: `rename` replaces a symlink instead of following
   it, and is atomic, so a client never reads a half-written token.
   `build-client.sh:44` already uses this pattern. Without it, decision 7 would
   hand a writable-mount consumer an arbitrary host-file overwrite (finding 4) —
   the host would follow a planted symlink and write the fresh token through it.

9. **No token watcher.** An earlier draft had the host restore `run/token`
   whenever it changed. Dropped: with `readonly` it is dead code, and for a
   consumer who omits `readonly` the residual is a self-inflicted denial of
   service, which does not justify a second watch loop and its
   write-triggers-itself hazard. Recorded here so it is not re-proposed.

10. **A forgotten mount fails at runtime, not at build.** The client already says
    it well (`client/devc-bridge.ts:88-90`: _"is the host server running and the
    run dir bind-mounted?"_). Do not add a build-time probe: the mount does not
    exist at build time, so a Feature check could only guess. Document the
    expected failure instead.

11. **The `client/` prerequisite disappears; `run/` remains.** A consumer that
    declares the mount still fails to create on a host that never ran
    `devc-bridge start`, because `--mount type=bind` errors on a missing source.
    That is now the consumer's mount and the consumer's error, and the README
    should say so.

12. **Compose stops being excluded, with a caveat.** Compose consumers get a
    writable token mount (finding 5); decisions 7 and 8 make that survivable. The
    residual — `run/` usable as a dead drop between containers that mount it — is
    accepted and documented, not silently inherited.

## Concept boundaries

- **`$CLIENTVERSION` is not `VERSION`.** Feature options reach `install.sh` as env
  vars named `getSafeId(name)` — uppercased, non-word chars to `_`
  (`containerFeatures.ts:26-29`, v2 branch at `:410-413`). Option `clientVersion`
  arrives as `$CLIENTVERSION`. The repo already has three unrelated `VERSION`
  consts (`devc/version.ts`, `devc-bridge/host/version.ts`,
  `devc-bridge/client/version.ts`) and a `$VERSION` in `install.sh` and both
  workflows.

- **Two different binaries are named `devc-bridge`** — the macOS host CLI and the
  Linux container client. The Feature wants `devc-bridge-client-*`, never
  `devc-bridge-host-*`. `install.sh:207-209` documents why this bites.

- **`ensureToken` changes meaning, so it changes name.** Callers expecting "load
  or create" must not silently become "replace". Rename to `resetToken` so a stale
  call site fails to compile.

- The client **mount** is not gone from the codebase, only from the Feature. It
  remains the dev override (decision 2), so text saying "the client arrives by
  bind mount" needs re-scoping, not deletion.

## Implementation

### `features/devc-bridge/devcontainer-feature.json`

Delete `mounts` entirely. Add:

```json
"options": {
  "clientVersion": {
    "type": "string",
    "default": "",
    "description": "Release version of the Linux client to install. Empty means the version this Feature was published with."
  }
}
```

### `features/devc-bridge/install.sh`

Gains a download step ahead of the existing fenced symlink block, which is
otherwise unchanged. Contract:

- Resolve version: `$CLIENTVERSION` if non-empty, else the Feature's own
  `version`, baked in at authoring time — the script cannot read its own
  `devcontainer-feature.json` at build time. Accept `1.2.3` and `v1.2.3`; asset
  names carry the bare version, URLs carry the `v` (`install.sh:155-164`).
- Resolve arch from `uname -m`: `x86_64|amd64` → `x86_64`, `arm64|aarch64` →
  `aarch64`, anything else a hard failure. Triple is `<arch>-unknown-linux-gnu`.
- Fetch `checksums.txt` and `devc-bridge-client-<bare>-<triple>.tar.gz` from
  `${DEVC_RELEASE_BASE:-https://github.com/devc-tools/devc-tools/releases}/download/v<bare>/`.
  Honoring `DEVC_RELEASE_BASE` is what lets tests point at a `file://` fixture,
  as `install.sh:257` does.
- Verify sha256 before anything leaves the temp dir; mismatch aborts the build.
- Unpack to `/usr/local/share/devc-bridge/client/devc-bridge`, `chmod 0755`.
- Then the existing `devc:bridge-client-link` block, unchanged.

The header comment's "Nothing is built or downloaded here" becomes false, as does
its account of where the client comes from.

### `devc/default/devcontainer.json`

Still declares **no** bridge mount — `default_config_test.ts:336` keeps passing.
Replace the "no devc-bridge mounts here, by design" comment at `:61-63` with why
the baseline carries nothing and where the mount comes from instead, ending in the
insertion anchor (keep it the _last_ line of the block, or the injected mount
splits the comment):

```jsonc
// … why the baseline is bridge-free, and why the overlay cannot carry it …
// The marker below is the insertion anchor. Keep it last in this block.
// devc:bridge-mount
```

### `devc/default_config.ts`

Two additions:

- `declaresBridgeFeature(additionalFeatures: Record<string, unknown>): boolean` —
  exported. Strips an OCI tag (a trailing `:…` with no `/` after it) and compares
  the last `/` segment to `devc-bridge`.
- `materializeDefaultConfig(cacheDir?, templatesDir?, opts?: { bridge?: boolean })`
  — a third positional argument, defaulting to no injection, applied _after_ the
  template overlay like the existing path rewrites. Injection inserts the mount
  string after the `// devc:bridge-mount` anchor line, matching its indentation.

  Text insertion, not parse-and-serialize: the config is JSONC and its comments
  are worth keeping. Two guards: skip entirely if the text already contains
  `target=/run/devc-bridge` (a user template that declared it wins — two mounts on
  one target is Docker's `Duplicate mount point`), and if the anchor is missing
  (only reachable when a template replaced `devcontainer.json` wholesale) warn to
  stderr with the exact line to add rather than failing or silently skipping.

### `devc/container.ts`

Load the overlay **before** materializing, and pass
`{ bridge: declaresBridgeFeature(overlay.additionalFeatures) }`. Project mode
(`ownConfig !== null`) never materializes, so it never injects — which is the
requirement, not an accident.

### `devc-bridge/host/token.ts`

`ensureToken` → `resetToken(path)`: always generate 32 random bytes, return the
token, no read-existing branch. Mode stays `0644` — the container uid differs and
must still read it, and per finding 3 the mode was never a boundary.

The write is the security-relevant part (decision 8): write to a temp path in
`dirname(path)`, `chmod` it there, `Deno.rename` over `path`, clean up the temp
file on failure. Never `writeTextFile` directly to `path`.

The header comment currently frames the threat model around a read-only mount. It
should say: the file is a delivery channel, the process's in-memory copy is the
authority, and the writer assumes the directory may be container-writable.

### `devc-bridge/host/main.ts`

`ensureToken` call site (`:147`) follows the rename. `clientStatus` (`:342-371`)
no longer describes how containers get a client — it now reports only whether the
**dev override** source is populated. Reword its output and the comment at
`:220-224`, which claims the mount is how every devc container gets one.

### `devc-bridge/host/config.ts`

The pidfile comment (`:38-44`) justifies `base/` partly by "the mount is
read-only". That is now the consumer's choice rather than the Feature's
guarantee, which makes the move load-bearing — say so.

### `devc/default/initialize-command.sh`

**Unchanged.** The plan originally said to keep a `run/` mkdir here; there is
none to keep — `0d46b51` removed it deliberately (finding 13) and it stays
removed. devc creates no bridge directories in either mode, so a devc project and
a non-devc project keep exactly the same host prerequisite.

### Tests

- `devc/tests/default_config_test.ts` — the assertion at `:363` currently reads
  the Feature's mounts; invert it to "the Feature declares no `mounts` key". Leave
  `:336` (the baseline carries no bridge mount) **untouched and passing**. Add, for
  the injection: id matching across tag spellings and a local path, the mount
  present only when opted in (and absent by default), that it is a _string_
  carrying `readonly`, that surrounding comments and other mounts survive, and
  that an already-declared mount is not doubled.
- `devc-bridge/host/tests/` — `resetToken` replaces rather than adopts; **a
  symlinked token path is replaced and the symlink's target is left untouched**
  (the regression test for decision 8).
- `features/devc-bridge/test/` — assert the client is present, root-owned, not
  writable by the remote user, and `devc-bridge version` matches. Drop the
  `readonly` assertion (no longer the Feature's claim). Add a host-side unit test
  of the download against a `file://` `DEVC_RELEASE_BASE` fixture including a
  **checksum-mismatch** case that must abort; `tests/install_test.sh` is the model
  for stubbing `uname` on PATH.

### Docs

- `features/devc-bridge/README.md` — the wiring snippet grows a `mounts` entry and
  must lead with it, since a consumer who copies only the Feature line gets a
  runtime failure. State the failure text so it is searchable. The "What it does"
  table loses the client row; the compose exclusion becomes a caveat (decision
  12); the maintainer note about string mounts is replaced by one explaining why
  the mount is the consumer's and why the Feature must never re-declare it.
- `devc-bridge/README.md` — the architecture diagram shows the client arriving by
  mount; it now arrives with the image. `host/config.ts:46`'s compose/`readonly`
  comment goes.
- `devc/README.md` — the bridge client mount description, plus a table of which
  mode declares the token mount and the project-mode snippet. The asymmetry is
  the one wrinkle in "same prerequisite", so name it rather than bury it.
- Root `README.md` / `docs/` — check the setup narrative still reads correctly now
  that `devc-bridge start` is not what puts a client where containers can see it.

## Checklist

- [x] `features/devc-bridge/devcontainer-feature.json` — `mounts` removed,
      `clientVersion` option added
- [x] `features/devc-bridge/install.sh` — versioned, arch-matched,
      checksum-verified download ahead of the unchanged symlink block
- [x] `devc/default/devcontainer.json` — bridge-free, plus the `devc:bridge-mount`
      insertion anchor and why the baseline carries nothing
- [x] `devc-bridge/host/token.ts` — `ensureToken` → `resetToken`, always
      regenerate, symlink-safe temp+`rename` write
- [x] `devc-bridge/host/main.ts` — rename call site; `clientStatus` re-scoped
- [x] `devc-bridge/host/config.ts` — pidfile comment's premise updated
- [x] `devc/tests/default_config_test.ts` — inverted: asserts the Feature
      declares **no** `mounts` key
- [x] `devc-bridge/host/tests/` — replace-not-adopt; symlink target untouched
- [x] `features/devc-bridge/test/` — client ownership/version; offline
      checksum-mismatch case
- [x] `features/devc-bridge/README.md`, `devc-bridge/README.md` — re-scoped
- [x] `devc/default_config.ts` — `declaresBridgeFeature` + materialization-time
      injection of the readonly token mount
- [x] `devc/container.ts` — overlay loaded before materialization; project mode
      passes no injection
- [x] `devc/tests/default_config_test.ts` — id matching by tag/path, injected only
      when opted in, string + `readonly`, comments intact, no double-mount
- [x] `devc/default/initialize-command.sh` — **unchanged on purpose**: `0d46b51`
      stands, devc creates no bridge directories
- [x] `devc/README.md`, root `README.md` — the wiring story for both modes
- [x] `.plans/PLAN.md` — move to Completed, plan doc to `archived/`

## Resolved: who declares devc's token mount

The plan originally said devc's _bundled default_ carries the mount (decision 6 as
written). That is not implementable — see finding 13 — and the discovery stopped
implementation for a call. The resolution, now folded into decision 6:

**devc injects the mount into the `devcontainer.json` it materializes, when and
only when the devc-bridge Feature is opted into.** Zero-config users wire up
nothing; project-mode users declare the mount themselves, like any non-devc
project; the bundled default and `initialize-command.sh` are untouched, so
`0d46b51` stands and `default_config_test.ts:336` passes unchanged.

Two options were rejected:

- **devc baseline carries the mount + re-add the `run/` mkdir.** Reverses
  `0d46b51`'s stated goal, re-creates directories on hosts that never use the
  bridge, and needs a tested invariant relaxed.
- **Every project declares its own mount.** Honors `0d46b51`, but devc
  zero-config users have no `devcontainer.json` to put it in — devc materializes
  one into a cache — so it is not workable for them without new mechanism.

## Validation

- [x] `deno task check` / `test` / `fmt --check` clean across `devc/` (274
      passed) and `devc-bridge/host/` (16 passed), plus `devc-bridge/client/`
- [x] `devcontainer-feature.json` validates against the **published Feature
      schema** with no errors — and the _old_ manifest is rejected by the same
      check (`'type=bind,…' is not of type 'object'`), so the assertion has teeth
- [x] Feature `install.sh` harnesses pass offline against a `file://` fixture:
      right asset per stubbed `uname -m`, checksum mismatch / missing asset /
      missing checksums entry / unsupported arch all abort with nothing installed,
      symlink resolves, `clientVersion` override reaches the URL
- [x] `devc/tests/default_config_test.ts:336` — the bundled default still declares
      nothing about the bridge — passes **unchanged**
- [x] The materialized config gains the mount only when opted in, as a string
      carrying `readonly`, with comments and sibling mounts intact
- [ ] (user, needs Docker) `devcontainer features test` passes: client present,
      executable, correct version
- [ ] (user, needs Docker) a **non-devc** project with the Feature line **and**
      the mount line: `devc-bridge ping test` → `pong`
- [ ] (user, needs Docker) the same project **without** the mount line: creation
      succeeds, and `devc-bridge ping` fails with the client's bind-mount message.
      This is the ergonomic cost of the plan, so confirm it reads well
- [ ] (user, needs Docker) a **zero-config devc** project that opts in via
      `devc.json`: works with no mount wiring, and `touch /run/devc-bridge/x`
      fails with `Read-only file system` — the injected `readonly` is real
- [ ] (user, needs Docker) a **zero-config devc** project that does _not_ opt in,
      on a host with no `~/.config/devc-bridge/`: still creates fine. The
      invariant `0d46b51` protects, and the one this plan most risks breaking
- [ ] (user, needs Docker) a **project-mode devc** project: no mount is injected,
      and adding it by hand to the project's own `devcontainer.json` works
- [ ] (user, needs Docker) restart the host bridge after a container has written
      the token file — the new token is **not** the container's value
- [ ] (user) with a deliberately **writable** token mount, replace
      `run/token` with a symlink to a throwaway host file and restart the bridge:
      the host file is unchanged and the token path is a regular file again. The
      regression test for decision 8; use a throwaway file, not `authorized_keys`
- [ ] (user, needs Docker) a **compose** devcontainer works end to end
- [ ] (user) dev override still works: `deno task build:client`, bind-mount the
      client dir over `/usr/local/share/devc-bridge/client`, confirm the local
      build shadows the downloaded one and survives a rebuild

## Relevant Files

- `features/devc-bridge/devcontainer-feature.json`, `install.sh`, `README.md`,
  `test/`
- `devc-bridge/host/token.ts`, `main.ts`, `config.ts`, `core.ts` (read only —
  the authoritative-token comparison at `:213` is what the plan relies on),
  `tests/`
- `devc-bridge/client/build-client.sh` — unchanged, but its "the typical user gets
  the same binary in the same place from the release installer" comment is now
  only true of the dev path
- `devc/default/devcontainer.json`, `devc/default/initialize-command.sh`,
  `devc/tests/default_config_test.ts`
- `install.sh`, `.github/workflows/release.yml`,
  `.github/workflows/publish-feature.yml` — read for the asset contract; not
  modified

## Follow-on (not this plan)

- **Drop `client` from the installer's default `DEVC_TOOLS`.** Once the Feature
  downloads its own client, `~/.config/devc-bridge/client` is only the dev
  override. Left out to keep the blast radius on one mechanism: changing installer
  defaults affects existing installs and deserves its own release note.
- **Pin the client by digest rather than version.** The checksum check trusts the
  release's own `checksums.txt` over TLS, as `install.sh` already does. A baked-in
  digest would be stronger, at the cost of a second thing moving in lockstep with
  the tag.
- **A `devc-bridge doctor` / status hint for the missing-mount case.** Decision 10
  accepts a runtime failure; if it proves confusing in practice, the host's
  `status` output is the place to explain it, not a build-time probe.
