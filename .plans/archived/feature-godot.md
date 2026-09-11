# `godot` Feature — latest stable Godot, plus a per-devcontainer `.godot` volume

## Goal

Publish `ghcr.io/devc-tools/features/godot`: installs the Godot engine binary at build
time (default: the latest stable release, resolved from upstream — no version to track or
bump in this repo) and declares a named volume for the project's `.godot/` cache directory,
keyed on `${devcontainerId}`. One line in any `devcontainer.json`, devc or not, same shape
as every other Feature in this collection.

This is a **new** Feature, not an extraction from `devc/default/` — there is no existing
devc-owned Godot setup to copy. "Copy, don't move" does not apply; there is nothing to leave
running in parallel.

### Why the `.godot` volume, specifically

Godot 4 replaced Godot 3's single `.import/` folder with a project-local `.godot/`
directory: editor cache, the asset import cache, and `global_script_class_cache.cfg`. It is
exactly the shape `node_modules` is for Node — a large, disposable, frequently-rewritten
build artifact that sits inside the project tree. Left on the bind-mounted workspace it
inherits the host bind mount's I/O cost (real on Docker Desktop for Mac/Windows) and can
carry host-OS-specific cache entries into a Linux container. A named volume avoids both,
exactly as [`node-nvmrc`](../features/node-nvmrc/README.md)'s `node_modules` volume does —
this plan copies that Feature's volume shape line for line.

## Existing touchpoints

- `features/node-nvmrc/` — the template this plan follows most closely: a Feature that
  installs nothing itself (there it drives an nvm the _node_ Feature installs; here
  `install.sh` does the installing directly) and declares one `${devcontainerId}`-keyed
  volume at a workspace-relative path, with the same `projectDir`-can't-move-the-mount
  caveat and recipe.
- `features/devc-bridge/install.sh` — the template for downloading and verifying a release
  asset at build time: `fetch`/`sha256_of`/`have` helpers, checksum-before-install,
  same-directory `mv` so a failed build leaves no half-written binary. This plan reuses the
  shape with `sha512sum` in place of `sha256sum` (Godot's own checksum file is SHA-512).
- `features/README.md` — add a row (alphabetical: after `git-container-config`, before
  `node-nvmrc`).
- `features/PUBLISH_ALLOWLIST.txt` — add `godot` (alphabetical: same slot).
- `features/CONTRIBUTING.md` — add a "Per-Feature test inventory" entry and, if anything
  Godot-specific is worth flagging for future maintainers, a "Per-Feature maintainer notes"
  subsection (see node-nvmrc's and podman-as-docker's for the bar).
- `.plans/PLAN.md` — register under `### Pending`, matching the one-paragraph style already
  used for `keepawake-ping-telemetry`.

## Contracts

### `features/godot/devcontainer-feature.json`

```jsonc
{
  "id": "godot",
  "version": "0.1.0",
  "name": "Godot engine",
  "description": "Installs the Godot engine at build time — by default the latest stable release, resolved from godotengine/godot's own GitHub releases rather than a version this repo tracks — and declares a per-devcontainer volume for the project's .godot/ cache directory, the Godot 4 equivalent of node_modules. No editor GUI is required to use it: the same binary runs headless (`godot --headless ...`) for imports, exports and tests.",
  "documentationURL": "https://github.com/devc-tools/devc-tools/tree/main/features/godot",
  "licenseURL": "https://github.com/devc-tools/devc-tools/blob/main/LICENSE",
  "options": {
    "version": {
      "type": "string",
      "default": "latest",
      "description": "Godot version to install. 'latest' resolves the newest stable release from godotengine/godot at build time — this repo does not pin or track a version. Otherwise accepts a bare version ('4.7.2') or a full release tag ('4.7.2-stable'); both resolve to the same asset. Only 'stable' releases are ever selected — there is no option to install a beta/RC."
    },
    "installDependencies": {
      "type": "boolean",
      "default": true,
      "description": "apt-get install the shared libraries Godot dlopens at runtime and silently does without when absent — fontconfig, confirmed by this plan's own measurement to be missing from mcr.microsoft.com/devcontainers/base:ubuntu. Godot's Linux binary is otherwise statically linked (confirmed with ldd: only libc/libm/libpthread/librt/libdl) and dlopens X11/Wayland/ALSA/PulseAudio only when not running --headless, so this option does not chase every optional library — only the one shown to matter for headless import/export."
    },
    "projectDir": {
      "type": "string",
      "default": "",
      "description": "Workspace-relative directory that is the Godot project — where its .godot/ cache lives. Workspace-relative; an absolute value is used as-is; empty (the default) is the workspace root. The declared volume cannot follow this option (see node-nvmrc's own projectDir for why); a non-empty value makes the create-time step warn and print the mount line to paste into your own devcontainer.json instead of chowning a .godot the volume isn't actually backing."
    },
    "fixGodotDirOwnership": {
      "type": "boolean",
      "default": true,
      "description": "chown an existing ./.godot to the create-time user before Godot ever runs. Repairs the named volume mounted there, which first comes up root-owned — same rationale as node-nvmrc's fixNodeModulesOwnership."
    }
  },
  "mounts": [
    {
      "type": "volume",
      "source": "godot-project-cache-${devcontainerId}",
      "target": "${containerWorkspaceFolder}/.godot"
    }
  ],
  "postCreateCommand": "bash /usr/local/share/devc-features/godot/post-create.sh"
}
```

- Options reach `install.sh` uppercased with non-word characters stripped:
  `$VERSION`, `$INSTALLDEPENDENCIES`, `$PROJECTDIR`, `$FIXGODOTDIROWNERSHIP`. Booleans
  arrive as the strings `"true"`/`"false"`.
- **No `DEVC_TOOLS_RELEASE`-style pin.** That convention
  (`features/CONTRIBUTING.md`'s "Release pins") names a _devc-tools_ release this repo
  controls; `version: "latest"` here tracks an _upstream_ project's releases instead, which
  is what the `version` option is for. Do not conflate the two — this Feature has no
  devc-tools release to pin.
- **No `installsAfter`.** Unlike node-nvmrc (which orders behind a node Feature it does not
  install), this Feature has nothing else to order behind — see "Not in this plan" for the
  .NET/C# build, the one thing that would have introduced one.

### `features/godot/install.sh`

Runs as root at build time. Network required (download) whenever it runs — there is no
"Godot is already installed" skip to design around here the way `agents` has one, since a
Feature's `install.sh` runs exactly once per image build.

1. **Validate `version`.** Reject anything outside `[A-Za-z0-9_.-]` — it is interpolated
   into a URL and a directory name. `die` naming the option, not a generic parse error.
2. **Resolve the release tag.**
   - `version = "latest"`: follow the redirect from
     `https://github.com/godotengine/godot/releases/latest` (`curl -fsSL -o /dev/null -w
     '%{url_effective}'`) and take the final path segment as the tag (e.g.
     `4.7.2-stable`). **Deliberately not the GitHub API** (`api.github.com/.../releases/latest`) —
     the redirect needs no auth and does not share GitHub's much lower unauthenticated API
     rate limit, which every image build on a shared CI runner would otherwise compete for.
   - Otherwise: strip a trailing `-stable` if present, then append it back — so `4.7.2` and
     `4.7.2-stable` both produce `TAG=4.7.2-stable`. `BARE=${TAG%-stable}`.
3. **Map architecture** the same way `devc-bridge/install.sh` does (`uname -m` → `x86_64` /
   `arm64`; anything else `die`s).
4. **Asset name** — confirmed against the `4.7.2-stable` release: `Godot_v${TAG}_linux.${ARCH}.zip`,
   which unzips to **one flat file** at the zip root, named `Godot_v${TAG}_linux.${ARCH}` (no
   extension). Rename it to `godot` and that is the whole install.
5. **Download + verify.**
   `https://github.com/godotengine/godot/releases/download/${TAG}/SHA512-SUMS.txt` lists
   every asset in the release as `<sha512>  <filename>` (confirmed format, two-space
   separator, no `sha512sum -b`-style `*` prefix on this release — still strip a leading `*`
   defensively, the way `devc-bridge/install.sh`'s `checksums.txt` parse already does, in
   case a future release changes that). Fetch it and the asset into a `mktemp -d`, verify
   with `sha512sum`, `die` on any mismatch **before** unzipping — nothing partially
   installed.
6. **Ensure `unzip` exists.** Unlike node-nvmrc's nvm (an optional prerequisite this
   Feature documents rather than installs), `unzip` is load-bearing for what this Feature
   _is_ — `apt-get update && apt-get install -y --no-install-recommends unzip` when
   `command -v unzip` fails, not a warn-and-skip.
7. **Install layout**, mirroring devc-bridge's namespace:
   `/usr/local/share/devc-features/godot/bin/godot` (the renamed single file), `0755`,
   root-owned, then `mkdir -p "$(dirname "$LINK")" && ln -sfn <target> /usr/local/bin/godot`
   — the same unconditional symlink pattern as devc-bridge's `BRIDGE_LINK`, so a developer
   can shadow the install by bind-mounting over `/usr/local/share/devc-features/godot`.
8. **`installDependencies`** (default true): `apt-get update && apt-get install -y
   --no-install-recommends fontconfig`. This is not a general Godot-runtime-libraries
   installer — see the option's own description for why the set is this narrow, and the
   Validation section for how it was measured rather than assumed.
9. Print an install summary line (`godot: <TAG> (<ARCH>) installed at
   /usr/local/bin/godot`) the way devc-bridge's install does.
10. Write `/usr/local/share/devc-features/godot/post-create.sh` (below), with
    `PROJECT_DIR` and `FIX_GODOT_DIR_OWNERSHIP` **baked in** from the options — same reason
    node-nvmrc bakes its four options into its own create-time script: a Feature's
    `postCreateCommand` takes no arguments.

### `/usr/local/share/devc-features/godot/post-create.sh`

Contract, as a Feature-declared `postCreateCommand` (runs as the **remote user**, before any
user-provided `postCreateCommand`):

```sh
cd "${PROJECT_PATH:-$PWD}"                      # workspace root, node-nvmrc's own fallback
TARGET="${PROJECT_DIR:-.}"
if [ -n "$PROJECT_DIR" ]; then
  # the declared volume is always at the workspace root — same limitation node-nvmrc
  # documents for node_modules, same fix: warn and hand over the paste-able line.
  echo "godot: projectDir is set to '$PROJECT_DIR', but the .godot volume this Feature" >&2
  echo "godot: declares cannot follow it — it always mounts at the workspace root. Add:" >&2
  echo '  "mounts": ["type=volume,source=godot-project-cache-${devcontainerId},target=${containerWorkspaceFolder}/'"$PROJECT_DIR"'/.godot"]' >&2
  echo "godot: to your own devcontainer.json, or move the project to the workspace root." >&2
else
  [ "$FIX_GODOT_DIR_OWNERSHIP" = true ] && [ -d "$TARGET/.godot" ] &&
    command -v sudo >/dev/null 2>&1 &&
    sudo -n chown -R "$(id -u):$(id -g)" "$TARGET/.godot" 2>/dev/null || true
fi
```

- Best-effort exactly like node-nvmrc's `node_modules` chown: bounded to `.godot`, never
  the workspace itself, `sudo -n` so it cannot hang, never fails the create.
- No `godot --version` smoke check here — the binary was already proven to run at build
  time (step 9 above would have failed the build otherwise); create-time is for the mount,
  not for re-verifying the install.

## Concept boundaries

- **`.godot/` (this Feature's volume) vs. `~/.config/godot/` and `~/.local/share/godot/`.**
  The latter two hold the _global_ editor settings and the export-template cache — neither
  is project-local, neither is what the user asked to be mounted, and this Feature declares
  no volume for either. They are container-local and reset on rebuild, same as any other
  unmounted dotfile; out of scope here, not silently different from what was asked.
- **Export templates are not installed by this Feature.** `godot --export-release <preset>`
  needs `Godot_v<TAG>_export_templates.tpz` unpacked into
  `~/.local/share/godot/export_templates/<version>/` — a large, separate download this plan
  does not fetch. See "Not in this plan".
- **`/usr/local/share/devc-features/godot/`**, not `/usr/local/share/devc/` — the latter is
  devc's own baseline namespace; no Feature writes into it (see node-nvmrc's identical
  note).
- **`version` here is an upstream Godot release, not this Feature's own `version` field.**
  The manifest's `"version": "0.1.0"` is this Feature's, bumped when _this Feature_ changes;
  the option resolves a `godotengine/godot` tag and can move (via a rebuild) without this
  Feature changing at all.

## Checklist

- [x] `features/godot/devcontainer-feature.json` — id/version/name, four options,
      declared `.godot` volume, `postCreateCommand`
- [x] `features/godot/install.sh` — version validation, `latest` resolution via the
      release-page redirect (not the GitHub API), arch mapping, SHA-512
      verify-before-install, `unzip` self-heal, `installDependencies`, the `bin/godot`
      fixed path, `/usr/local/bin/godot` symlink, baking
      `PROJECT_DIR`/`FIX_GODOT_DIR_OWNERSHIP` into `post-create.sh`
- [x] `features/godot/post-create.sh` (the file `install.sh` installs) — `.godot` chown when
      `projectDir` is empty, warn-with-mount-line when it isn't
- [x] `features/godot/README.md` — what a bare `{}` gives you, the `.godot` volume recipe
      (copy node-nvmrc's `node_modules` section's structure), the options table, "what this
      is not" (no export templates, no C# support, no editor GUI dependencies installed),
      the `--headless` usage note
- [x] `features/godot/test/test.sh` — the default `{}` scenario
- [x] `features/godot/test/scenarios.json` + one script each: a pinned `version` (so the
      test is not itself pinned to whatever "latest" happens to be on the day it runs), a
      `projectDir` case (mirrors node-nvmrc's `project_subdir`)
- [x] `features/godot/test/run-features-test.sh` — the verbatim wrapper, copied per
      `features/CONTRIBUTING.md`
- [x] `features/godot/test/install_options_test.sh` — offline, real `install.sh` with
      `curl`/`unzip`/`apt-get` stubbed: version validation's reject/accept cases, `latest`
      vs. pinned vs. `X.Y.Z-stable` all resolving the tag the same way, a checksum mismatch
      aborting with nothing installed, the option bake into `post-create.sh`
- [x] `features/godot/test/post_create_test.sh` — offline, real `post-create.sh` against a
      temp `HOME`/workspace: chown fires when `.godot` exists and `projectDir` is empty,
      warns instead when `projectDir` is set, both are no-ops when `.godot` does not exist
- [x] `features/README.md` — row for this Feature (alphabetical slot: after
      `git-container-config`, before `node-nvmrc`)
- [ ] `features/PUBLISH_ALLOWLIST.txt` — add `godot` (same alphabetical slot) once the
      Feature is ready to publish — see `features/CONTRIBUTING.md`'s "publish allowlist" for
      why this is a separate, deliberate step from everything else in this checklist —
      **withheld**: no Docker in this environment, so none of the container-dependent
      validation below has run
- [x] `features/CONTRIBUTING.md` — "Per-Feature test inventory" entry; a "Per-Feature
      maintainer notes" subsection if the redirect-not-API resolution is worth flagging for
      a future maintainer touching this Feature without having just re-derived it
- [x] `.plans/PLAN.md` — register under `### Pending`, then move to Completed per this
      repo's existing convention when done

## Validation

- [x] `bash features/godot/test/install_options_test.sh` — offline (ALL PASS)
- [x] `bash features/godot/test/post_create_test.sh` — offline (ALL PASS)
- [x] `bash tests/features_test.sh --feature godot` — id/version/name/description guard
      (ALL PASS)
- [ ] (needs Docker + network) `bash features/godot/test/run-features-test.sh` — default
      scenario: `"godot": {}` on `mcr.microsoft.com/devcontainers/base:ubuntu`, asserting
      `godot --version` succeeds, `godot --headless --version` succeeds with no display, the
      version string matches whatever `latest` resolved to at build time, and the volume
      mounts at `${containerWorkspaceFolder}/.godot`
- [ ] (needs Docker + network) the pinned-`version` scenario — asserts the exact requested
      version string is what `godot --version` reports, independent of whatever "latest"
      currently is
- [ ] (needs Docker + network) the `projectDir` scenario — `.godot` created under the
      subdirectory is chowned correctly is **not** claimed (the volume can't follow
      `projectDir` — see Concept boundaries); assert instead that create emits the warning
      and the exact mount line on stderr
- [x] Already measured in this session (recorded here so a future re-verification has a
      baseline, not to be re-run as part of this plan): against the `4.7.2-stable` release,
      `ldd Godot_v4.7.2-stable_linux.x86_64` showed only `libc`/`libm`/`libpthread`/
      `librt`/`libdl`; `--version` printed `4.7.2.stable.official.<hash>` on exit 0 with a
      single `libfontconfig.so.1: cannot open shared object file` warning on stderr; the
      standard zip is one flat file at its root; `SHA512-SUMS.txt` lines are
      `<hash>  <filename>`, no `*` prefix; and the `releases/latest` redirect resolves to
      `.../releases/tag/4.7.2-stable` with no GitHub API call.

## Not in this plan

- **The .NET (C#) build.** Godot also ships a `_mono_linux_${ARCH}.zip` per release — a
  different asset layout (it unzips to a directory carrying a `GodotSharp/` tree the binary
  loads relative to itself, not a single flat file) and it needs a .NET SDK to compile
  project scripts, which this Feature would not install either way. Deliberately deferred
  until there's a concrete need for it; a `dotnetSupport`-shaped option can follow the same
  install.sh structure later without disturbing the standard-build path this plan builds.
- **Export templates.** `installExportTemplates` (or similar) fetching and unpacking
  `Godot_v<TAG>_export_templates.tpz` into `~/.local/share/godot/export_templates/<version>/`
  is a plausible follow-on option, deliberately deferred — it is a second, much larger
  per-platform download (the templates archive bundles export binaries for every export
  platform) that most headless import/test/CI use of this Feature will never need.
- **The editor GUI.** Nothing here sets up X11/Wayland forwarding, VNC, or any of the
  libraries the _interactive_ editor needs beyond what `installDependencies` already
  installs for headless use. A consumer who wants the GUI provides their own display
  forwarding the same way any other GUI-in-a-devcontainer setup does; this Feature does not
  gate on it either way.
- **Any devc baseline change.** This Feature is not added to devc's bundled
  `devcontainer.json` or to `devc-core/overlay.ts`'s baseline Features — it is an
  opt-in Feature a Godot project's own `devcontainer.json` declares, like
  `podman-as-docker` or `rootless-remap`.
