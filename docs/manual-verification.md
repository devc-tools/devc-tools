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

From `mount-substitution-spike`, extended by `declared-volume-spike` (M1, M2)
and by `rootless-remote-user` (M5).
Answers `.plans/design/devc-feature-split.md` open question 2 and
`feature-declared-volumes`'s Step 1: which `devcontainer.json` variables
substitute inside a Feature's own `mounts` array. Measured once with
`@devcontainers/cli 0.89.0`; re-run this after a CLI upgrade to confirm the
answer still holds.

The fixture (`tests/fixtures/mount-substitution/`) declares six mounts and
one Feature option:

```jsonc
"mounts": [
  { "type": "volume", "source": "volspike-id-${devcontainerId}", "target": "/var/lib/volspike-id" },
  { "type": "volume", "source": "volspike-base-${localWorkspaceFolderBasename}", "target": "/var/lib/volspike-base" },
  { "type": "volume", "source": "volspike-target", "target": "${containerWorkspaceFolder}/.volspike-target" },
  { "type": "volume", "source": "volspike-home", "target": "${containerEnv:HOME}/.volspike-home" },
  { "type": "volume", "source": "volspike-opt-${probe}", "target": "/var/lib/volspike-opt" },
  { "type": "volume", "source": "volspike-localenv", "target": "${localEnv:VOLSPIKE_HOME:/var/lib/volspike-localenv-default}/.volspike-localenv" }
],
"options": { "probe": { "type": "string", "default": "volspike-opt-default" } }
```

**Running `devcontainer up` against the fixture as committed fails outright** —
this is itself the M1 answer, not a broken fixture. The CLI logs the fully
resolved `docker run` command before invoking it, so a single failed attempt
is enough to read every variable's substitution at once:

```sh
devcontainer up --workspace-folder tests/fixtures/mount-substitution
```

The printed command line contains (abbreviated to the `--mount` flags):

```
--mount type=volume,src=volspike-id-13gra4npo69h23i10h25gq869gjtjet092p9ushcd11d6sdutp0c,dst=/var/lib/volspike-id
--mount type=volume,src=volspike-base-mount-substitution,dst=/var/lib/volspike-base
--mount type=volume,src=volspike-target,dst=/workspaces/devc-tools/tests/fixtures/mount-substitution/.volspike-target
--mount type=volume,src=volspike-home,dst=${containerEnv:HOME}/.volspike-home
--mount type=volume,src=volspike-opt-${probe},dst=/var/lib/volspike-opt
--mount type=volume,src=volspike-localenv,dst=/var/lib/volspike-localenv-default/.volspike-localenv
```

then Docker rejects it before creating anything (`docker volume ls | grep
volspike` afterward shows nothing — no container, no volumes):

```
docker: Error response from daemon: invalid mount config for type "volume": invalid mount path: '${containerEnv:HOME}/.volspike-home' mount path must be absolute.
```

| Variable                                                   | Where          | Substitutes? | Evidence                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | -------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `${devcontainerId}`                                        | mount _source_ | yes          | `volspike-id-13gra4npo69h23i10h25gq869gjtjet092p9ushcd11d6sdutp0c`                                                                                                                                                                                                                                                                                          |
| `${localWorkspaceFolderBasename}`                          | mount _source_ | yes          | `volspike-base-mount-substitution`                                                                                                                                                                                                                                                                                                                          |
| `${containerWorkspaceFolder}`                              | mount _target_ | yes          | `dst=/workspaces/devc-tools/tests/fixtures/mount-substitution/.volspike-target`                                                                                                                                                                                                                                                                             |
| **M1** `${containerEnv:HOME}`                              | mount _target_ | **no**       | literal `dst=${containerEnv:HOME}/.volspike-home` — and unlike a merely-cosmetic miss, Docker's mount-path validator then refuses it outright (`mount path must be absolute`), so this is **fatal to `devcontainer up`**, not just a wrongly-placed directory                                                                                               |
| **M2** a Feature option (`${probe}`, set to `SUBSTITUTED`) | mount _source_ | **no**       | literal `src=volspike-opt-${probe}` — also fatal on its own: with M1's mount removed so the CLI reaches this one, Docker's _volume-name_ validator (a separate check from the path one above) rejects it too: `create volspike-opt-${probe}: "volspike-opt-${probe}" includes invalid characters for a local volume name`                                   |
| **M5** `${localEnv:VAR:default}`                           | mount _target_ | **yes**      | `dst=/var/lib/volspike-localenv-default/.volspike-localenv` with `VOLSPIKE_HOME` unset (the `:default` fallback is applied), and `dst=/opt/volspike-set/.volspike-localenv` with `VOLSPIKE_HOME=/opt/volspike-set`. Measured twice on two hosts — Docker Desktop/macOS 29.7.2 and rootless Docker 29.7.2 on Ubuntu 24.04 — both `@devcontainers/cli 0.89.0` |

### What M1 does **not** imply

M1's "no" is about `${containerEnv:…}` specifically, and does not generalise to
"a Feature's mounts cannot follow the remote user's home". M5 shows the
pre-container resolver does handle `${localEnv:…}`, including its `:default`
fallback — so a Feature's own mount target _can_ be pointed at the remote
user's home, provided the value is supplied **from the host** rather than named
by a built-in variable. `${containerEnv:HOME}` fails because container env does
not exist yet when mounts are consumed at `docker run`; a `localEnv` value is
known before that.

This is what lets `features/agents` stop hardcoding `/home/vscode/.claude`.
See `rootless-remote-user` § Step 2.

M5 needs two runs, since the point is that both the fallback and the supplied
value work:

```sh
devcontainer up --workspace-folder tests/fixtures/mount-substitution
VOLSPIKE_HOME=/opt/volspike-set devcontainer up --workspace-folder tests/fixtures/mount-substitution
```

Read `dst=` on the `volspike-localenv` mount in each printed command line. Both
runs still die on M1's mount, which is expected and is not the M5 answer.

To reconfirm the three non-M1/M2 answers (or M2's error specifically) against
a **running** container, comment out mounts 4 and/or 5 in
`.devcontainer/volspike/devcontainer-feature.json`, `devcontainer up`, then:

```sh
docker volume ls | grep volspike
devcontainer exec --workspace-folder tests/fixtures/mount-substitution findmnt | grep volspike
```

Expected with mounts 4 and 5 both removed: four volumes exist —
`volspike-id-<opaque id>`, `volspike-base-mount-substitution`,
`volspike-target` (target lands under the workspace folder — confirmed by
`findmnt` above) and `volspike-localenv`. Restore the fixture to all six
mounts afterward; that is the form it is committed in.

Clean up after any run: `docker rm -f` the container if one started
(`devcontainer up`'s output prints its id), then `docker volume rm` whatever
`docker volume ls | grep volspike` still shows, so a re-run starts from
nothing.

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

| Question                          | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SYS_ADMIN` alone?                | No — clears the `newuidmap` wall completely, but every run then fails on Docker's default read-only masking of `/proc/sys` until `securityOpt: ["systempaths=unconfined"]` is also added. `CAP_NET_ADMIN` was tried too and made no difference either way.                                                                                                                                                                                                             |
| `/dev/fuse` needed for `overlay`? | No, at all — not tried in the command above and `podman info` still reports native `overlay`. The dividing line is the graphroot's _backing filesystem_: real (the `-v podman-spike-storage:…` above) → native overlay works with zero devices; overlay-on-overlay (drop the `-v`) → every run fails with `exec ...: Invalid argument`, and forcing `mount_program = fuse-overlayfs` with `--device=/dev/fuse` does not rescue that case either (tried, same failure). |
| `/dev/net/tun` needed?            | Only for the default userspace network backend (`slirp4netns` on podman 4.9.3, `pasta` on 5.7.0). `--network=host` in the command above needs no device and works once `systempaths=unconfined` is set.                                                                                                                                                                                                                                                                |
| Read-only `/sys/fs/cgroup`?       | Not a hard problem rootless — `conmon` logs a warning (`failed to add … to cgroupfs sandbox cgroup`) and the container still starts.                                                                                                                                                                                                                                                                                                                                   |

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
Desktop) renumbers the remote user _after_ the image builds and repairs only
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

---

### 13.4 Under **rootless** Docker — the four blockers, all fixable

From `rootless-remote-user` § Step 4. Measured on Ubuntu 24.04 / rootless Docker 29.7.2 /
podman 4.9.3 / `@devcontainers/cli` 0.89.0. Everything in 13.1–13.3 above was measured on a
**rootful** daemon; this is the same Feature on a rootless one, where the devcontainer is already
inside a user namespace and podman would be a second.

**Read 13.5 for the working configuration.** As shipped, the Feature installs and configures
correctly but cannot run a nested container; the scenario results below are the as-shipped
state, and the four blockers that follow are each resolved in 13.5.

| Scenario      | Passed                                                                                     | Failed                                  |
| ------------- | ------------------------------------------------------------------------------------------ | --------------------------------------- |
| `no_shim`     | podman present, docker absent, podman-docker not installed                                 | "podman itself still works"             |
| `with_socket` | —                                                                                          | the socket never comes up               |
| `with_volume` | graphroot is a mount point, ownership repair, `storage.conf` points at it, chose `overlay` | `docker pull` writes into the graphroot |
| `with_tun`    | `netns=private`, `slirp4netns`, `/dev/net/tun` present, container gets its own netns       | real egress through it                  |

13.1's privilege matrix reproduces this with no devcontainer, and separates three blockers:

1. **subuid range outside the outer namespace.** Rootless Docker gives the container a `uid_map`
   of `0→1000 (1)` and `1→100000 (65536)` — only ids 0–65536 exist inside. The Feature allocates
   `vscode` subuids at 100000–165535, which the parent namespace does not own:

   ```
   running `/usr/bin/newuidmap 1747 0 1000 1 1 100000 65536`:
     newuidmap: write to uid_map failed: Operation not permitted
   Error: cannot set up namespace using "/usr/bin/newuidmap": exit status 1
   ```

   **Fixable.** A range inside 0–65536 that excludes the user's own uid works — `10000–60000`
   verified; a range spanning uid 1000 is rejected outright (`the specified mapping 1:60000 in
   "/etc/subuid" includes the user UID`). With it, `podman info` reports `overlay` and
   `podman unshare` succeeds.

2. **crun cannot create its keyring** — `crun: create keyring …: Operation not permitted`.
   **Fixable** with `[containers] keyring = false` in `~/.config/containers/containers.conf`
   (confirmed read: the error changes rather than repeating).

3. **`crun: pivot_root: Operation not permitted`.** **Fixable**, but not by anything in the
   storage layer — identical on `overlay` and `vfs`, which is what first made this look
   fundamental. The fix is two settings: **`runc` as the runtime** and **`no_pivot_root`**.
   `no_pivot_root` is a `runc` feature that **crun does not implement**, so setting it alone
   changes nothing; the runtime has to move with it. It also lives under **`[engine]`**, not
   `[containers]` — putting it in the wrong section fails silently.

4. **`podman build` fails** where `podman run` succeeds:
   `did not get container create message from subprocess: EOF`. buildah runs the `RUN` step
   itself and does **not** read podman's `[engine]` config. **Fixable** with
   `BUILDAH_ISOLATION=chroot` in the environment (equivalently `podman build --isolation=chroot`).

### 13.5 The working nested-rootless configuration

All four blockers resolved. Verified end to end on the rootless VM:

| Capability                                       | Result                                             |
| ------------------------------------------------ | -------------------------------------------------- |
| `podman run`, default (private) netns            | OK                                                 |
| egress from a nested container                   | OK                                                 |
| bind-mounting a host path in                     | OK                                                 |
| the `docker` shim                                | OK                                                 |
| `podman build` (with `BUILDAH_ISOLATION=chroot`) | OK                                                 |
| created network + **container-name DNS**         | OK — `srv` resolved to `10.89.0.2`, HTTP succeeded |

**Outer container** (the consumer's `runArgs`, unchanged from the rootful requirements except
that `/dev/net/tun` is now load-bearing rather than optional):

```
--cap-add=SYS_ADMIN --security-opt systempaths=unconfined --device=/dev/net/tun
```

**Inside the container** (the Feature's job):

1. Allocate the remote user's subuid/subgid **inside the range the outer namespace owns** —
   `10000-60000`, not `100000-165535`, and never a range spanning the user's own uid.
2. `~/.config/containers/containers.conf`:

   ```toml
   [containers]
   keyring = false

   [engine]
   runtime = "runc"
   no_pivot_root = true
   ```

3. `BUILDAH_ISOLATION=chroot` exported for builds.

**How the Feature can tell it is nested**, without any host coordination: read
`/proc/self/uid_map` inside the container. Rootful Docker gives the identity map
`0 0 4294967295`; a rootless outer daemon gives something else (`0 1000 1` / `1 100000 65536`
here). That is a clean, in-container signal, so the settings above can be applied only when
nested and rootful consumers stay untouched — `runc`-instead-of-`crun` in particular should not
be imposed on hosts that do not need it.

Not established: whether `/dev/fuse` matters (13.1 previously found it did not; it was present
during these runs), and whether a subuid range narrower than 50000 ids is sufficient.

### 13.6 Why uid 0 and nested podman cannot currently be combined

From `podman-nested-rootless` § V7. Everything in 13.5 was measured with podman running as a
**non-root** container user. `rootless-remote-user` makes the remote user **root** on the same
hosts, and podman selects rootless-vs-rootful by **euid**, so in the combined configuration it
takes the rootful path. Two further blockers appear there, and they are mutually exclusive:

| Runtime | `no_pivot_root` (needed: `pivot_root` is denied) | `cgroups = "disabled"` (needed: `/sys/fs/cgroup` is read-only)           |
| ------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| `runc`  | **supported**                                    | rejected — `requested OCI runtime runc is not compatible with NoCgroups` |
| `crun`  | **not implemented** — silently ignored           | supported                                                                |

As root you need both at once, and no runtime provides both. Measured errors:

```
runc + no_pivot_root : unable to apply cgroup configuration:
                       mkdir /sys/fs/cgroup/libpod_parent: read-only file system
crun + NoCgroups     : crun: pivot_root: Operation not permitted
```

Also ruled out:

- **`--cgroupns=private`** on the outer container. `/sys/fs/cgroup` stays read-only; no change.
- **`--tmpfs /sys/fs/cgroup:rw`.** Now writable, but it is not a real hierarchy:
  `runc create failed: no cgroup mount found in mountinfo`.
- Note `cgroups = "disabled"` is actively harmful with `runc` — it breaks the **working**
  non-root configuration too. Do not add it to a shared drop-in.

#### The socket-service arrangement — works, with a real boundary

Measured. Run the podman API service as a dedicated **non-root** user and have the uid-0 remote
user drive it over that socket (`podman system service unix:///run/podman/podman.sock` as
`vscode`; client sets `DOCKER_HOST`/`CONTAINER_HOST` to it). The Feature's `dockerApiSocket`
option is the existing machinery for this.

| Check (client is uid 0, service is `vscode`)                    | Result |
| --------------------------------------------------------------- | ------ |
| service reachable, reports `rootless=true`                      | OK     |
| `podman --remote run`, and plain `docker run` via `DOCKER_HOST` | OK     |
| default (private) netns                                         | OK     |
| `docker build` (with `BUILDAH_ISOLATION=chroot`)                | OK     |
| created network + container-name DNS                            | OK     |
| bind-mount a project file **in, read-only**                     | OK     |

So container _execution_ is fully recovered. The boundary is that **the service user is a
different identity from the remote user**, and it shows up the moment a nested container writes
into the workspace:

|                                                               | Service user (`vscode`)                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| read a `644` project file                                     | **yes** — world-readable                                                       |
| write into a `755` project directory owned by the remote user | **no**                                                                         |
| where a write does land (e.g. a `777` directory)              | file is owned by `vscode` → host subuid **101000**, orphaned for the developer |

Both measured directly. So this arrangement suits a workload that **reads** the project and talks
over the network — a server container under test, say — and does **not** suit one that writes
build output back into the workspace. Anything doing that needs the service user and the remote
user to be the same identity, which is the thing rootless makes impossible.

Loosening workspace permissions (group-writable dirs, a shared gid, `vscode` in group 0) would
trade the write failure for the orphaned-ownership problem rather than remove it: files would
carry a usable _group_ but a bogus owner, so `ls -l` misreports them and the developer could not
`chmod`/`chown` their own build output. Not measured, and not attractive.

#### Conclusion: nested podman cannot support a rootless host

> **Superseded (2026-09-02).** This conclusion was wrong, in the same way § 13.4's first
> reading of `pivot_root` was: it ruled out one mechanism and called the position closed. Podman
> decides rootless-vs-rootful from `_CONTAINERS_ROOTLESS_UID` before the euid, and — more
> usefully — nested podman needs **no capability at all** once Docker's seccomp profile stops
> gating the namespace and mount syscalls and `newuidmap` carries file capabilities instead of
> setuid. Both were measured end to end on a rootless host and on Docker Desktop, with a writable
> workspace and nested writes owned by the developer. See `devc-dev`:
> `docs/rootless-linux-findings.md` § Disproof and `.plans/pending/nested-podman-zero-caps.md`.
> The measurements in §§ 13.4–13.8 stand; the table and the recommendation below do not.

A read-only workspace is not an acceptable devcontainer, so this arrangement does not rescue
`podman-as-docker` on rootless Linux. Combined with 13.4–13.6 the position is closed:

| Approach                                          | Workspace writable by the developer   | Nested container can write the workspace           |
| ------------------------------------------------- | ------------------------------------- | -------------------------------------------------- |
| nested podman, remote user non-root               | **no** — the bind mount is unwritable | n/a                                                |
| nested podman, remote user uid 0                  | yes                                   | **no** — podman goes rootful and cannot run at all |
| nested podman + socket service (13.6)             | yes                                   | **no** — service user is a different identity      |
| **sibling containers via the host socket (13.8)** | **yes**                               | **yes**                                            |

`podman-as-docker`'s value is children-not-siblings, and on a rootless host that is not
achievable while keeping a writable workspace. The Feature should **detect a rootless outer
daemon and say so plainly**, rather than install into a configuration that cannot work.

### 13.7 The toolchain at uid 0 — no problems found

From `feature-rootless-remap` § Validation, pulled forward because it de-risks **both** rootless
mechanisms: each makes the container user uid 0, so anything refusing to run as root would break
them equally. Measured on the rootless VM with `remoteUser: root` and the `java`, `node` and
`python` Features:

| Check                                                 | Result                                         |
| ----------------------------------------------------- | ---------------------------------------------- |
| `java -version`, `javac` + run                        | OK — Temurin 21.0.12                           |
| `gradle --version` (SDKMAN install)                   | OK — Gradle 9.7.1                              |
| `node --version`                                      | OK — v24.20.0                                  |
| `npm install` incl. a postinstall-built native binary | OK — `esbuild` installs **and executes**       |
| `python3 -m venv` + `pip install` + import            | OK — Python 3.12.14                            |
| every file written back to the host                   | `ubuntu:ubuntu` (`1000:1000`), zero exceptions |
| host can delete what the container built              | OK                                             |

So the uid-0 requirement is not, by itself, a problem for a normal JVM/Node/Python toolchain.
This does **not** cover the second half of `feature-rootless-remap`'s question — two uid-0 entries
in `/etc/passwd`, where the user is uid 0 but _named_ `vscode` — which remains untested.

### 13.8 The socket-mount alternative, and why it is not the answer here

Recorded for completeness, and because it was measured before 13.5 was found. Mounting the
host's Docker socket (sibling containers rather than nested ones) also works on a rootless host:

| Check                                     | Result      |
| ----------------------------------------- | ----------- |
| talks to the host daemon                  | OK (29.7.2) |
| `docker run`                              | OK          |
| `docker build`                            | OK          |
| user-defined network + container-name DNS | OK          |

**On a rootless host this is the only arrangement that works**, and it is better here than it is
on a rootful one. Because the outer daemon is rootless, a sibling container's root maps to the
developer's own host uid, so a container writing into the workspace produces files owned by the
developer:

```
out.jar on the host : ubuntu:ubuntu (uid=1000)   # written by a sibling container
host user can edit it : OK
```

On a _rootful_ daemon the same write would produce root-owned files. So the usual objection to
socket-mounting is weaker on exactly the platform that needs it. 13.6 explains why the nested
alternative is unavailable here.

Two rootless-specific gotchas if you do reach for it:

- **The socket is not at `/var/run/docker.sock`.** Rootless puts it at
  `$XDG_RUNTIME_DIR/docker.sock` (`/run/user/1000/docker.sock`). The upstream
  `ghcr.io/devcontainers/features/docker-outside-of-docker` Feature **hardcodes the rootful
  path** and fails at create time with `bind source path does not exist: /var/run/docker.sock`.
  A plain `mounts` entry pointing at the real socket works; the Feature does not.
- **The remote user has to be `root`.** The socket is owned by the host user, which maps to
  container uid 0 — the same mapping that makes this whole section necessary. The
  `rootless-remap` Feature planned in `nested-podman-zero-caps` makes the remote user uid 0 while
  keeping its name, so the two fixes compose.

And the sibling-container caveats that make it second-best are not rootless-specific:
bind-mount paths are resolved by the **host** daemon, so a path that exists only inside the
devcontainer will not resolve (this is why `devcontainer features test` cannot run inside a
socket-mounted container); published ports land on the host; and containers outlive the
devcontainer. Nested podman has none of these problems.

### 13.9 Zero capabilities — `podman-as-docker` 0.2.0 and `rootless-remap` 0.1.0

From `devc-dev`: `.plans/pending/nested-podman-zero-caps.md`; the measurements it rests on are in
`devc-dev`: `docs/rootless-linux-findings.md` § Disproof. Run 2026-09-02 on two hosts, the same
files on both: **macOS Docker Desktop 29.7.2** (`npx @devcontainers/cli@0.89.0`) and the
**rootless Docker 29.7.2 VM** (Ubuntu 24.04 arm64, `devcontainer` 0.89.0, host user `ubuntu`
uid 1000). Both Features from the `nested-podman-zero-caps` branch working tree, referenced as
local Features.

The fixture (`devc-dev`: `docs/rootless-nested-e2e/zero-caps/devcontainer.json` with
`./rootless-remap` and `./podman-as-docker` in place of the prototype):

```jsonc
{
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu-24.04",
  "remoteUser": "vscode",
  "features": { "./rootless-remap": {}, "./podman-as-docker": { "rootlessNetworkCmd": "slirp4netns" } },
  "runArgs": ["--security-opt", "seccomp=${localWorkspaceFolder}/.devcontainer/seccomp-podman.json",
              "--device=/dev/net/tun"]
}
```

No `capAdd`, no `containerEnv`, `updateRemoteUserUID` at its default. What the two hosts showed
(V-numbers are the plan's):

| Check | rootless VM | macOS Docker Desktop |
| --- | --- | --- |
| V-2 `docker inspect … .HostConfig.CapAdd` | `[]` | `[]` |
| V-2 `CapBnd` inside, `capsh --decode` | `00000000a80425fb`, no `cap_sys_admin` | same |
| V-2 `SecurityOpt` entries / `MaskedPaths` | 2 (seccomp JSON, apparmor) / 0 | 2 / 0 |
| `id` under `devcontainer exec` | `uid=0(vscode) gid=0(root)`, `HOME=/home/vscode` | `uid=1000(vscode)` |
| build log | `rootless-remap: vscode remapped to uid 0/gid 0 (was 1000); home /home/vscode kept` · `uid 1000 held by devc-uid-hold` · `podman-as-docker: nested on a rootless daemon (container uid 0 is host uid 1000)` | `rootless-remap: rootful daemon (identity uid map) — nothing to remap` |
| `podman info` | `rootless=true runtime=runc driver=overlay` | `rootless=true runtime=runc driver=overlay` |
| V-3 (1) edit an existing `644` workspace file | OK | OK |
| V-3 (2) file created by the remote user, on the host | `ubuntu:ubuntu` | the Mac user |
| V-3 (3) `docker run` private netns; nested `uid_map` | OK; `0 1000 1 / 1 10000 50001` | OK; `0 1000 1 / 1 100000 65536` |
| V-3 (3) egress; run via `podman --url $DOCKER_HOST` | OK; `0` | OK; `0` |
| V-3 (4) nested write into a `755` dir, shim and socket; host owner; `chmod`/`rm` on host | OK; `ubuntu:ubuntu`; OK | OK; the Mac user; OK |
| V-3 `docker build`; created network + name DNS | `built`; nginx title | `built`; nginx title |
| V-4 second `devcontainer exec` sees the first's container; runs | yes; OK | — |
| V-4 `docker stop`/`start`, `devcontainer up`, run + socket | OK, holder pid re-created | — |
| runc state dir in the nested config | `/run/user/1000/runc` only (the wrapper drops `USER`; see V-5) | n/a |

**V-5** — `remoteUser: root`, `podman-as-docker` alone (no remap), rootless VM: the first run
failed every `docker run` with `` `/usr/bin/runc start …` failed: exit status 1 `` and
`container does not exist`; `find / -name state.json` showed `/run/runc/<id>/state.json`, i.e.
`runc create` used `/run/runc` while `runc start` looked under `$XDG_RUNTIME_DIR`. Cause: podman
runs conmon and `runc create` inside its own user namespace as in-namespace root with the caller's
environment (`USER=root`), and runc's heuristic (`shouldHonorXDGRuntimeDir`: euid 0 in a userns
honours XDG unless `USER=root`) then differs between create and start. First fix tried: a wrapper
pinning `--root /run/runc-nested` — worked here, then failed the scenario suite for a non-root
remote user (`mkdir /run/runc-nested: permission denied`). Final: the nested drop-in names a
wrapper `env -u USER /usr/bin/runc "$@"`, so both sides honour `XDG_RUNTIME_DIR`. Rerun: every
V-3 line OK, `CapAdd=[]`, host owner `ubuntu:ubuntu`, state under `/run/user/1000/runc`.

**Subordinate ranges** — found by the VM scenario suite: `with_volume`'s `docker pull busybox`
failed (quietly, the check was weak) with `potentially insufficient UIDs or GIDs available in
user namespace (requested 65534:65534 for /home)`: a nested range of `10000:50001` cannot map
uid 65534 (`nobody`), which many images carry. Both Features now write two lines per name
covering 1–65535 minus uid 1000 (`1:999`, `1001:64535`), and the shim writes the level-1
holder's map directly (`1000 0 1 / 1 1 999 / 1001 1001 64535`) because `unshare --map-users`
does not accumulate. A first cut gave root and the remapped user `1:65535` and podman refused
it — `the specified mapping 1:65535 in "/etc/subuid" includes the user UID` — because podman
looks the lines up by `$USER` before `getpwuid`, so at level 1 (uid 1000) it read the remote
user's lines. Every name excludes 1000 now. Measured after: nested `uid_map`
`0 1000 1 / 1 1 999 / 1000 1001 64535` on both V-3 and V-5, `docker pull busybox` and
`docker run busybox ls -ln /home` OK, `with_volume` (now failing on a failed pull) passes.

**V-6** — `rootless-remap` alone, no podman, rootless VM: `uid=0(vscode) gid=0(root)`,
`HOME=/home/vscode`, `sudo -n true` OK, a created file is `ubuntu:ubuntu` on the host and the host
can edit and delete it; the container's image is tagged `-uid` (the CLI's update layer ran) and the
remap survived it.

**V-7** — macOS, the seccomp line removed from `runArgs`: `podman run` → `Error: cannot re-exec
process` (`cannot clone: Operation not permitted` in `service.log`) — **not** the `newuidmap`
string the plan predicted, because with file-capability `newuidmap` the filter now bites at
`clone(CLONE_NEWUSER)` first. `post-start.sh` printed:

```
podman-as-docker: podman cannot create its user namespace (cannot clone: Operation not permitted).
podman-as-docker: Almost always: the seccomp profile is not reaching this container. Copy this Feature's
podman-as-docker: seccomp-podman.json into your repo's .devcontainer/ and add to devcontainer.json:
podman-as-docker:   "runArgs": ["--security-opt", "seccomp=${localWorkspaceFolder}/.devcontainer/seccomp-podman.json"]
podman-as-docker: then rebuild. See the podman-as-docker README, § Read this before enabling it.
```

**V-1 / V-10** — `bash features/podman-as-docker/test/install_options_test.sh` and
`bash features/rootless-remap/test/install_options_test.sh`: ALL PASS. `cd devc && deno task check &&
deno task test`: 132 passed. `bash tests/features_test.sh`: ALL PASS. `features/agents`' harness:
13 failures, identical on `main` (Copilot/pi install cases), untouched.

**Two things found only by running it.** `installsAfter: ["ghcr.io/devc-tools/features/rootless-remap"]`
made every `devcontainer up` fail with `installsAfter dependency … could not be processed` (the
CLI fetches the ref's metadata; 403 for an unpublished package) — removed, and not needed since
both Features write the same subordinate ranges whichever runs first. And the shims were first
written with an empty holder directory because `SOCKET_DIR` was defined further down `install.sh`
— the holder worked out of `/holder.pid` by accident; fixed, and pinned by an offline case.

**V-8** — `bash features/podman-as-docker/test/run-features-test.sh --skip-autogenerated`
(scenarios: `with_tun`, `with_socket`, `with_volume`, `no_shim` on `base:ubuntu`, `zero_caps` on
`base:ubuntu-24.04`, all with the profile at `/tmp/devc-podman-as-docker-seccomp.json`), then
`… --base-image mcr.microsoft.com/devcontainers/base:ubuntu-24.04 --skip-scenarios`, then
`bash features/rootless-remap/test/run-features-test.sh --base-image …ubuntu-24.04`:

| Suite | macOS Docker Desktop | rootless VM |
| --- | --- | --- |
| five scenarios | ✅ all five (`zero_caps`: bounding set without `cap_sys_admin`, `CapEff 0`, `Seccomp: 2`, run/egress/build/name DNS/API socket) | ✅ all five (the non-root nested path: remote user uid 1000, no remap) |
| default scenario (build-only checks) | ✅ | ✅ |
| `rootless-remap` default scenario | ✅ rootful branch: no marker, not uid 0, no placeholder, silent guard | ✅ rootless branch: marker, `uid 0`, own name and home, placeholder holds host uid, guard exits 0 |

The VM `rootless-remap` scenario first failed `owned by root`: with the remapped user first in
`/etc/passwd`, `stat -c %U` on a root-owned file prints `vscode`. Both default scenarios compare
uids now. The macOS CLI was `npx --yes @devcontainers/cli@0.89.0` through a one-line wrapper,
since `run-features-test.sh` execs `$DEVCONTAINER_CLI` as a single word.

**V-9** (rootful native Linux, `.github/workflows/test-podman-as-docker.yml`) was **not run** — it
needs the branch pushed. It decides whether `apparmor=unconfined` stays declared.

**Result (2026-09-02).** Run `33665320494` (branch commit `1be537e`, declaration present):
**passed**. Run `33666929655` (commit `6dd9758`, declaration removed): **failed**, every
scenario, at Podman's storage setup —
`configure storage: overlay: failed to make mount private: mount …/storage/overlay: permission denied`
— the `docker-default` AppArmor `deny mount` of § 13.3. So `apparmor=unconfined` stays declared:
AppArmor mediates `mount` inside a user namespace too, and dropping `CAP_SYS_ADMIN` did not remove
the need on a rootful native Linux host. It remains a no-op on Docker Desktop and on rootless
daemons, where no profile is applied.

## 14. `npm ci` over a volume-mounted `node_modules` — Docker host

From `declared-volume-spike` (M3, M4). Answers `feature-declared-volumes`'s
Step 1: whether `node-nvmrc` can declare a `node_modules` volume at all —
does `npm ci` survive a **named volume** mounted at `node_modules`, run
twice, and what trace does that mount leave in the host checkout. Measured
once with `@devcontainers/cli 0.89.0` / `npm 10.9.8`
(`mcr.microsoft.com/devcontainers/javascript-node:22`); re-run after a CLI or
npm upgrade to confirm the answer still holds.

A different fixture from §12 — no Feature involved, so a failure here cannot
be blamed on one: `tests/fixtures/node-modules-volume/` mounts a plain named
volume at `${containerWorkspaceFolder}/node_modules` over one small, stable
dependency (`ms`).

```sh
devcontainer up --workspace-folder tests/fixtures/node-modules-volume
F=tests/fixtures/node-modules-volume

devcontainer exec --workspace-folder $F npm --version
devcontainer exec --workspace-folder $F npm install            # creates the lockfile
devcontainer exec --workspace-folder $F npm ci                 # first ci
devcontainer exec --workspace-folder $F npm ci                 # the one that matters
devcontainer exec --workspace-folder $F sh -c 'mountpoint -q node_modules && echo STILL-MOUNTED'
devcontainer exec --workspace-folder $F sh -c 'ls node_modules | wc -l'
```

**A step before any of this, not anticipated by the plan: the bare `npm
install` fails first**, with `node_modules` not yet touched by npm at all:

```
npm error code EACCES
npm error syscall mkdir
npm error path /workspaces/devc-tools/tests/fixtures/node-modules-volume/node_modules/ms
```

Docker auto-creates a named volume that does not exist yet, owned
`root:root`; nothing in this bare (no-Feature, no `postCreateCommand`)
fixture chowns it, and the image's `remoteUser` is `node` (uid 1000) — not
root, so it cannot write into its own project's `node_modules`. Confirm with
`devcontainer exec --workspace-folder $F sh -c 'ls -la .'` — `node_modules` is
`root root` where every sibling is `node node`. Worked around here only to
reach M3/M4, via `docker exec -u root <container> chown node:node
.../node_modules`.

**Not a new problem — already known and already handled**:
`features/node-nvmrc/post-create.sh` already carries a `FIX_NODE_MODULES_OWNERSHIP`
repair (`sudo -n chown -R "$(id -u):$(id -g)" ./node_modules`, gated on
`[ -d node_modules ]`) with a comment describing this exact mechanism —
"a named volume first mounts root-owned — after which an `npm ci` as the
remote user cannot write into it." This fixture reproduces, standalone, the
condition that comment was already written against; it does not surface a
gap in `node-nvmrc`.

With ownership fixed, `npm install` then both `npm ci` runs succeed
(`added 1 package`, exit 0 each time) — **M3: succeeds, no `EBUSY`.**
`mountpoint -q` still reports `STILL-MOUNTED` afterward and `node_modules`
holds 2 entries (`ms/`, `.package-lock.json`): the volume was emptied and
refilled by the second `npm ci` without detaching.

Then, **on the host, outside the container** (Docker Desktop on macOS):

```sh
ls -la tests/fixtures/node-modules-volume/
stat -c '%U %u %G %g %a' tests/fixtures/node-modules-volume/node_modules
git status --short tests/fixtures/node-modules-volume/
rmdir tests/fixtures/node-modules-volume/node_modules   # as the normal host user, no sudo
```

**M4:** `node_modules` appears in the host checkout as an **empty** directory
— the workspace bind mount and the volume mount are two different views of
that path, so the volume's contents (`ms/`, `.package-lock.json`) never
reach the host side, only an auto-created stub. That stub is owned by the
**host user** (`bingles staff 755`, not root, and not the container's uid
1000 `node`) and `rmdir` succeeds with no `sudo` — the better of the two
traces the parent plan graded on. `.gitignore` covers it
(`tests/fixtures/node-modules-volume/node_modules/`, its `package-lock.json`,
and `.devcontainer/devcontainer-lock.json`), confirmed with `git check-ignore
-v` on all three.

Clean up after: `docker rm -f` the container (`devcontainer up`'s output
prints its id), `docker volume rm node-modules-volume-spike`, and
`rm -rf tests/fixtures/node-modules-volume/node_modules` on the host if the
`rmdir` step above was skipped.
