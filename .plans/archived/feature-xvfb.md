# `xvfb` Feature — a virtual X display, plus the runtime libraries that render into it

## Checklist

- [x] `features/xvfb/devcontainer-feature.json` with the options below
- [x] `features/xvfb/install.sh`: package groups, `t64` name fallback, `xvfb-ensure` + `post-start.sh` install with baked options
- [x] `features/xvfb/xvfb-ensure` (the command) and `features/xvfb/post-start.sh`
- [x] `features/xvfb/README.md` with the three recipes (Godot, Aseprite, VS Code extension tests)
- [x] Offline harnesses: `test/install_options_test.sh`, `test/xvfb_ensure_test.sh`
- [x] Container scenarios: `test/test.sh` + `test/scenarios.json` (`minimal`, `start_on_container_start`, `godot_render`, `debian`)
- [x] `test/run-features-test.sh` copied unchanged from another Feature
- [x] `features/README.md` row; `features/CONTRIBUTING.md` test-inventory entry + per-Feature note
- [x] `features/godot/README.md`: a short "Rendering frames" section pointing at this Feature
- [x] `bash tests/features_test.sh --feature xvfb` and the whole-collection run; `deno fmt --check`
- [x] Docker scenarios run (or recorded as unrun, same standing as `feature-godot`) — **recorded as unrun**: no Docker in the implementing environment. See Implementation notes.
- [x] `features/PUBLISH_ALLOWLIST.txt` — added 2026-10-08 on the maintainer's call, on the
      evidence under "Finalized" below rather than a `run-features-test.sh` run.

## Implementation notes

Code complete and offline-tested on 2026-10-07. What is left is the last checklist item and
the run it waits on.

**Verified offline:** `features/xvfb/test/install_options_test.sh` (157 checks),
`features/xvfb/test/xvfb_ensure_test.sh` (139 checks), `bash tests/features_test.sh --feature
xvfb` and the whole-collection run (10 Features in scope), `tests/workflow_guards_test.sh`,
`deno fmt --check`.

**Not verified (no Docker, and no real Xvfb, in the implementing environment):** every
`devcontainer features test` scenario — `test.sh`, `minimal`, `start_on_container_start`,
`godot_render`, `debian`. So nothing here has yet met a real X server: that Xvfb accepts the
flags `xvfb-ensure` passes, that GLX is present, and that Godot renders a non-uniform frame
through llvmpipe are all claims the scenarios make and nobody has run. Run
`bash features/xvfb/test/run-features-test.sh`, then add `xvfb` to
`features/PUBLISH_ALLOWLIST.txt` and archive this plan.

**Verified in a real container on 2026-10-08, without the test runner:** the Feature was
built into devc-dev's own devcontainer (Ubuntu 24.04, bare `{}`, as a local Feature) and
exercised by hand there. `install.sh` ran against real apt and installed the always-set and
the three default groups, leaving the opt-in ones out. `test.sh` — the default scenario's
script — passes in full against that container with a stand-in for the test library. Also
confirmed by hand: Xvfb accepts the flags `xvfb-ensure` passes, GLX is listed, the server
runs in its own session and is still there from a later shell, a `kill -9`'d server's stale
lock is cleared and restarted on, `--display`/`--screen` reach the server, and `--stop`
with and without `--display`. That run found one bug, in the test rather than the Feature:
`test.sh` counted Xvfb processes straight after `xvfb-run`, whose private server is still
exiting at that moment; it now tracks the shared server by pid.

**All three consumers exercised in that container on 2026-10-08**, after a second rebuild with
`extraPackages` (the README's Electron list), `tools: true` and `startOnContainerStart: true`:

- **Godot** (4.7.2, the upstream binary, not the `godot` Feature): the `godot_render`
  scenario's own fixture and command rendered through llvmpipe ("OpenGL API 4.5 … Mesa …
  llvmpipe") and wrote three 320x240 frames, red rectangle on grey — two colours, checked by
  pixel and by eye. The same command with `--headless` wrote no frames; with no `DISPLAY`
  Godot reported "X11 Display is not available".
- **Aseprite** (1.3.17): the GUI segfaults with no display and opens and paints its window
  under `xvfb-ensure` (screenshotted with `import -window root`). `--batch` turned out to
  need **no** display, only the libraries — the Goal section's "even when scripted" is wrong
  for this version, and the README recipe now says so.
- **VS Code extension tests**: `vscode-test` in `devc-vscode` (VS Code 1.141.0) fails without
  a display ("Missing X server or $DISPLAY") and passes under `xvfb-ensure` — 197 passing,
  exit 0 — with the eleven Electron packages installed through `extraPackages` on noble.
- **`startOnContainerStart`**: after the rebuild a server was already up on `:99`, started by
  the real `postStartCommand`, in its own session, with no `DISPLAY` exported.

**Still unverified:** the `t64` fallback on a real pre-rename base (the `debian` scenario —
noble has the `t64` names, so the fallback did not fire here), the `minimal` scenario, the
Vulkan group, and the scenarios run _as scenarios_ through `run-features-test.sh`. The
allowlist item stays open on that run.

**Finalized 2026-10-08.** `xvfb` is in `PUBLISH_ALLOWLIST.txt` at `0.1.0`. The gate this plan
set — the Docker scenarios green — was met by equivalent evidence, not by the runner, which
still has not been run (no Docker where this was built). What stands in for each scenario:

- `test.sh`, `start_on_container_start.sh` and `godot_render.sh` — each script passes in full,
  run as written inside a real container built from this Feature, against a stand-in for the
  test library.
- `minimal` — the real `install.sh` run against real apt with every group off requests exactly
  `xvfb xauth x11-utils`. The script itself was not run (this container has the groups on).
- `debian` — the `t64` fallback was run through the real `install.sh` and real apt on noble
  with a name that only exists bare (`curlt64` → `curl`), and a name with neither form fails
  the build naming both. **It has never run on an actual bookworm base**; that
  `mcr.microsoft.com/devcontainers/base:bookworm` exists was checked against the registry.
- `vulkan` (no scenario) — the group installed through the real `install.sh`, and Godot's
  Forward+ renderer drew the fixture through lavapipe ("Vulkan 1.4 … Forward+ … llvmpipe").

Running `bash features/xvfb/test/run-features-test.sh` on a host with Docker is still worth
doing once; nothing is known to be wrong, but bookworm is the one base nobody has built on.

**Where the implementation departs from, or adds to, the text above:**

- **The `debian` scenario pins `base:bookworm`, not `base:debian`.** The scenario exists to
  exercise the `t64` fallback "on a release without the renames". Debian trixie has the `t64`
  names, so the floating tag would pass without exercising the fallback once it points there.
  `debian.sh` also asserts `VERSION_ID` is 12.
- **`--display` skips the live-`$DISPLAY` step.** Concept boundaries says a consumer who must
  have the virtual display "passes `--display`"; that only works if an explicit `--display`
  means "this display" rather than "start here if nothing is live". `post-start.sh` unsets
  `DISPLAY` before calling `xvfb-ensure` for the same reason — a consumer's own
  `remoteEnv` `DISPLAY` must not be mistaken for a display that is already up.
- **A live `$DISPLAY` is only echoed back if it looks like a display name**
  (`[A-Za-z0-9._:/-]`). The output is meant for `eval`.
- **A lock whose owning pid is still running is skipped, not removed**, even though nothing
  answers on that display. "Stale" is read as "its owner is gone"; removing the lock of a live
  process that is merely not answering would break someone else's server.
- **`xvfb-ensure` passes `-noreset` and `+extension GLX`** as well as `-nolisten tcp`.
  `-noreset` stops the server resetting when its last client disconnects, which for a display
  shared across separate commands is after every command.
- **`--stop` checks `/proc/<pid>/cmdline` names an Xvfb** before signalling, so a pidfile
  outliving its server cannot get a recycled pid killed. With no `--display` it stops every
  server this command started; with one, only that display's.
- **`--status` accepts `--display`** (the usage block above shows it bare).
- **Usage errors exit 2**; "nothing came up" exits 1, as specified.
- **The lock/pid/log directory override is `XVFB_ENSURE_STATE_DIR`** (test-only).
- **`install.sh` creates `/tmp/.X11-unix` (mode 1777)** at build time, so a non-root Xvfb does
  not warn about its ownership on every start.
- **`extraPackages` entries are trimmed and de-duplicated**, and empty entries skipped.
- **`minimal` does not assert the default groups' packages are absent.** Most are dependencies
  of the always-set itself (`xvfb` pulls in `libgl1` and a Mesa driver, `x11-utils` most of the
  X client libraries). It asserts the opt-in groups are absent; the per-option effect on the
  requested set is asserted offline.
- **`godot_render` uses `tools: true`** and ImageMagick for the non-uniform check, the
  simpler of the two options offered.
- **`godot`'s version was not bumped** for its README section — left to the maintainer, as
  the plan says.

## Goal

Publish `ghcr.io/devc-tools/features/xvfb`: installs Xvfb and the shared libraries GUI
programs need to actually render into it, and ships one command, `xvfb-ensure`, that starts
or reuses a virtual display and prints the `DISPLAY` to use. One Feature serving three
known consumers:

1. **Godot rendering** — screenshots and `--write-movie` frame capture. Godot's
   `--headless` forces a dummy renderer (and `--write-movie` aborts under it, verified on
   4.7.2), so real frames need a display plus software OpenGL (Mesa llvmpipe).
2. **Aseprite** — a GUI binary that needs an X display and GL even when scripted. Another
   devcontainer today installs
   `libx11-6 libfontconfig1 libxcursor1 libgl1 libxext6 libxi6 libxrandr2 xvfb` for it.
3. **VS Code extension E2E tests** — Electron needs a display. Distilled from
   [vscode-deephaven's `ensure-headless-env.sh`](https://github.com/deephaven/vscode-deephaven/blob/main/.devcontainer/scripts/ensure-headless-env.sh),
   whose display-management half becomes `xvfb-ensure`. Its Electron package list
   (GTK, NSS, ALSA, CUPS, …) is **not** a group in this Feature: those are Electron's own
   runtime dependencies, needed with any display, not Xvfb's. The README's VS Code recipe
   passes them through `extraPackages` instead (see Package groups).

This is a **new** Feature, not an extraction from `devc-core/default/`. "Copy, don't move"
does not apply. The deephaven script keeps working where it is; nothing here touches it.

A bare `{}` installs Xvfb, the X client libraries, software OpenGL and a base font — which
covers consumers 1 and 2 with no options — and starts nothing. Consumer 3 adds one
`extraPackages` line.

**Scope rule for groups:** a group belongs here only if it serves "use this display" for
any client — the display itself, the generic X client side, software rendering into it,
fonts, and tools that operate on the display. A dependency list for one application
family (Electron's, Godot's `fontconfig`) belongs with that application, or in
`extraPackages`.

## Existing touchpoints

- `features/godot/` — the closest structural template: `install.sh`'s `die`/`bake()`
  helpers, the `/usr/local/share/devc-features/<id>/` install namespace with a
  `/usr/local/bin` symlink, the offline-harness style (`install_options_test.sh` with
  `apt-get` stubbed on PATH). **Not modified** apart from its README (below).
  `godot`'s `installDependencies` (fontconfig only, deliberately narrow for `--headless`)
  stays exactly as it is.
- `features/podman-as-docker/post-start.sh` + its manifest — the template for an
  option-gated start-time service: baked `*_OPT` variable, never fails the start, logs and
  exits 0 on every path, idempotent so it is safe on every restart-after-attach. **This
  plan deliberately departs from one part of it**: podman exports `DOCKER_HOST` through an
  unconditional `containerEnv`; this Feature declares no `containerEnv` at all (see
  Contracts → "No `DISPLAY` in `containerEnv`").
- `features/godot/README.md` — add a short "Rendering frames (screenshots, `--write-movie`)"
  section: add `xvfb` alongside `godot`, run under `eval "$(xvfb-ensure)"`, pass
  `--rendering-driver opengl3`, never `--headless`. README-only; the maintainer decides
  whether that warrants a `godot` version bump.
- `features/README.md` — add a row (alphabetical: last, after `rootless-remap`).
- `features/CONTRIBUTING.md` — add a "Per-Feature test inventory" entry and a "Per-Feature
  notes" subsection (the `t64` fallback and the no-`containerEnv` decision are the two
  things a future maintainer would otherwise undo).
- `features/PUBLISH_ALLOWLIST.txt` — add `xvfb` **only** once its Docker scenarios pass,
  same precedent as `feature-godot`.
- `.plans/PLAN.md` — registered under `### Pending`.

## Contracts

### `features/xvfb/devcontainer-feature.json`

```jsonc
{
  "id": "xvfb",
  "version": "0.1.0",
  "name": "Xvfb virtual display",
  "description": "Installs Xvfb and the shared libraries GUI programs need to render into it — X client libraries, software OpenGL (Mesa llvmpipe) and a base font by default; Vulkan (lavapipe) and screenshot/input tools as opt-in groups, and any extra packages an application needs — plus `xvfb-ensure`, which starts or reuses a virtual display and prints the DISPLAY to export. Sets no DISPLAY globally and starts nothing unless asked.",
  "documentationURL": "https://github.com/devc-tools/devc-tools/tree/main/features/xvfb",
  "licenseURL": "https://github.com/devc-tools/devc-tools/blob/main/LICENSE",
  "options": {
    "x11Libraries": { "type": "boolean", "default": true, "description": "…" },
    "openGL": { "type": "boolean", "default": true, "description": "…" },
    "fonts": { "type": "boolean", "default": true, "description": "…" },
    "vulkan": { "type": "boolean", "default": false, "description": "…" },
    "tools": { "type": "boolean", "default": false, "description": "…" },
    "extraPackages": { "type": "string", "default": "", "description": "…" },
    "display": { "type": "string", "default": "99", "description": "…" },
    "screen": {
      "type": "string",
      "default": "1920x1080x24",
      "description": "…"
    },
    "startOnContainerStart": {
      "type": "boolean",
      "default": false,
      "description": "…"
    }
  },
  "postStartCommand": "bash /usr/local/share/devc-features/xvfb/post-start.sh"
}
```

Descriptions are the implementer's to write; each must say what the group installs and
which consumer it is for. No `mounts`, no `containerEnv`, no `installsAfter`, no
`DEVC_TOOLS_RELEASE` pin (this Feature downloads nothing).

Options reach `install.sh` uppercased with non-word characters stripped (`$X11LIBRARIES`,
`$OPENGL`, `$EXTRAPACKAGES`, `$STARTONCONTAINERSTART`, …); booleans arrive as the
strings `"true"`/`"false"`.

### Package groups

Always installed (the Feature's reason to exist): `xvfb`, `xauth` (`xvfb-run` needs it),
`x11-utils` (`xdpyinfo`, which `xvfb-ensure` uses as its liveness probe).

| Option          | Packages (Ubuntu 24.04 names)                                                                           | For                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `x11Libraries`  | `libx11-6 libxext6 libxi6 libxrandr2 libxcursor1 libxinerama1 libxrender1 libxkbcommon0 libfontconfig1` | Godot, Aseprite                                                           |
| `openGL`        | `libgl1 libegl1 libgl1-mesa-dri`                                                                        | Godot (GL Compatibility renderer), Aseprite                               |
| `fonts`         | `fonts-dejavu-core`                                                                                     | anything that draws text — `fontconfig` with no font renders none         |
| `vulkan`        | `libvulkan1 mesa-vulkan-drivers`                                                                        | Godot Forward+/Mobile renderers                                           |
| `tools`         | `imagemagick xdotool`                                                                                   | screenshots of the whole display (`import -window root`), synthetic input |
| `extraPackages` | comma-separated, appended verbatim                                                                      | anything else                                                             |

- The Aseprite list from the other devcontainer must be a subset of
  always + `x11Libraries` + `openGL` — asserted offline, so a future trim of either group
  cannot silently drop it.
- **`t64` fallback.** Ubuntu 24.04 renamed several libraries with a `t64` suffix;
  Ubuntu 22.04 and Debian bookworm only have the old names. For every package ending in
  `t64`, install it if `apt-cache show` knows it, otherwise the same name without the
  suffix; if neither exists, `die` naming both. None of the built-in groups has a
  `t64` name today; the fallback exists for `extraPackages`, so an application's list
  (the Electron one below is the motivating case) stays portable across bases.
- **The VS Code / Electron list, for the README recipe** (not a group):
  `extraPackages: "libgtk-3-0t64,libnss3,libasound2t64,libgbm1,libxss1,libxkbfile1,libsecret-1-0,libxshmfence1,libdrm2,libatk-bridge2.0-0t64,libcups2t64"`,
  taken from the deephaven script. The offline harness resolves this exact string, so the
  README recipe cannot drift into something that fails to install.
- **`extraPackages` validation:** each entry must match `^[a-z0-9][a-z0-9.+-]*$` (Debian
  package-name syntax); anything else `die`s naming the entry.
- One `apt-get update` and one `apt-get install -y --no-install-recommends` for the whole
  resolved set, `DEBIAN_FRONTEND=noninteractive`. No runtime installs anywhere else in the
  Feature — `xvfb-ensure` never calls `apt-get` (the deephaven script does; this Feature
  installs at build time instead).

### `xvfb-ensure` (the command)

Installed at `/usr/local/share/devc-features/xvfb/bin/xvfb-ensure`, `0755`, symlinked from
`/usr/local/bin/xvfb-ensure` (same unconditional-symlink pattern as `godot`). `DEFAULT_DISPLAY`
and `DEFAULT_SCREEN` are baked from the `display` / `screen` options with `bake()`.

```
xvfb-ensure [--display <N>] [--screen <W>x<H>x<D>]    # start or reuse
xvfb-ensure --status                                  # report only, start nothing
xvfb-ensure --stop [--display <N>]                    # stop servers this command started
```

- **stdout is reserved for exactly one line**, `export DISPLAY=":N"`, so
  `eval "$(xvfb-ensure)"` works. Every diagnostic goes to stderr. (Kept from deephaven.)
- **Start-or-reuse order:** a live `$DISPLAY` (probed with `xdpyinfo`) → a live server on
  any candidate display → start one on the first candidate whose lock is free or stale.
  Candidates are `N` through `N+5`, `N` from `--display` or the baked default. A stale
  lock (`/tmp/.X<N>-lock` with no live server) is removed when removable and skipped when
  not. Exit 1 with a stderr message naming the candidates if nothing comes up.
- **Started servers outlive the caller.** Start with `setsid` + `nohup`, `-nolisten tcp`,
  log to `/tmp/xvfb-<N>.log`, pid to `/tmp/xvfb-<N>.pid`. This matters for both callers:
  `post-start.sh`'s hook process exits, and an agent's shell tool runs every command in a
  fresh shell, so a server tied to its parent would die between commands.
- **GLX must work** in the started server, so Mesa clients render (Xvfb on Ubuntu enables
  GLX by default; if the implementer finds otherwise, pass `+extension GLX`).
- `--status`: prints the same `export` line and exits 0 if a live server is found by the
  same lookup, else exits 1 silently on stdout. Never starts anything.
- `--stop`: kills only servers named by this command's pidfiles (never a foreign Xvfb),
  removes the pidfile, exits 0 even if nothing was running.
- `--display` must be digits; `--screen` must match `^[0-9]+x[0-9]+x(8|16|24|32)$`; both
  `die` with usage otherwise. `install.sh` validates the two options with the same
  patterns at build time.

### `features/xvfb/post-start.sh`

Copied to `/usr/local/share/devc-features/xvfb/post-start.sh` with
`START_ON_CONTAINER_START_OPT` baked. Runs on every start (a server process does not
survive a stop). When the option is `false`, print one line saying so and exit 0. When
`true`, run `xvfb-ensure` and log the display it reports. **Never fails the start** — every
path exits 0, same rule as podman-as-docker's.

### No `DISPLAY` in `containerEnv`

A Feature's `containerEnv` cannot be conditional on an option (podman-as-docker documents
the same limit). Exporting `DISPLAY` unconditionally would point every process in every
consumer's container at a display that, by default, does not exist — and when one does
exist, GUI prompts (credential helpers, `xdg-open`, editors) would open invisibly on it
instead of failing fast. So:

- Programs opt in per command: `eval "$(xvfb-ensure)" && <cmd>` (persistent, shared) or
  `xvfb-run -a <cmd>` (one throwaway server per command).
- The README gives the two lines for consumers who **do** want it global:
  `"startOnContainerStart": true` plus `"remoteEnv": { "DISPLAY": ":99" }` in their own
  `devcontainer.json` (with a note that `:99` must match the `display` option).

## Concept boundaries

- **`xvfb-run`** (Debian's script from the `xvfb` package: one private server per command,
  torn down on exit) vs **`xvfb-ensure`** (this Feature's: one shared server that persists
  across commands). Both remain available; the README says when to use which. Do not wrap
  or shadow `xvfb-run`.
- **Godot's `--headless`** (no display _and_ no rendering — dummy renderer) vs this
  Feature's "virtual display" (no physical screen, real rendering). Avoid the word
  "headless" in this Feature's option names and README headings; the deephaven script's
  name (`ensure-headless-env.sh`) uses it in the second sense.
- **`godot`'s `installDependencies`** (fontconfig, for `--headless` import/export) vs this
  Feature's library groups (for rendering). Independent; neither Feature installs or
  requires the other.
- **`DISPLAY` set by VS Code** — VS Code Remote can forward a host X display into the
  container on some setups. `xvfb-ensure` reuses any live `$DISPLAY`, which is the right
  behaviour for "give me a display", but means a forwarded host display wins over a virtual
  one. Note it in the README; a consumer who must have the virtual one passes
  `--display` or unsets `DISPLAY` first.
- **`tools`'s `imagemagick` screenshots** capture the whole X screen; Godot's own
  `get_viewport().get_texture().get_image()` and `--write-movie` capture only Godot's
  output and need no `tools`. The Godot recipe uses the latter.

## Validation

**Offline (no Docker):**

- `test/install_options_test.sh` — the real `install.sh` with `apt-get` and `apt-cache`
  stubbed on PATH (the stub records requested packages and answers `apt-cache show` from a
  fixture list): each group's on/off effect on the resolved set; all groups off still
  installs the always-set; the README's VS Code / Electron `extraPackages` string resolving
  to the expected names on both a 24.04 fixture and a pre-`t64` fixture; `t64` resolving to the suffixed name when known, the bare name
  when only that is known, and `die` when neither is; `extraPackages` accepted and
  rejected cases; `display`/`screen` rejections; both values baked into `xvfb-ensure`;
  `START_ON_CONTAINER_START_OPT` baked into `post-start.sh`; the Aseprite package list ⊆
  always + `x11Libraries` + `openGL`.
- `test/xvfb_ensure_test.sh` — the real `xvfb-ensure` with fake `Xvfb` and `xdpyinfo`
  scripts on PATH (a fake server "comes up" by creating a marker the fake `xdpyinfo`
  checks): stdout is exactly one `export` line in every success path and empty on
  failure; live `$DISPLAY` reused; a live candidate reused without starting another; a
  stale lock cleared then started on; an unremovable lock skipped to the next candidate;
  all candidates failing exits 1 naming them; `--status` never starts; `--stop` touches
  only its own pidfiles; argument validation. Use a temp dir in place of `/tmp` (make the
  lock/pid/log directory overridable by env for the test only).
- `bash tests/features_test.sh --feature xvfb`, the whole-collection run, `deno fmt --check`.

**Container scenarios** (`bash features/xvfb/test/run-features-test.sh`, needs Docker):

- `test.sh` (bare `{}`): always-set + `x11Libraries` + `openGL` + `fonts` packages
  installed; `eval "$(xvfb-ensure)"` yields a display `xdpyinfo` accepts; a second call
  prints the identical line and starts no second server; `xvfb-run -a xdpyinfo` works;
  `xvfb-ensure --stop` then `--status` exits 1.
- `minimal` (every group `false`): only the always-set installed; Xvfb still starts.
- `start_on_container_start` (`startOnContainerStart: true`): after create, `xvfb-ensure
  --status` reports `:99` without the test starting anything — proves the server outlived
  the `postStartCommand` hook.
- `godot_render` (this Feature + `ghcr.io/devc-tools/features/godot:0`, a tiny project
  written by `onCreateCommand` — one scene with a coloured rect): `godot
  --rendering-driver opengl3 --audio-driver Dummy --fixed-fps 60 --write-movie
  <out>.png --quit-after 3 <scene>` under `eval "$(xvfb-ensure)"` writes PNG frames, and
  the last frame is **not uniform** (checked either with Godot's own `Image` API or with
  ImageMagick by also setting `tools: true` — implementer's choice). A blank frame is the
  typical silent failure, so the existence of a file is not enough.
- `debian` (`image: mcr.microsoft.com/devcontainers/base:debian`, `extraPackages` set to
  the README's VS Code / Electron list): installs cleanly — exercises the `t64` fallback on
  a release without the renames, and proves the README recipe installs.

**Manual, after publish:** add the Feature to `space-platformer-2`'s devcontainer, rebuild,
and capture a frame of `level1.tscn` with the recipe from `godot`'s README.

## .gitignore

Nothing — the Feature produces no artifacts in the consumer's workspace (logs and pidfiles
go to `/tmp`).

## Not in this plan

- **Setting `DISPLAY` globally** — see Contracts; README recipe only.
- **Watching the display** (x11vnc / noVNC for a human to see what an agent's Xvfb
  shows). Plausible follow-on as an opt-in group plus a forwarded port; not needed by any
  of the three consumers.
- **Wayland** (headless weston/sway) and **GPU passthrough** — software rendering is the
  point here.
- **The Godot agent tooling** (editor bridge, runtime bridge, screenshot command) — a
  separate plan in the game project; this Feature only makes rendering possible.
- **Changing `godot`'s manifest or `installDependencies`** — README cross-link only.
