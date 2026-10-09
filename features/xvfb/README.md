# xvfb (devcontainer Feature)

Installs [Xvfb](https://www.x.org/releases/current/doc/man/man1/Xvfb.1.xhtml) — an X server
that draws into memory instead of onto a screen — together with the shared libraries GUI
programs need to actually render into it, and one command, `xvfb-ensure`, that starts or
reuses a virtual display and tells you the `DISPLAY` to use.

```jsonc
"features": {
  "ghcr.io/devc-tools/features/xvfb:0": {}
}
```

No options you have to set, nothing host-side. A bare `{}` installs Xvfb, the generic X client
libraries, software OpenGL (Mesa llvmpipe) and one base font — enough for a GL program to open
a window and render real frames with no GPU and no screen. It **starts nothing** and **sets no
`DISPLAY`**: a program opts in per command.

```sh
eval "$(xvfb-ensure)" && my-gui-program
```

> The tag tracks **this Feature's own** version line, not the devc-tools release. It is `:0`
> while this Feature is pre-1.0.

Debian and Ubuntu base images only — everything is installed with `apt-get`, at build time.

## Using the display

Two commands, for two different lifetimes:

| Command                 | What you get                                                                      | Reach for it when                                                                     |
| ----------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `eval "$(xvfb-ensure)"` | One shared server that **persists** across commands; `DISPLAY` set in your shell. | Several commands should see the same display, or you want to look at it between them. |
| `xvfb-run -a <cmd>`     | A private server for that one command, torn down when it exits.                   | A single self-contained run, such as one test command in CI.                          |

`xvfb-run` is Debian's own script and comes with the `xvfb` package; this Feature does not wrap
or replace it. `xvfb-ensure` is this Feature's.

### `xvfb-ensure`

```
xvfb-ensure [--display <N>] [--screen <W>x<H>x<D>]   start or reuse a display
xvfb-ensure --status [--display <N>]                 report only, start nothing
xvfb-ensure --stop [--display <N>]                   stop servers this command started
```

It prints exactly one line on stdout — `export DISPLAY=":99"` — and everything else on stderr,
which is what makes the `eval` form work. In order, it:

1. reuses the display `$DISPLAY` already names, if a server answers there;
2. otherwise reuses a server already answering on display 99, or one of the five after it;
3. otherwise starts one on the first of those numbers that is free.

A server it starts is detached from the shell that asked for it, so it is still there for the
next command — including when each command runs in a fresh shell, the way an agent's shell tool
runs them. Calling `xvfb-ensure` again is always safe: it prints the same line and starts
nothing. Logs go to `/tmp/xvfb-<N>.log`.

`--status` exits 0 and prints the line if a display is up, and exits 1 printing nothing if not.
`--stop` stops only servers `xvfb-ensure` itself started — never an X server something else is
running — and exits 0 even when there was nothing to stop.

**A display that already works wins.** VS Code can forward a host X display into the container
on some setups, and step 1 reuses it: you asked for a display and there is one. If it must be
the virtual one, pass `--display` (which skips step 1) or `unset DISPLAY` first:

```sh
eval "$(xvfb-ensure --display 99)"
```

## Options

| Option                  | Default          | Meaning                                                                                                                                                |
| ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `x11Libraries`          | `true`           | The generic X client libraries: `libx11-6 libxext6 libxi6 libxrandr2 libxcursor1 libxinerama1 libxrender1 libxkbcommon0 libfontconfig1`.               |
| `openGL`                | `true`           | Software OpenGL: `libgl1 libegl1 libgl1-mesa-dri` (Mesa llvmpipe).                                                                                     |
| `fonts`                 | `true`           | `fonts-dejavu-core` — one base font. With none installed, text renders as nothing at all.                                                              |
| `vulkan`                | `false`          | Software Vulkan: `libvulkan1 mesa-vulkan-drivers` (Mesa lavapipe).                                                                                     |
| `tools`                 | `false`          | `imagemagick xdotool` — screenshots of the whole display (`import -window root shot.png`) and synthetic input.                                         |
| `extraPackages`         | `""`             | Comma-separated apt packages to install as well — one application's own runtime dependencies. See [`extraPackages`](#extrapackages-and-the-t64-names). |
| `display`               | `"99"`           | Display number `xvfb-ensure` starts on by default. Digits only: `"99"` means `DISPLAY=:99`.                                                            |
| `screen`                | `"1920x1080x24"` | Size and colour depth of the screen `xvfb-ensure` starts, `<width>x<height>x<depth>`; depth is 8, 16, 24 or 32.                                        |
| `startOnContainerStart` | `false`          | Run `xvfb-ensure` on every container start, so a display is up before anything asks. Still sets no `DISPLAY`.                                          |

`xvfb`, `xauth` (which `xvfb-run` needs) and `x11-utils` (for `xdpyinfo`) are always installed,
whatever the options say.

The groups are things _any_ program using the display may need: the display, the generic X
client side, software rendering into it, fonts, and tools that act on the display. One
application family's own dependency list is not a group — it goes in `extraPackages`.

### `extraPackages` and the `t64` names

Ubuntu 24.04 renamed a number of libraries with a `t64` suffix (`libgtk-3-0` became
`libgtk-3-0t64`); Ubuntu 22.04 and Debian bookworm only have the old names. So that one list
works on both, a name you write ending in `t64` is installed as written where the base image
knows it, and without the suffix where it does not. Write the 24.04 names. If neither form
exists the build fails and names both.

Each entry must be a plain package name — lowercase letters, digits, `.`, `+` and `-`. A
version pin (`pkg=1.2`) or an architecture qualifier (`pkg:amd64`) fails the build.

## Recipes

### Godot — screenshots and `--write-movie`

Godot's `--headless` selects a dummy renderer: it draws nothing, and `--write-movie` refuses to
run under it. Real frames need a display and a GL driver, which is what a bare `{}` of this
Feature provides. With the [`godot`](../godot/README.md) Feature alongside:

```jsonc
"features": {
  "ghcr.io/devc-tools/features/godot:0": {},
  "ghcr.io/devc-tools/features/xvfb:0": {}
}
```

```sh
eval "$(xvfb-ensure)"
godot --path . --rendering-driver opengl3 --audio-driver Dummy \
  --fixed-fps 60 --write-movie out/frame.png --quit-after 3 res://level1.tscn
```

That writes one PNG per frame (`out/frame00000000.png`, …). Pass `--rendering-driver opengl3`
and do **not** pass `--headless`. A project using the Forward+ or Mobile renderer needs
`"vulkan": true` instead, and no `--rendering-driver` override.

Capturing from inside the game — `get_viewport().get_texture().get_image().save_png(...)` —
works the same way and needs nothing more. Both capture Godot's own output, so neither needs
the `tools` group; that is for a picture of the whole X screen.

### Aseprite

Aseprite is a GUI binary that links the X and GL client libraries whatever you ask it to do. A
bare `{}` covers its library list (`libx11-6 libfontconfig1 libxcursor1 libgl1 libxext6 libxi6
libxrandr2`), which is all `--batch` needs — measured on 1.3.17, batch scripting and
conversion run with no display at all:

```sh
aseprite --batch sprite.aseprite --save-as sprite.png
```

Anything that opens its window does need the display; without one Aseprite crashes on start:

```sh
eval "$(xvfb-ensure)"
aseprite &
```

### VS Code extension tests

Extension tests launch a real VS Code, which is an Electron app and needs a display. Electron's
own runtime libraries are not part of this Feature's groups — it needs them with any display,
not just this one — so pass them through `extraPackages`:

```jsonc
"features": {
  "ghcr.io/devc-tools/features/xvfb:0": {
    "extraPackages": "libgtk-3-0t64,libnss3,libasound2t64,libgbm1,libxss1,libxkbfile1,libsecret-1-0,libxshmfence1,libdrm2,libatk-bridge2.0-0t64,libcups2t64"
  }
}
```

```sh
eval "$(xvfb-ensure)" && npm test
```

or, for a single run that needs nothing left behind, `xvfb-run -a npm test`.

## Making the display global

Nothing here exports `DISPLAY` for you, deliberately. A Feature cannot make an environment
variable depend on one of its options, so exporting it would point every process in the
container at a display that — by default — does not exist. And where one does exist, anything
that opens a GUI prompt when it sees a display (a credential helper, `xdg-open`, an editor)
would open it where nobody can see it, instead of failing straight away.

If you do want every process to use the virtual display, that is two lines in your own
`devcontainer.json`:

```jsonc
"features": {
  "ghcr.io/devc-tools/features/xvfb:0": { "startOnContainerStart": true }
},
"remoteEnv": { "DISPLAY": ":99" }
```

`:99` has to match the `display` option; change both together.

## What it does

At **build time** it runs one `apt-get install` for Xvfb and every group and extra package you
asked for, and installs `xvfb-ensure` at `/usr/local/share/devc-features/xvfb/bin/xvfb-ensure`,
symlinked from `/usr/local/bin/xvfb-ensure`, with your `display` and `screen` baked in.
Nothing is installed later: `xvfb-ensure` never calls `apt-get`.

At **every container start** it runs a small script that does nothing unless
`startOnContainerStart` is on, in which case it runs `xvfb-ensure` — a server is a process and
does not survive a container stop. That script can never fail the start.

It declares no mounts, no environment variables and no capabilities, and leaves nothing in your
workspace: logs and pidfiles go to `/tmp`.

## What this is not

**Not a way to watch the display.** There is no VNC or noVNC here; nothing shows a human what
is on the virtual screen. `tools`' `import -window root shot.png` takes a still of it.

**Not GPU rendering.** Everything is software — llvmpipe for OpenGL, lavapipe for Vulkan. That
is slow next to a GPU and entirely adequate for screenshots, frame capture and tests.

**Not Wayland.** X11 only.

**Not an application installer.** It installs no Godot, no Aseprite and no VS Code, and it does
not depend on the `godot` Feature or the other way round.
