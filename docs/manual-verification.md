# Manual verification

Everything here needs something the dev container does not have: GitHub Actions,
a Docker host, or a Mac. It is the residue of `devc-bridge-feature`,
`devc-bridge-tray-decouple` and `release-and-installer` — every other check in
those plans is automated and green.

**Do the sections in order.** Each one is cheap and rules out the failures that
would waste the next one. §1 is free and answers the most.

Baseline that is already green, for contrast — re-run before starting if the
tree has moved:

```sh
deno fmt --check                                            # repo root
(cd devc && deno task check && deno task test)                     # 269 tests
(cd devc-bridge/host && deno task check && deno task test)         # 10 tests
(cd devc-bridge/client && deno task check)
bash tests/install_test.sh install.sh                              # ALL PASS
bash tests/workflow_guards_test.sh                                 # ALL PASS
bash tests/features_test.sh                                        # ALL PASS
bash devc/tests/seed_link_test.sh features/agents/post-create.sh           # ALL PASS
bash devc/tests/devc_config_test.sh features/devc-config/post-create.sh    # all cases ok
bash devc/tests/bashrc_additions_test.sh features/devc-config/post-create.sh # all cases ok
bash features/devc-bridge/test/install_link_test.sh                # ALL PASS
# devc/tests/shell_dirs_test.sh has no copy left to run against — the shell-dirs Feature it
# used to test was superseded by bash-config (see .plans/plan.md's Completed table) and devc's
# own devc-core/default/scripts/bashrc-additions.sh is gone too (this plan). Pre-existing gap,
# not this plan's regression: devc/README.md's own fence-harness list already pointed at the
# same removed Feature before this plan touched it.
```

---

## 1. Workflow dry runs — no tag, nothing published

Both workflows have **never run**. Start from a branch — no tag exists yet.

```sh
gh workflow run release.yml
gh workflow run publish-feature.yml
gh run list --limit 5
```

`dry_run` defaults to true, and every publishing step requires it to be false
_and_ the ref to be the one that workflow publishes from — a `v*` tag for
`release.yml`, `refs/heads/main` for `publish-feature.yml`. Both conditions are
asserted by `tests/workflow_guards_test.sh`, which the `gate` job runs. That
matters here because a dispatch can target **any ref**: the ref check alone would
have published from a run whose own checkbox said dry run. With both in place, a
dry run against the ref itself is safe, which makes it the last rehearsal
available before §3 — worth doing once the tag exists.

Expected from `release.yml`:

- [ ] `gate` passes — the version guard prints three `0.1.0` lines and, off a
      tag, synthesizes `tag=v0.1.0`
- [ ] All four `build` jobs pass, **including `ubuntu-24.04-arm`**. This is the
      one runner whose availability to this repo is unverified. If it is not
      available: drop that matrix row and add
      `aarch64-unknown-linux-gnu` to the `ubuntu-24.04` job as a cross-build
      (already proven), losing only that asset's smoke test.
- [ ] Each build job's smoke test prints `devc 0.1.0` / `devc-bridge 0.1.0` —
      this is the first time the macOS binaries are ever _executed_, and the
      first run of the ad-hoc `codesign` step
- [ ] `publish` collects exactly these eight, and `diff` against the expected
      list is empty:

      devc-0.1.0-{x86_64,aarch64}-unknown-linux-gnu.tar.gz
      devc-0.1.0-{x86_64,aarch64}-apple-darwin.tar.gz
      devc-bridge-host-0.1.0-{x86_64,aarch64}-apple-darwin.tar.gz
      devc-bridge-client-0.1.0-{x86_64,aarch64}-unknown-linux-gnu.tar.gz

- [ ] `sha256sum -c checksums.txt` passes in the collect step
- [ ] The stamp step rewrites `DEVC_RELEASE_VERSION='v0.1.0'` and `sh -n` passes
- [ ] A `release-v0.1.0` artifact is uploaded; **no GitHub release exists**

Expected from `publish-feature.yml` — dispatch it **from `main`**, since that is
the ref it publishes from and the one a dry run has to rehearse:

- [ ] `discover` passes `bash tests/features_test.sh` and emits a matrix
      containing every id listed in `features/PUBLISH_ALLOWLIST.txt` (today:
      `devc-bridge`, `node-nvmrc`) — not every directory under `features/`;
      `shell-dirs` exists in the tree but is deliberately not allowlisted yet
- [ ] One `publish` job per Feature. `node-nvmrc`'s is **green**: it downloads
      nothing, pins no release, and packages on its own
- [ ] `devc-bridge`'s **fails on its release pin guard, naming `v0.1.0`** — no
      such release exists until §3. That is the guard working, not a blocker, and
      `fail-fast: false` must leave `node-nvmrc` green beside it. This is the
      acceptance test for one-job-per-Feature: a Feature that fetches nothing must
      not wait on a Feature that does
- [ ] Nothing is pushed to ghcr.io

---

## 2. The Feature, before it is published — Docker host

The `ghcr.io/...` reference cannot resolve until §3. Test the Feature by
**relative local path** instead; this needs no registry and no overlay.

Prerequisite, because a Feature cannot create its own mount sources:

```sh
devc-bridge start          # seeds ~/.config/devc-bridge/{run,client}
ls ~/.config/devc-bridge/  # must show run/ and client/
```

- [ ] **Scenario suite.** `bash features/devc-bridge/test/run-features-test.sh`
      — stages a `src/`+`test/` collection copy and runs
      `devcontainer features test`. Asserts: `/run/devc-bridge/token` populated,
      the client mount populated, **both mounts read-only** (a `sudo touch` must
      fail), `devc-bridge` on `PATH` and a symlink to the mounted client.
      The read-only assertions are the two findings the whole design rests on.
- [ ] **A real non-devc project.** A `devcontainer.json` with an `image` and:

      "features": { "./features/devc-bridge": {} }

      (relative to that file's folder). Bring it up, then `devc-bridge ping test`
      → `pong`. This is the point of the plan. `ping` needs the host bridge
      *running*, not merely installed — which is why the scenario suite does not
      assert it.
- [ ] **A host that never installed the bridge.** Same project on a machine with
      no `~/.config/devc-bridge/` fails the create with Docker's
      `bind source path does not exist`. Intended, and now identical for devc and
      non-devc projects — devc no longer pre-creates anything.

---

## 3. Tag a prerelease

**The version guard is strict equality.** To tag `v0.1.0-rc.1`, every one of
these must first read `0.1.0-rc.1`:

- `devc/help.ts` — `VERSION`
- `devc-bridge/host/version.ts` — `VERSION`
- `devc-bridge/client/version.ts` — `VERSION`

The three binaries are guarded by `release.yml`. **Nothing under `features/` is
part of a tag**: each Feature carries its own `version` and publishes from a push
to `main`, so leave them alone here. `devc-bridge`'s `DEVC_TOOLS_RELEASE` names
the release its client is downloaded from and stays `v0.1.0` — pointing it at a
prerelease would be a change to the Feature, not to this release.

- [ ] **Negative test first.** Push a tag that disagrees with `VERSION` and
      confirm `gate` fails before anything compiles, naming both values.
- [ ] Bump all of them, commit, `git tag v0.1.0-rc.1 && git push --tags`
- [ ] `release.yml` creates a release with all eight assets plus `checksums.txt`
      and `install.sh`, flagged **prerelease** (the `-` in the tag), so
      `releases/latest` still points at the last stable
- [ ] **On the release page the assets group by tool** — four `devc-`, then two
      `client`, then two `host`. This is the first place the naming scheme is
      actually visible; a dry run only produces workflow artifacts.
- [ ] The tag publishes **no Features** — `publish-feature.yml` does not run at
      all, since it triggers on a push to `main` under `features/`

### Then publish the Features — a separate trigger

Features are not tagged. `publish-feature.yml` fires on a push to `main` that
touches `features/`, one job per Feature, each at its own `version`. Note the
ordering the pin guard imposes: `devc-bridge` pins `DEVC_TOOLS_RELEASE='v0.1.0'`,
so its job stays red until a **stable** `v0.1.0` release exists — an `rc` tag is
not it. `node-nvmrc` has no such dependency and publishes immediately.

**A push to `main` is the real publish, not a rehearsal.** `dry_run` exists only
as a `workflow_dispatch` input, so on a push the `inputs` context is empty,
`!inputs.dry_run` is true, and the gated steps run. There is no separate
"publish for real" trigger — if you want a rehearsal, dispatch it with `dry_run`
checked _before_ merging.

- [x] Merge a `features/` change to `main` (or dispatch from `main` with
      `dry_run` **unchecked**). `node-nvmrc` publishes; `devc-bridge` fails its
      pin guard until `v0.1.0` is out — **confirmed on the first push, exactly
      this split**
- [x] **Write down which tags it actually created.** A `0.1.0` publish should
      yield `latest`/`0`/`0.1`/`0.1.0`, and `:0` is what `devc/README.md` and this
      repo's docs tell people to reference.
      **Measured against the registry: `["0","0.1","0.1.0","latest"]`** — all four,
      so the documented `:0` opt-in resolves. This closes the open question
      `devc-bridge-feature` left about whether `:0` would exist at all.
- [x] **Re-run with nothing changed.** The second run must print
      `Version 0.1.0 already exists, skipping` and push nothing. That idempotence
      is what makes publish-on-push safe, and it is pinned to
      `@devcontainers/cli@0.88.0` in the workflow — **re-check it whenever that
      pin moves.**
      **Confirmed.** A `features/`-touching commit that did _not_ bump
      `node-nvmrc`'s `version` re-ran the job green, and all four tags still
      resolve to the same manifest digest
      (`sha256:8bff2dc276623e88baeb8407e25279ab41c0a1a4fcc697633cc5dde76cc884b6`)
      as before the push. The digest is the check worth repeating rather than the
      log line: the skip check and the tag-advance logic are separate code paths,
      so a regression could in principle print the warning and still push. Compare
      digests, not just output.

  ```sh
  # unauthenticated; works because the package is public
  repo=devc-tools/node-nvmrc
  TOK=$(curl -s "https://ghcr.io/token?scope=repository:$repo:pull&service=ghcr.io" | jq -r .token)
  curl -sI -H "Authorization: Bearer $TOK" \
       -H "Accept: application/vnd.oci.image.manifest.v1+json" \
       "https://ghcr.io/v2/$repo/manifests/0.1.0" | grep -i docker-content-digest
  ```

  One thing that looks alarming on a skip run and is not: `Publishing collection
  metadata...` still appears. That push is unconditional, after the per-Feature
  loop, and is not the Feature being republished.
- [x] Make each package public in the repo's Packages settings, or an anonymous
      `devcontainer up` cannot pull it — **`node-nvmrc` verified public**: an
      unauthenticated `GET /v2/devc-tools/node-nvmrc/tags/list` returns
      200. Still to do for `devc-bridge` once it publishes.

---

## 4. Install from the prerelease — macOS

```sh
curl -fsSL https://github.com/devc-tools/devc-tools/releases/download/v0.1.0-rc.1/install.sh | sh
```

- [ ] `devc --version` → `devc 0.1.0-rc.1`; `devc-bridge --version` likewise
- [ ] Both land in `~/.local/bin`, **no sudo prompt at any point**
- [ ] The client is the **host-matched Linux** binary in
      `~/.config/devc-bridge/client/` — on an Apple Silicon Mac that is
      `aarch64-unknown-linux-gnu`, not the installer's own darwin triple. The
      easiest thing to get backwards, so check it explicitly:

      file ~/.config/devc-bridge/client/devc-bridge   # ELF ... ARM aarch64

- [ ] **Corrupted checksum aborts with nothing written.** Edit a line in a local
      copy of `checksums.txt`, serve it with `DEVC_RELEASE_BASE=file://...`, and
      confirm no binary is installed and no temp dir survives.
- [ ] **Re-running upgrades in place** rather than duplicating or failing
- [ ] `DEVC_INSTALL_DIR=/tmp/notonpath sh` warns and prints the `export` line
- [ ] `DEVC_TOOLS=bridge` on **Linux** fails with "macOS-only"

---

## 5. devc-bridge on macOS

The headless path is proven on Linux; these are the macOS-only parts.

- [ ] **The case the tray-decouple plan exists for.** From the _installed_
      binary, with no Deno anywhere:

      env -i HOME="$HOME" PATH=/usr/bin:/bin ~/.local/bin/devc-bridge start
      devc-bridge status        # running
      devc-bridge stop

- [ ] Daemon survives closing the terminal that started it (SIGHUP — this is
      what `309cffe` fixed; it is regression-tested, but never against real
      launchd-free macOS)
- [ ] **Real keepawake.** With a container pinging:
      `pmset -g assertions | grep -i caffeinate` shows a live assertion;
      `devc-bridge status` → `active: caffeinate`; it clears after
      `DEVC_BRIDGE_KEEPAWAKE_IDLE_MS` (default 300000) of silence
- [ ] `DEVC_BRIDGE_KEEPAWAKE_IDLE_MS=60000 devc-bridge restart` takes effect —
      inherited through the environment, with **no settings file written**
      anywhere (that mechanism is deleted)
- [ ] Container → host `ping` through the installed client returns `pong`
- [ ] A real Claude session keeps the Mac awake via the hooks in
      `devc-bridge/README.md` § Wiring into Claude Code hooks
- [ ] **Tray, opt-in, from source only:** `deno task dev` shows a menu-bar icon
      that tracks idle ○ / active ●. Never exercised — this container builds a
      `deno desktop` bundle but cannot execute one.

---

## 6. devc, with and without the bridge

The regression that matters most: devc must not depend on any of the above.

- [ ] **A devc container comes up on a host that has never heard of the bridge.**
      No `~/.config/devc-bridge/`, no host bridge installed, no Feature ref
      anywhere. This is what `b513800`/`0d46b51` restored and what the bundled
      default must never break again.
- [ ] **Opting in works.** In `~/.config/devc/devc.json` (all projects) or a
      project's `devc.json`:

      { "additionalFeatures": { "ghcr.io/devc-tools/features/devc-bridge:0": {} } }

      then `devc up` → `devc-bridge ping test` → `pong`, with no
      `Duplicate mount point` error.
- [ ] `devc mounts` shows both bridge mounts as **ro**
- [ ] `devc-bridge stop` works against the pidfile at its new path (moved out of
      `run/`, so a writable token mount can no longer feed it a PID)

---

## 7. The content-addressed zero-config cache — Docker host

From `devc-core-consumer-prep`. Everything about the cache that can be checked
without a daemon already is, and is green: the key's stability and sensitivity
(24 unit tests), hit/miss/lost-race, the `finalDir` rewrite, an 8-way
concurrency check, and the same key computed identically by a `deno compile`
binary reading its VFS and by the npm tarball under plain Node.

Three claims are left, and all three need a daemon.

**What not to expect.** Two copies of core whose bundled `default/` trees
differ produce different configs, so switching between them rebuilds — that is
correct, and content-addressing neither causes nor prevents it. What the design
buys is that neither copy's cache directory is rewritten _under_ the other, and
that no start can observe a half-written tree. Do not read a rebuild here as a
regression unless §7.1's count is wrong.

Signal for "did it rebuild?" is the container id: `devcontainer up` reuses the
container found by the `devcontainer.local_folder` label when the config still
matches, and recreates it when it does not. `devc up --json` reports that id.

### 7.1 The upgrade costs exactly one rebuild, then stops

```sh
P=/path/to/a/zero-config/project     # no .devcontainer/ of its own
old=/path/to/devc-from-main          # deno task build on main
new=/path/to/devc-from-this-branch

docker rm -f "$($old up "$P" --json | jq -r .containerId)" 2>/dev/null
rm -rf ~/.cache/devc

$old up "$P" --json | jq -r .containerId    # C0
$old up "$P" --json | jq -r .containerId    # C0  — steady state on main
$new up "$P" --json | jq -r .containerId    # C1  — the one-time rebuild
$new up "$P" --json | jq -r .containerId    # C1
$new up "$P" --json | jq -r .containerId    # C1
```

**Pass:** the id changes exactly once, at the `$old` → `$new` switch, and is
stable on either side. A second change means the key is not stable across runs
— the bug this whole design exists to prevent.

**Expect an orphan, not a replacement.** The devcontainer CLI keys a container on
`devcontainer.local_folder` _and_ `devcontainer.config_file`; when it finds a
`local_folder` match whose `config_file` differs it builds a new container and
leaves the old one — it only ever removes a container carrying no `config_file`
label at all. So C0 is still there after the switch, holding the
workspace-derived name (which is why `up` warns that it could not rename C1).
That is the CLI's behaviour, not a leak in the cache change. Clear it once:

```sh
docker rm -f C0 && $new up "$P"        # C1 then takes the name
```

### 7.2 Steady state writes nothing

```sh
ls -1 ~/.cache/devc/                                  # exactly one default-<key>/
before=$(stat -c %Y ~/.cache/devc/default-*/devcontainer.json)
$new up "$P" >/dev/null && $new exec "$P" -- true
after=$(stat -c %Y ~/.cache/devc/default-*/devcontainer.json)
[ "$before" = "$after" ] && echo PASS || echo "FAIL: rewritten on a hit"
ls -d ~/.cache/devc/.tmp-* 2>/dev/null && echo "FAIL: staging dir leaked"
```

**Pass:** mtime unchanged across both an `up` and an `exec` (which also calls
`startContainer`), and no `.tmp-` residue. On main this mtime advances every
time — that contrast is the point.

### 7.3 The race is gone

The one real correctness win. On main, the unconditional `rm -rf` + copy can
land while another process's `devcontainer up` is reading the same config.

```sh
rm -rf ~/.cache/devc
for i in $(seq 8); do $new up "$P" --json & done; wait
ls -1 ~/.cache/devc/                       # one default-<key>/, no .tmp-*
```

**Pass:** every invocation exits 0, all report the same container id, one keyed
directory, no staging residue.

Then the same loop against `$old`. Its failure is a race and may not reproduce
on the first try — widen the window by inserting a sleep between the `rm -rf`
and the copy in a scratch build of `materializeDefaultConfig` if you want to see
it fail deterministically. A clean run of `$old` is **not** evidence the race
does not exist; only a failure is informative.

### 7.4 Two projects, concurrently

```sh
# P1 opts into the bridge Feature via .devc/devc.json; P2 does not.
for i in $(seq 4); do $new up "$P1" >/dev/null & $new up "$P2" >/dev/null & done; wait
ls -1 ~/.cache/devc/projects/              # one dir per project, both intact
```

**Pass:** each project has its own `projects/<key>/devcontainer.json` and its
container reflects its own overlay. The bridge opt-in no longer varies the
`default-<key>/` tree at all — it is a merge layer now (see §11), so that
directory depends only on the devc version and your `templates/`.

### 7.5 Round trip, unchanged

`up` → `exec` → `status` → `mounts` → `down` against a real project, plus the
same against a project that has its own `.devcontainer/` (which never touches
the cache at all). Byte-identical output vs. `$old` was already verified without
a daemon, apart from `spawn docker ENOENT` stack-trace line numbers.

---

## 8. `devc-inject-project-hook` — Docker host

From `.plans/archived/devc-inject-project-hook.md`. Everything before `devcontainer up`
actually runs is exercised by `deno task test`; these are the items that need a
real daemon.

- [ ] **Project mode, the case this plan exists for.** A repo with its own
      `.devcontainer/devcontainer.json` that has never heard of devc, plus an
      executable `.devc/devc-post-create.sh`. `devc up` runs it. The project's
      `.devcontainer/` is byte-identical afterwards (`git diff` empty, or a
      `diff` against a pre-`up` copy).
- [ ] **Zero-config.** The hook still runs, exactly once — have it `>>` append
      rather than `>` touch a marker file, so a double-run would be visible.
- [ ] **Ordering.** A hook that records `git config --get user.email` and
      whether `~/.claude` exists sees both already set up — proving devc's
      baseline precedes the devc-config Feature's `postCreateCommand`.
      **Superseded mechanism, same property:** at the time this item was
      written the baseline ran via a top-level `onCreateCommand`
      (agents-setup, git-setup, bashrc-additions); `devc-swap-baseline-features`
      (§9 below) replaced that with `agents`/`git-container-config` Features
      ordered ahead of `devc-config` via `installsAfter`. This item still
      measures the same guarantee, just not the mechanism named here.
- [ ] **The double-install case.** A project declaring
      `"ghcr.io/devc-tools/features/devc-config:0.1.0": {}` in its own
      `features` while devc injects `:0.1.0`. The hook runs **once**, and
      `devcontainer up`'s output installs exactly one `devc-config`. (This is
      the case that proves `withBaselineFeatures`' name-match skip is doing
      real work — the pinned CLI dedupes `--additional-features` against a
      config's `features` by exact id string, so two different tags would
      otherwise both install.)
- [ ] **`baselineFeatures: false`.** Set in a `devc.json` overlay — the hook
      does not run, and `devcontainer up`'s verbose output shows no
      `devc-config` install at all.
- [ ] **`devc init` output does NOT run this without devc — confirm the
      corrected design, not the original one.** Scaffold a project with
      `devc init`, then bring it up with a plain `devcontainer up` (no `devc`
      on `PATH`). The bundled `devcontainer.json` no longer declares
      `devc-config` itself (a deliberate correction — see
      `devc-core/overlay.ts`'s `DEVC_CONFIG_FEATURE` doc comment), so a
      `.devc/devc-post-create.sh` in that scaffolded project should **not**
      run. This is the one Feature-delivery invariant this repo's other
      Features hold and this one deliberately does not; the test is here so a
      future change that quietly re-adds the static entry gets caught.
- [ ] **Does an existing container pick this up?** Bring up a project on the
      version of devc from before this change, then `devc up` again on this
      branch with no `--rebuild`. Note whether the container recreates on its
      own (a merged config gaining a Feature may or may not force it) — if not,
      that is a README line (`devc up --rebuild` needed once), not a bug.
- [ ] **Rebuild churn on first upgrade.** Confirm the image gains the
      `devc-config` Feature layer exactly once — a second `up` should not
      re-pull or re-build — and that `ensureDefaultConfig`'s content-addressed
      cache settles on one new key rather than thrashing.
- [ ] **Offline builds.** A project-mode repo whose `devcontainer.json`
      declares no Features today now pulls `devc-config` from ghcr.io at
      build time. Confirm a cached image does not re-pull, and that
      `baselineFeatures: false` is a working escape hatch for an air-gapped
      build.

## 9. `devc-swap-baseline-features` — Docker host

From `.plans/archived/devc-swap-baseline-features.md`. `agents-setup.sh`, `git-setup.sh`
and `bashrc-additions.sh` are gone from `devc-core/default/`; the baseline is
now delivered by the `agents`/`git-container-config` Features (declared
statically in the bundled `devcontainer.json`) plus `devc-config`'s second
fence (injected dynamically, same as before). Everything before
`devcontainer up` actually runs is exercised by `deno task test` and the shell
harnesses in §0's baseline block; these are the items that need a real daemon.

- [ ] **`agents` derives `~/.claude` as `/home/vscode/.claude`** for
      `mcr.microsoft.com/devcontainers/base:noble` + the `vscode` remote user
      at `postCreateCommand` time — the path devc's `claude-code-config-*`
      volume already mounts at. `0.2.0` derives this from `$HOME` at create
      time rather than baking it, so a mismatch is now visible in the
      container (an unlinked `~/.claude.json`, or files landing outside the
      volume) rather than silent.
- [ ] **Zero-config end-to-end.** `devc up` on a project with no config of its
      own. `~/.claude` seeded and owned correctly, `~/.claude.json`
      symlinked, git identity/LFS/`safe.directory` all set — same observable
      outcome as before this plan, now delivered by two Features instead of
      two scripts.
- [ ] **The `installsAfter` ordering claim, for real.** A hook (via
      `devc-config`, reached through the project's own `devc-post-create.sh`)
      that checks `git config --get user.email` and whether `~/.claude` is
      populated sees both already set up. Direct successor to §8's "Ordering"
      item, same property, different mechanism (`installsAfter` rather than a
      top-level `onCreateCommand`).
- [ ] **`devc init` output still works standalone.** Scaffold a project, bring
      it up with a plain `devcontainer up` (no `devc` on `PATH`) —
      `agents`/`git-container-config` still provision correctly, since they
      are declared in the scaffolded config itself, not injected. (Unlike
      `devc-config`, which still requires `devc` — see §8.)
- [ ] **The bashrc-additions reach extension.** A genuinely project-owned
      `.devcontainer/devcontainer.json` (devc never wrote it), no `devc.json`
      overlay. `devc up` → the container's interactive shell carries the
      custom `PS1` and title behavior, confirming devc's prompt/title
      customization now reaches project mode for the first time (previously
      only zero-config and `devc init` output got it).
- [ ] **One-time re-login per workspace.** An existing workspace container
      from before this change, re-created on this branch: Claude Code prompts
      to log in again once (the `claude-json-*` volume's contents do not
      migrate into the `.claude` volume), and stays logged in on subsequent
      creates. `docker volume ls` still shows the orphaned `claude-json-*`
      volume — `docker volume prune` removes it, not this plan's automation.
- [ ] **Rebuild churn**, same shape as §8's: confirm this is a one-time
      image-layer change per project, not a recurring cost.
- [ ] **Copilot CLI lands in the same place.** For an existing image built
      before this change, confirm `~/.local/bin/copilot` (installed by the
      `agents` Feature's `install.sh` now, not the Dockerfile's own `RUN`
      step) is not orphaned — same install script, same target, but worth
      confirming against a real rebuild rather than assumed.

## 10. `herdr-agent-sidecar` — Docker + Herdr host

From `.plans/herdr-agent-sidecar.md`. Everything offline is covered by
`deno task test` in §0's baseline block (`herdr_test.ts`) — these items all
need a real Herdr pane driving a real `docker exec`.

- [ ] **The main case.** From a Herdr pane, `devc attach` on a project whose
      container has Claude: at the bash prompt `herdr agent list` shows **no
      agent** for that pane; launch `claude` and within ~5s the pane shows
      `agent=claude` with a real status; `herdr agent explain <pane>` names a
      matched rule (not only `default_known_agent_idle_fallback`) once Claude
      is working; exit Claude and the agent disappears again.
- [ ] **Rotation.** In the same attach, run a second agent (or
      `DEVC_HERDR_AGENT` unset plus any two table entries from `herdr.ts`)
      and confirm the pane follows the switch without a reattach.
- [ ] **Deference.** `HERDR_AGENT=claude devc attach` behaves exactly as it
      does today and devc spawns **no** sidecar — check with
      `pgrep -fa __herdr-sidecar`. The regression guard for the undefined
      double-assertion case.
- [ ] **Off switch.** `DEVC_HERDR_AGENT=off devc attach` spawns neither
      watcher nor sidecar; `DEVC_HERDR_AGENT=codex devc attach` pins `codex`
      regardless of what runs in the container, and no watcher `docker exec`
      appears.
- [ ] **No leak.** After the attach exits — including after `ctrl+c` and
      after killing devc with `SIGKILL` — no `__herdr-sidecar` process
      remains on the host and no watcher `sh` remains in the container
      (`docker exec <c> ps -eo args= | grep DEVC_HERDR_WATCH`). Both halves
      have their own mechanism (stdin EOF, `/proc` disappearance); test both.
- [ ] **The pane stays clean.** Attach, run a full-screen agent, and confirm
      no stray output from either child lands in the TUI, including when the
      container is stopped underneath a live attach.
- [ ] **`HERDR_ENV` unset** — `devc attach` spawns exactly one `docker exec`,
      as it does today. The feature is invisible off-Herdr (no Herdr needed
      for this one — it just needs confirming on a normal terminal).

---

## 11. `devc-merged-config` — Docker host

From `.plans/archived/devc-merged-config.md`. Everything that does not need a
daemon is automated and green (275 core tests, 114 devc tests); these are the
claims that were read out of `@devcontainers/cli` 0.88.0's minified bundle
rather than observed against a running Docker.

Set up two projects: `$PROJ` with its own `.devcontainer/devcontainer.json`, and
`$ZERO` with none. `devc up --print-config <path>` prints the merged config
without starting anything — use it to see what each check is actually running.

- [ ] **The load-bearing one: what `--override-config` records as the config
      path.** Every other claim in this section rests on it, and it was read out
      of the minified bundle rather than observed: the CLI is supposed to take
      the config's _content_ from the file you point at while still recording
      the project's own `.devcontainer/devcontainer.json` as `configFilePath`.

      Start `$PROJ` on `main`, note `docker inspect --format '{{index
      .Config.Labels "devcontainer.config_file"}}' <container>`. Then start it
      on this branch. **Pass:** the label is unchanged — it points at
      `$PROJ/.devcontainer/devcontainer.json`, not at anything under
      `~/.cache/devc/` — and the _same_ container is reused.

      The reuse is a symptom, not the point (one rebuild would cost nothing).
      `configFilePath` is also what the CLI resolves `build.dockerfile`,
      `build.context`, `dockerComposeFile` and local `./features/…` against, so
      if the label is the cache path instead, then: an ordinary project with a
      relative `"dockerfile": "Dockerfile"` resolves it into
      `~/.cache/devc/projects/<key>/` and **fails to build** (the next check);
      VS Code stops sharing the container, since it looks the container up by
      this exact label; and the project/zero-config split in `buildUpArgs` is
      pointless — `--override-config` would just be `--config` spelled
      differently, and project mode would need its paths absolutized too.

      Also confirm the overlay actually took effect (`docker inspect` shows its
      mounts). If the CLI ignored the override file's content and re-read the
      project's own config, the label would look right while the overlay
      silently did nothing.
- [ ] **Relative paths still resolve against the project.** Give `$PROJ` a
      `"build": { "dockerfile": "Dockerfile", "context": ".." }` — context at
      the project root, the common shape — and confirm it builds. The merged
      config lives in `~/.cache/devc/projects/<key>/` and leaves those values
      relative, so this only works if the CLI resolves them against the
      project's own config path.
- [ ] **A read-only overlay mount is genuinely read-only.** Add
      `"type=bind,source=$HOME/ref,target=/reference,readonly"` to `$PROJ`'s
      `devc.json`, rebuild, then `docker exec -u 0 <container> touch
      /reference/x`. **Pass:** it fails. This is the capability the whole change
      exists for, and container-root is the bar that matters — a real `ro` bind
      holds against it, permission-based hiding does not.
- [ ] **Feature install order survives the merge.** `features` is merged
      directly now instead of passed as `--additional-features`, which changes
      key order. Confirm from the build log that `devc-config` still installs
      _after_ `agents` and `git-container-config` (`installsAfter` should still
      govern, but the round-robin fallback is order-sensitive).
- [ ] **The bridge token mount reaches project mode.** With the host bridge
      seeded (`devc-bridge start` once), add
      `"features": { "ghcr.io/devc-tools/features/devc-bridge:0": {} }` to
      `$PROJ`'s `devc.json` and nothing to its `devcontainer.json`. **Pass:**
      `devc mounts` shows `/run/devc-bridge`, read-only, and the client works
      from inside. On main this required hand-copying the mount line into the
      project's own config.
- [ ] **A hand-written token mount still wins.** Same, but with a
      `/run/devc-bridge` mount already in `$PROJ`'s `devcontainer.json`.
      **Pass:** exactly one such mount in `docker inspect`, and it is the
      hand-written one (the merge dedupes by target, and devc's layer is
      lowest). Two would be Docker's `Duplicate mount point`.
- [ ] **Zero-config comes up, and only recreates once.** `devc up $ZERO`.
      **Pass:** it builds and runs — the merged config carries absolute
      `build.dockerfile`/`context` into `~/.cache/devc/default-<key>/`. Its
      `config_file` label moves from the old `default-<key>/` path to
      `projects/<key>/`, so expect exactly one recreate on the first run after
      the upgrade, and none after. The old container is stranded by the CLI's
      own lookup and needs `docker rm` — that is the accepted no-migration cost.
- [ ] **Compose still works.** A `dockerComposeFile` project comes up. Record
      what happens to a `readonly` overlay mount: the CLI rewrites `mounts` into
      its generated compose file and is expected to drop the field, which the
      merge does not fix.
- [ ] **VS Code interop.** "Reopen in Container" on the devc-started `$PROJ`
      container attaches to the _same_ container rather than building its own.
      Follows from the first check, but worth seeing.

## 12. Mount substitution inside a Feature's `mounts` — Docker host

From `mount-substitution-spike`. Answers
`.plans/design/devc-feature-split.md` open question 2: which
`devcontainer.json` variables substitute inside a Feature's own `mounts`
array. Measured once with `@devcontainers/cli 0.89.0`; re-run this after a CLI
upgrade to confirm the answer still holds.

```sh
devcontainer up --workspace-folder tests/fixtures/mount-substitution
docker volume ls | grep volspike
```

Expected: three volumes exist —

- `volspike-id-<opaque id>` (`${devcontainerId}`)
- `volspike-base-mount-substitution` (`${localWorkspaceFolderBasename}`)
- `volspike-target` (`${containerWorkspaceFolder}` substitutes in the mount
  *target*, not the source — confirm with
  `devcontainer exec --workspace-folder tests/fixtures/mount-substitution findmnt | grep volspike`
  and check the target lands under the workspace folder)

Clean up after: `docker rm -f` the container (`devcontainer up`'s output
prints its id), then `docker volume rm` the three volumes above, so a re-run
starts from nothing.

---

## 13. `podman-as-docker` — the privilege matrix, and the five Docker scenarios

From `feature-podman-as-docker`. Answers the plan's § Step 1 — whether
`CAP_SYS_ADMIN` alone is enough to run rootless Podman inside an unprivileged
devcontainer — and records the full Docker-scenario run. All of it was
executed once, on a host with Docker Desktop, against both podman 4.9.3
(`mcr.microsoft.com/devcontainers/base:ubuntu-24.04`) and podman 5.7.0 (the
floating `:ubuntu` tag, which resolved to 26.04 at the time). Re-run after a
podman major-version bump on either base, or after a Docker/runc change to
`systempaths` semantics.

### 13.1 The privilege matrix (no devcontainer needed — plain `docker run` reproduces it)

```sh
docker run -d --name podman-spike --cap-add=SYS_ADMIN \
  --security-opt systempaths=unconfined \
  -v podman-spike-storage:/home/vscode/.local/share/containers \
  mcr.microsoft.com/devcontainers/base:ubuntu-24.04 sleep infinity
docker exec podman-spike bash -lc \
  'chown -R vscode:vscode /home/vscode/.local/share/containers &&
   apt-get update -qq && apt-get install -y -qq podman podman-docker uidmap slirp4netns fuse-overlayfs'
docker exec -u vscode podman-spike bash -lc \
  'podman info --format "{{.Store.GraphDriverName}}" &&
   podman run --rm --network=host docker.io/library/alpine true'
docker rm -f podman-spike; docker volume rm podman-spike-storage
```

Expected: `overlay` (native, no `/dev/fuse` anywhere in the command above), and
the `podman run` exits 0.

| Question | Answer |
| --- | --- |
| `SYS_ADMIN` alone? | No — clears the `newuidmap` wall completely, but every run then fails on Docker's default read-only masking of `/proc/sys` until `securityOpt: ["systempaths=unconfined"]` is also added. `CAP_NET_ADMIN` was tried too and made no difference either way. |
| `/dev/fuse` needed for `overlay`? | No, at all — not tried in the command above and `podman info` still reports native `overlay`. The dividing line is the graphroot's *backing filesystem*: real (the `-v podman-spike-storage:…` above) → native overlay works with zero devices; overlay-on-overlay (drop the `-v`) → every run fails with `exec ...: Invalid argument`, and forcing `mount_program = fuse-overlayfs` with `--device=/dev/fuse` does not rescue that case either (tried, same failure). |
| `/dev/net/tun` needed? | Only for the default userspace network backend (`slirp4netns` on podman 4.9.3, `pasta` on 5.7.0). `--network=host` in the command above needs no device and works once `systempaths=unconfined` is set. |
| Read-only `/sys/fs/cgroup`? | Not a hard problem rootless — `conmon` logs a warning (`failed to add … to cgroupfs sandbox cgroup`) and the container still starts. |

### 13.2 The five Docker scenarios

```sh
bash features/podman-as-docker/test/run-features-test.sh \
  --base-image mcr.microsoft.com/devcontainers/base:ubuntu-24.04 --skip-scenarios
bash features/podman-as-docker/test/run-features-test.sh --skip-autogenerated
```

Expected: `Test Passed!` for the default scenario (`docker run --rm alpine true`
with **zero** `runArgs` — the strongest claim this Feature makes), and
`✅ Passed` for all four of `with_tun`, `with_socket`, `with_volume`, `no_shim`.
All five ran green on both invocations above at the time this was written — but
see §13.3: that was on Docker Desktop, and the same run on native Linux Docker
initially **failed**, which is the reason §13.3 and the CI workflow below exist.

### 13.3 The gap this section's own testing missed, and how it was found

§13.1's matrix and §13.2's scenario run were both done on Docker Desktop's
LinuxKit VM, which — measured back in § Measured, the plan's very first section —
already runs with `Seccomp: 0` and no AppArmor profile applied. That is not the
normal state of a Linux Docker host, and the gap was invisible until
[`.github/workflows/test-podman-as-docker.yml`](../.github/workflows/test-podman-as-docker.yml)
ran the same five scenarios on a GitHub-hosted `ubuntu-latest` runner (a real
Linux Docker Engine host, `docker-default` seccomp **and** AppArmor both
enforced — confirmed in the run's own log before the scenarios started):

```
Seccomp:	2
AppArmor: docker-default (enforce)
...
Error: mount /var/lib/devc-features/podman-as-docker/storage/overlay:/var/lib/devc-features/podman-as-docker/storage/overlay, flags: 0x1000: permission denied
```

The `docker-default` AppArmor profile carries a blanket `deny mount,` rule — no
exception for `CAP_SYS_ADMIN` — which blocked the self-bind-mount Podman's rootless
overlay setup does as part of making the graphroot a private mount point. Adding
`securityOpt: ["apparmor=unconfined"]` (0.1.1) cleared it — but re-running surfaced
a **second** wall immediately behind the first:

```
Error: crun: create keyring `ecc71c50b11e9b53aced7f06162c7b93f8a56ce67468023d05efdb94a867e87d`: Operation not permitted: OCI permission denied
```

`crun` creates a session keyring for the container via `keyctl()`, which the
`docker-default` **seccomp** profile blocks. So the 0.1.1 conclusion above —
"`seccomp=unconfined` was not needed" — was wrong, reached by stopping at the
first wall cleared rather than testing past it: `mount`/`umount2` genuinely are
permitted by the default seccomp profile, but `keyctl()` is not, and Podman needs
both. `securityOpt: ["seccomp=unconfined"]` (0.1.2) cleared this one too.

With both privilege walls down, a **third**, unrelated bug then surfaced:

```
/usr/local/share/devc-features/podman-as-docker/post-start.sh: line 61: /run/devc-features/podman-as-docker/service.log: Permission denied
podman-as-docker: API socket did not appear at /run/devc-features/podman-as-docker/podman.sock after starting the service
```

Not a privilege gap — `SOCKET_DIR` is chowned to the remote user once at build
time, but the devcontainer CLI's UID-remap step (the normal case on a Linux host
whose UID differs from the image's baked-in one; this GitHub runner, not Docker
Desktop) renumbers the remote user *after* the image builds and repairs only
`$HOME`, orphaning `/run/devc-features/podman-as-docker`. `post-start.sh` (0.1.2)
now repairs it, same shape as the repair `node-nvmrc`'s `post-create.sh` already
does for its own directory.

All five scenarios pass on the same runner as of 0.1.2, confirmed by re-running
after each fix rather than assumed. Reproduce with the CI workflow
(`gh workflow run test-podman-as-docker.yml`, or the Actions tab) — it needs a real
Linux Docker host, which is exactly why it runs in CI rather than being folded
into §13.1's `docker run` matrix.

The default scenario needs the explicit `--base-image` — the test command's own
default, `ubuntu:focal` (20.04), predates Ubuntu's own `podman` package and
fails the install outright, correctly (a failed install fails the build, same
as every other Feature here).
