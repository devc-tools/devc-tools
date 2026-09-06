# godot (devcontainer Feature)

Installs the [Godot](https://godotengine.org) engine at build time and declares a
per-devcontainer volume for the project's `.godot/` cache directory — the Godot 4 equivalent
of `node_modules`.

```jsonc
"features": {
  "ghcr.io/devc-tools/features/godot:0": {}
}
```

No options you have to set, nothing host-side. A bare `{}` installs the **latest stable**
release for the container's own architecture and puts `godot` on `PATH`. It declares one
volume for `.godot/` — see [The `.godot` volume](#the-godot-volume).

> The tag tracks **this Feature's own** version line, not the devc-tools release, and not the
> Godot version it installs. It is `:0` while this Feature is pre-1.0.

## Headless — no editor GUI required

The same binary this Feature installs runs headless, which is what most container use of
Godot actually wants — imports, exports, and running tests in CI:

```sh
godot --headless --import
godot --headless --export-release "Linux/X11" build/game
godot --headless --script res://run_tests.gd
```

Nothing here sets up X11/Wayland forwarding or any of the libraries the _interactive_ editor
needs beyond what `installDependencies` already installs for headless use. See
[What this is not](#what-this-is-not).

## Which version gets installed

`version` defaults to `"latest"`, resolved from
[`godotengine/godot`](https://github.com/godotengine/godot)'s own GitHub releases **at build
time** — this repo does not pin or track a Godot version. Only `stable` releases are ever
selected; there is no option to install a beta or RC.

```jsonc
"ghcr.io/devc-tools/features/godot:0": { "version": "4.7.2" }
```

A bare version (`4.7.2`) and a full release tag (`4.7.2-stable`) both resolve to the same
asset. Because `"latest"` is resolved at build time, rebuilding on a different day can install
a different Godot version — pin `version` if you need the exact version reproducible across
rebuilds.

## Options

| Option                 | Default               | Meaning                                                                                        |
| ---------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `version`              | `"latest"`            | Godot version to install: `"latest"`, a bare version, or a full `-stable` tag.                 |
| `installDependencies`  | `true`                | `apt-get install` the shared libraries Godot dlopens at runtime — currently just `fontconfig`. |
| `projectDir`           | `""` (workspace root) | The directory that **is** the Godot project: where its `.godot/` cache lives.                  |
| `fixGodotDirOwnership` | `true`                | `chown` an existing `./.godot` to the create-time user before Godot ever runs.                 |

`projectDir` is workspace-relative by default; an absolute value is used as-is; empty (the
default) is the workspace root.

## What it does

At **build time** it downloads the resolved release's Linux asset for the container's own
architecture, verifies it against the release's own `SHA512-SUMS.txt` before unpacking
anything, and installs it at `/usr/local/share/devc-features/godot/bin/godot`, symlinked from
`/usr/local/bin/godot`. `installDependencies` (default on) then installs `fontconfig`, the one
shared library shown to matter for headless import/export on
`mcr.microsoft.com/devcontainers/base:ubuntu` — Godot's Linux binary is otherwise statically
linked.

At **create time**, before any `postCreateCommand` of your own, it repairs `.godot/` ownership
— see [The `.godot` volume chown](#the-godot-volume-chown) — or warns when `projectDir` means
the declared volume isn't where your project actually is.

## The `.godot` volume

This Feature declares its own:

```jsonc
{
  "type": "volume",
  "source": "godot-project-cache-${devcontainerId}",
  "target": "${containerWorkspaceFolder}/.godot"
}
```

Godot 4 replaced Godot 3's `.import/` folder with a project-local `.godot/` directory: editor
cache, the asset import cache, and `global_script_class_cache.cfg`. It is exactly the shape
`node_modules` is for Node — a large, disposable, frequently-rewritten build artifact that sits
inside the project tree. Left on the bind-mounted workspace it inherits the host bind mount's
I/O cost (real on Docker Desktop for Mac/Windows) and can carry host-OS-specific cache entries
into a Linux container. A named volume avoids both.

`${devcontainerId}` keys it per devcontainer — not the workspace folder name, which collides
whenever two workspaces share one (a `<repo>.worktrees/<branch>` layout names the folder after
the branch, so `main` in three repos is one name). The trade is that the volume name is opaque
and **moving the workspace on disk starts a fresh one** — one re-import, and the old volume is
left behind untouched.

**It does not follow `projectDir`.** A Feature option cannot substitute into that Feature's own
`mounts`, so the volume is always at the workspace root. With `projectDir` set, the create-time
step warns and gives you the line to paste:

```jsonc
"mounts": ["type=volume,source=godot-project-cache-${devcontainerId},target=${containerWorkspaceFolder}/your/project/dir/.godot"]
```

**You cannot remove a declared mount — only override it.** Mounts merge keyed on **target**,
with your own `devcontainer.json` merged last, so declaring the same target yourself wins with
no duplicate and no error.

### The `.godot` volume chown

A named volume mounted at `.godot` first comes up root-owned, after which Godot running as the
remote user cannot write into it. The create-time step repairs that with `sudo -n chown -R`,
guarded on `sudo` existing and the directory existing, and best-effort so it can never fail the
create. Set `fixGodotDirOwnership` to `false` if you would rather it never ran.

## What this is not

**No export templates.** `godot --export-release <preset>` needs
`Godot_v<version>_export_templates.tpz` unpacked into
`~/.local/share/godot/export_templates/<version>/` — a large, separate download this Feature
does not fetch. Most headless import/test/CI use of this Feature will never need it.

**No .NET (C#) support.** Godot also ships a `_mono_linux_<arch>.zip` per release — a different
asset layout that needs a .NET SDK to compile project scripts, which this Feature does not
install either way.

**No editor GUI dependencies.** Nothing here sets up X11/Wayland forwarding, VNC, or any of the
libraries the _interactive_ editor needs beyond what `installDependencies` already installs for
headless use. A consumer who wants the GUI provides their own display forwarding the same way
any other GUI-in-a-devcontainer setup does.

**`.godot/` is not `~/.config/godot/` or `~/.local/share/godot/`.** Those two hold the _global_
editor settings and the export-template cache — neither is project-local, and this Feature
declares no volume for either. They are container-local and reset on rebuild, same as any other
unmounted dotfile.
