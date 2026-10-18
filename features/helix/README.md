# helix (devcontainer Feature)

Installs the [Helix](https://helix-editor.com) terminal editor (`hx`) at build time, with its
prebuilt tree-sitter grammars and queries, from helix-editor/helix's own release tarball.

```jsonc
"features": {
  "ghcr.io/devc-tools/features/helix:0": {}
}
```

No options you have to set, nothing host-side. A bare `{}` installs the **latest** release for
the container's own architecture (`x86_64` or `aarch64`), puts `hx` on `PATH`, and sets
`HELIX_RUNTIME` so it finds its grammars without any config.

> The tag tracks **this Feature's own** version line, not the devc-tools release, and not the
> Helix version it installs. It is `:0` while this Feature is pre-1.0.

## Making it your editor

The Feature sets no `EDITOR`: which editor you use is your call, and a Feature cannot set an
environment variable depending on an option. Set it where you keep your shell preferences. With
devc, that is a script in `~/.config/devc/shell/` (see devc's README):

```sh
# ~/.config/devc/shell/10-prefs.sh
export EDITOR=hx
```

`devc web` runs `${EDITOR:-vi}` for **Open in editor**, so that line is all it takes.

## Language servers

Helix's LSP client is built in, with no plugin manager and no config file: a language server on
`PATH` is picked up as it is. This Feature installs none. `hx --health` lists every language and
which of its servers were found; `hx --health typescript` shows one.

Helix maps `.ts` to `typescript-language-server`. For a Deno project, point it at `deno lsp`
in the project's own `.helix/languages.toml`:

```toml
[language-server.deno-lsp]
command = "deno"
args = ["lsp"]
config.deno.enable = true

[[language]]
name = "typescript"
roots = ["deno.json", "deno.jsonc"]
language-servers = ["deno-lsp"]
```

## Options

| Option    | Default    | Meaning                                                                                                         |
| --------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| `version` | `"latest"` | A Helix release tag (`25.07.1`), or `latest`, resolved from helix-editor/helix's GitHub releases at build time. |

## What it installs

| Path                           | What                                                     |
| ------------------------------ | -------------------------------------------------------- |
| `/usr/local/lib/helix/hx`      | The release binary.                                      |
| `/usr/local/lib/helix/runtime` | Grammars, queries and themes (`HELIX_RUNTIME` names it). |
| `/usr/local/bin/hx`            | A symlink to the binary.                                 |

Helix's releases publish no checksums, so the download is trusted on HTTPS alone. The binary
links glibc: on a musl base (Alpine) the install fails rather than leaving an `hx` that cannot
start.

## What this is not

- No language servers, formatters or debug adapters.
- No user config (`~/.config/helix/`), and no `EDITOR`.
