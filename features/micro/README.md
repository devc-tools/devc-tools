# micro (devcontainer Feature)

Installs the [micro](https://micro-editor.github.io) terminal editor at build time from
micro-editor/micro's own release tarball, verified against the release's published SHA-256.

```jsonc
"features": {
  "ghcr.io/devc-tools/features/micro:0": {}
}
```

A bare `{}` needs no options and nothing host-side. It installs the **latest** release for the
container's own architecture (`x86_64` or `aarch64`) at `/usr/local/bin/micro`.

> The tag tracks **this Feature's own** version line, not the devc-tools release, and not the
> micro version it installs. It is `:0` while this Feature is pre-1.0.

## Why micro

micro is non-modal: it behaves like a desktop editor that runs in a terminal.

- **Typing inserts text.** There is no normal mode or insert mode.
- **The usual shortcuts work:** Ctrl+S saves, Ctrl+Q quits, Ctrl+Z undoes, Ctrl+F finds, and
  Ctrl+C / Ctrl+X / Ctrl+V copy, cut and paste.
- **The mouse works:** click to place the cursor, drag to select.
- **Ctrl+G** opens the help, which includes every key binding.
- **Syntax highlighting** covers over a hundred languages, with no config.

It has no language-server support built in. Its `lsp` plugin adds that
(`micro -plugin install lsp`).

## Making it your editor

`devc web`'s **Open in editor** runs `$EDITOR`. When that is unset, it runs the first of `micro`,
`nano` and `vi` that is installed, so with this Feature there is nothing to set.

The Feature sets no `EDITOR` itself: which editor everything else uses (`git commit`, `crontab
-e`) is your call. To make micro that editor, set it where you keep your shell preferences. With
devc, that is a script in `~/.config/devc/shell/` (see devc's README):

```sh
# ~/.config/devc/shell/10-prefs.sh
export EDITOR=micro
```

## Options

| Option    | Default    | Meaning                                                                                                                                    |
| --------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `version` | `"latest"` | A micro release (`2.0.15`, or `v2.0.15` as GitHub tags it), or `latest`, resolved from micro-editor/micro's GitHub releases at build time. |

## What it installs

| Path                   | What                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `/usr/local/bin/micro` | The release binary (`linux64-static` or `linux-arm64`; both are static, so a musl base works too). |

The download is checked against the `.sha` file published beside each release asset, and a
mismatch fails the build.

## What this is not

- No plugins, color schemes or user config (`~/.config/micro/`).
- No `EDITOR`.
