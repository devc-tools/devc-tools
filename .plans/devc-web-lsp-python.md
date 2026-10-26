# devc-web-lsp-python

## Checklist

- [ ] `features/python-lsp/devcontainer-feature.json`, per [Manifest](#manifest)
- [ ] `features/python-lsp/install.sh`, per [install.sh](#installsh)
- [ ] `features/python-lsp/devc-lsp-python`, the launcher, per [Launcher](#launcher)
- [ ] `features/python-lsp/README.md`, per [README](#readme)
- [ ] Offline harness `features/python-lsp/test/launcher_test.sh`, per [Tests](#tests)
- [ ] Offline install test `features/python-lsp/test/install_options_test.sh`, per
      [Tests](#tests)
- [ ] `features/python-lsp/basedpyright/package.json` and `package-lock.json`, per
      [install.sh](#installsh)
- [ ] Docker scenarios: `test/test.sh`, `test/scenarios.json` plus one script per scenario,
      `test/run-features-test.sh` (copied unchanged from `features/xvfb/test/`)
- [ ] `features/README.md`: a row for `python-lsp`
- [ ] `features/CONTRIBUTING.md`: per-Feature test inventory entry and a `### python-lsp` note
- [ ] `devc/README.md`: the **Language servers** bullet names `python-lsp`
- [ ] Run every [Validation](#validation) item an agent can run; hand the **(human)** and
      **(Docker host)** items to the user
- [ ] Add `python-lsp` to `features/PUBLISH_ALLOWLIST.txt`, **only after** the user reports the
      Docker scenarios pass
- [ ] `deno fmt` every touched `.md` and `.json` file

**Depends on [devc-web-lsp-core](archived/devc-web-lsp-core.md)** being complete: this plan ships a
launcher that satisfies its [launcher contract](devc-web-lsp-core.md#launcher-contract). devc
web itself does not change here. It is self-contained: nothing here depends on the TypeScript
or Java plans having been implemented. When `typescript-lsp` already exists, copy its shared
`install.sh` steps rather than rewriting them (Features don't share code, per
`features/CONTRIBUTING.md`).

**Who runs what.** Items marked **(Docker host)** need a machine with Docker (the devcontainer
has none; see `docs/maintainers/manual-verification.md`). Items marked **(human)** also need
devc web on the host and a browser. Everything else runs in the devcontainer.

A new Feature, `python-lsp`, gives devc web Python intelligence through **basedpyright**,
rooted at the **nearest** `pyproject.toml` / `setup.py` / `setup.cfg` above the file. A
container may hold several Python projects, each with its own interpreter. devc web's
**Language server settings…** sets the root, interpreter, `typeCheckingMode` and extra settings
**per project** ([core plan](devc-web-lsp-core.md#per-project-settings-lsp_configts)). The
Feature's options are container-wide defaults, and without either the interpreter is found by
convention. Measurements behind the root and server choices are in
[design/devc-web-language-services.md § Python](design/devc-web-language-services.md#python).

## Concept boundaries

- **Root on the Python project, not the repo.** On deephaven-core, rooting at the repo made
  pyright and basedpyright scan the whole monorepo for over 20 s. It also made four of five
  servers resolve `deephaven` from the installed wheel in `site-packages`, so go-to-definition
  opened a stale copy. Rooted at `py/server`, every server resolved to the source. A repo with
  several Python projects gets one session per project.
- **Why basedpyright:** the most complete of the mature servers (semantic tokens, inlay hints,
  builtin docstrings), MIT-licensed, push diagnostics. ty (fastest, pre-1.0, pull diagnostics)
  is the candidate to revisit later. The server is not an option in 0.1.0.
- **Self-contained runtime.** basedpyright's npm package runs on the Feature's own pinned Node.
  The image needs no Node, and no Python at build time; its PyPI package needs Python ≥ 3.10.
  The project's interpreter is only read, at run time.
- **The interpreter is never installed or created.** No venv is made and no `pip` is run.
- **No lint server** (`ruff server`): a later plan.

## Contracts

### Manifest

```json
{
  "id": "python-lsp",
  "version": "0.1.0",
  "name": "Python language server for devc web",
  "description": "Installs devc-lsp-python, the launcher devc web uses for Python intelligence: basedpyright, rooted at the nearest pyproject.toml/setup.py/setup.cfg, using the interpreter you name or <root>/.venv, $VIRTUAL_ENV, or python3 on PATH. Brings its own Node; installs nothing into your environment.",
  "documentationURL": "https://github.com/devc-tools/devc-tools/tree/main/features/python-lsp",
  "licenseURL": "https://github.com/devc-tools/devc-tools/blob/main/LICENSE",
  "options": {
    "python": {
      "type": "string",
      "default": "",
      "description": "Absolute path of the Python interpreter to analyze against, e.g. /usr/local/share/deephaven-core/venv/bin/python. Empty: <root>/.venv/bin/python, then $VIRTUAL_ENV/bin/python, then python3 on PATH."
    },
    "typeCheckingMode": {
      "type": "string",
      "enum": ["off", "basic", "standard", "strict", "recommended", "all"],
      "default": "standard",
      "description": "basedpyright's typeCheckingMode. standard matches pyright's default noise level; basedpyright's own default (recommended) reports considerably more."
    },
    "settings": {
      "type": "string",
      "default": "{}",
      "description": "A JSON object deep-merged into the settings devc web gives basedpyright (workspace/configuration), e.g. {\"basedpyright\":{\"analysis\":{\"extraPaths\":[\"src\"]}}}."
    }
  }
}
```

### install.sh

Runs as root at build time. `set -e`, `LC_ALL=C`, and a `die()` with the prefix
`python-lsp:`, in the style of `features/xvfb/install.sh`. Install paths come from overridable
variables for the offline test: `SHARE_DIR` (default `/usr/local/share/devc-features/python-lsp`)
and `BIN_DIR` (default `/usr/local/bin`).

1. **Validate.**
   - `PYTHON` (from the `python` option) must be empty or an absolute path with no whitespace
     and no `"`. Otherwise `die "python must be an absolute path"`. It is not checked for
     existence, since the venv may be created after the image is built.
   - `SETTINGS` must parse as a JSON object; check it with the private Node after step 3.
   - `TYPECHECKINGMODE` is enforced by the manifest's `enum`.
2. **Fetch tools.** `curl`, `ca-certificates`, `tar` and `gzip` must be present. If `curl` is
   missing and `apt-get` exists, `apt-get update && apt-get install -y --no-install-recommends
   curl ca-certificates`. Otherwise `die "curl is required"`.
3. **Private Node v24.22.1** at `$SHARE_DIR/node`.
   - Map `uname -m`: `x86_64` → `x64`, `aarch64` or `arm64` → `arm64`; anything else is
     `die "unsupported architecture: <uname -m>"`.
   - Download `https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-<arch>.tar.gz`, verify it
     against the sha256 baked into `install.sh` (not fetched; mismatch is
     `die "node checksum mismatch"`), and extract with `--strip-components=1`.
   - Pins, from `https://nodejs.org/dist/v24.22.1/SHASUMS256.txt`:

     ```sh
     NODE_VERSION='24.22.1'
     NODE_SHA256_X64='eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c'
     NODE_SHA256_ARM64='33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3'
     ```

4. **basedpyright 1.40.2, fully locked.** The Feature ships `basedpyright/package.json`
   (`{"private": true, "dependencies": {"basedpyright": "1.40.2"}}`) and
   `basedpyright/package-lock.json`, generated once by the implementer with the pinned Node's
   npm (`npm install --package-lock-only` in that folder) and committed. `install.sh` copies
   both to `$SHARE_DIR/basedpyright` and runs
   `PATH=<node>/bin:$PATH npm ci --prefix <that dir> --omit=dev --no-audit --no-fund`. The entry
   point is `<prefix>/node_modules/basedpyright/langserver.index.js`.
   - **Gotcha:** the package also declares `pyright` and `pyright-langserver` bins. Never link
     `<prefix>/node_modules/.bin` onto `PATH`, or it shadows a user's own pyright.
5. **Launcher.** `$BIN_DIR/devc-lsp-python`, `0755`, with `PYTHON`, `TYPECHECKINGMODE` and
   `SETTINGS` baked in.
   - The launcher source holds exactly these lines, which run unbaked as "use the built-in
     default":

     ```js
     const BAKED_PYTHON = '';
     const BAKED_TYPECHECKINGMODE = '';
     const BAKED_SETTINGS = '';
     ```

   - `install.sh` has a `bake_js <file> <name> <value>`, adapted from `features/xvfb`'s
     `bake()` (awk with the line passed as `-v`, then `grep -qxF` to confirm, else
     `die "could not bake <name>"`). It replaces the line starting `const <name> =` with
     `const <name> = '<b64>';`, where `<b64>` is `printf %s "$value" | base64 -w0`.
     **Gotcha:** without `-w0`, GNU `base64` wraps at 76 characters and a long `settings` value
     breaks the one-line bake.
   - The launcher decodes with `Buffer.from(v, 'base64').toString('utf8')`; `''` means unset.
6. `chmod -R a+rX` on everything installed.

### Launcher

`devc-lsp-python` is an ES module run by the private Node. Its shebang is
`#!/usr/local/share/devc-features/python-lsp/node/bin/node`. It uses Node built-ins only.

**`describe <file> [--root <dir>] [--options <b64>]`:**

Each option's value is the per-project value from `--options` if present, else the baked
Feature value, else the built-in default. That includes `settings`: a per-project `settings`
replaces the baked one (no merge), and the chosen object is deep-merged over the computed
settings (objects merge recursively, anything else is replaced), per the
[core contract](devc-web-lsp-core.md#launcher-contract).

Invalid `--options` exit 1 with a one-line reason: bad base64 or JSON, not an object, `python`
not an absolute path, `typeCheckingMode` not one of the six, `settings` not an object.
**Gotcha:** `Buffer.from(s, 'base64')` never throws; decode, then `JSON.parse` in a `try`, then
check types.

1. **Language id.** Extension `py` or `pyi` → `python`. Anything else exits 3 with
   `not a Python file`.
2. **Top.** `git -C <dir of file> rev-parse --show-toplevel`. If that fails (not a repo, or
   unsafe ownership), top is `/`.
3. **Root.**
   - `--root` when given. It must be the file's directory or an ancestor, else exit 3.
   - Otherwise the **nearest** directory, from the file's directory up to and including top,
     holding `pyproject.toml`, `setup.py` or `setup.cfg`. With none, it is top, or the file's
     directory when top is `/`.
4. **Interpreter.** The first that exists and is executable:
   1. the `python` option (per project, else baked)
   2. `<root>/.venv/bin/python`
   3. `$VIRTUAL_ENV/bin/python`
   4. `python3` on `PATH`

   If the `python` option is set but not executable, exit 1 with
   `python option <path> is not executable`, so a broken config is visible, not silently
   replaced. If none is found, the `python` key is left out of `settings` entirely (not
   `{}`), and the server is `basedpyright 1.40.2`.
5. **Python version.** `<interp> -c 'import sys; print("%d.%d" % sys.version_info[:2])'` with a
   5 s timeout. Omit it on failure.
6. **Output.**
   - server `basedpyright 1.40.2 (Python 3.12)`, or `basedpyright 1.40.2` without a version
   - `initializationOptions` `{}`
   - `settings`
     `{"python": {"pythonPath": <interp>}, "basedpyright": {"analysis": {"typeCheckingMode": <option>, "diagnosticMode": "openFilesOnly"}}}`,
     deep-merged with the `settings` option

**`options`** prints:

- `python`: path; default the baked value
- `typeCheckingMode`: enum (the manifest's six values); default the baked value
- `settings`: json; default the baked value

**`serve --root <root> [--options <b64>]`** spawns
`<node> <prefix>/node_modules/basedpyright/langserver.index.js --stdio` with `stdio: 'inherit'`
and `cwd: root`. It forwards `SIGTERM` and `SIGINT` and exits with the child's code.

### README

- What a bare `{}` gives.
- The root rule, with the deephaven-core example: `py/server` and `py/client` are separate
  sessions, and why rooting at the repo is wrong when the package is also installed
  non-editable.
- The interpreter order.
- deephaven-core: in devc web, **Language server settings…** on a `py/server` file sets
  **Python** to `/usr/local/share/deephaven-core/venv/bin/python` for that project only. The
  container-wide alternative, when every Python project there shares the venv:
  `"ghcr.io/devc-tools/features/python-lsp:0": {"python": "/usr/local/share/deephaven-core/venv/bin/python"}`.
- The `typeCheckingMode` and `settings` options.
- Note that a project's own checks (mypy, ruff) can disagree with basedpyright.
- Disk use: Node about 100 MB plus basedpyright about 30 MB. Memory: about 600 MB per root.

## Gotchas

- **`diagnosticMode: "openFilesOnly"`.** devc web shows diagnostics for open files only, and
  workspace mode makes basedpyright analyze the whole root on start.
- **Compiled modules without stubs** (deephaven's `jpy`) resolve as `Unknown` in basedpyright.
  ty reported them as unresolved imports, which is one more reason not to use ty yet.
- **Importing `deephaven` needs a running JVM.** basedpyright never imports project modules, so
  this does not matter; do not add anything that does.
- **External edits are seen only through the core's watcher.** basedpyright did not notice
  on-disk changes until `workspace/didChangeWatchedFiles` arrived. It registers watchers on
  start, which the core honors. The validation checks it.

## Tests

`test/launcher_test.sh` (offline, needs `node`, `git` and `python3`). It builds fixtures in
`mktemp -d` and runs `node features/python-lsp/devc-lsp-python describe …`. Baked values are
changed by editing a copy of the launcher.

| Fixture                                                                                                                     | Expect                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| git repo, `py/server/pyproject.toml`, file `py/server/pkg/a.py`                                                             | root = `<repo>/py/server`                                                                         |
| same plus `<repo>/pyproject.toml`                                                                                           | root still `<repo>/py/server` (nearest)                                                           |
| git repo, no markers, file `x/a.py`                                                                                         | root = repo                                                                                       |
| `<root>/.venv/bin/python` (a symlink to `python3`)                                                                          | `pythonPath` = that path                                                                          |
| no `.venv`, `VIRTUAL_ENV=<dir>` with `bin/python`                                                                           | `pythonPath` = `<dir>/bin/python`                                                                 |
| neither                                                                                                                     | `pythonPath` = `command -v python3`                                                               |
| neither, and `PATH` without `python3` (a temp dir holding only symlinks to `node` and `git`)                                | `settings` has no `python` key; server `basedpyright 1.40.2`                                      |
| baked `SETTINGS` `{"a":{"b":1}}`, `--options` base64 `{"settings":{"a":{"c":2}}}`                                           | settings has `a.c` = 2 and no `a.b`                                                               |
| `--options` = `!!!`, base64 `[1]`, base64 `{"python":"rel/py"}`, base64 `{"typeCheckingMode":"x"}`, base64 `{"settings":3}` | each exits 1 with a one-line reason                                                               |
| baked `python` = an existing executable                                                                                     | it wins over `.venv`                                                                              |
| baked `python` = `/nope/python`                                                                                             | exit 1, message names the path                                                                    |
| baked `typeCheckingMode` `strict`, baked settings `{"basedpyright":{"analysis":{"extraPaths":["src"]}}}`                    | both present; `diagnosticMode` still `openFilesOnly`                                              |
| `a.ts`                                                                                                                      | exit 3                                                                                            |
| `--root <repo>` on `py/server/pkg/a.py` (nested `pyproject.toml`s)                                                          | root = repo                                                                                       |
| `--options` base64 `{"python": "<.venv python>", "typeCheckingMode": "strict"}` with baked `python` set elsewhere           | the per-project values win                                                                        |
| `--options` base64 `{"python": "/nope/python"}`                                                                             | exit 1, message names the path                                                                    |
| `options` subcommand                                                                                                        | keys `python` (path), `typeCheckingMode` (enum), `settings` (json); defaults are the baked values |

Docker scenarios (image `mcr.microsoft.com/devcontainers/base:ubuntu`; it has `python3`):

- **`test.sh`** (default `{}`): `describe` on a generated project, then `serve` answers a piped
  `initialize` with `serverInfo.name` `basedpyright` within 30 s.
- **`with_python`**: option `{"python": "/usr/bin/python3", "typeCheckingMode": "strict"}`.
  `describe` shows both.
- **`no_python_in_image`** (image `debian:bookworm-slim`, which has no `python3` and no
  `curl`): the build succeeds through the `apt-get` fallback for `curl`, `describe` has no
  `python` key in `settings`, and `serve` still initializes.

Build-time refusals are tested offline in `test/install_options_test.sh` (`devcontainer
features test` has no expected-failure mode), following
`features/xvfb/test/install_options_test.sh` and `features/agents/test/install_options_test.sh`:
the real `install.sh` with `SHARE_DIR` and `BIN_DIR` in a `mktemp -d`, and `curl`, `apt-get`,
`tar`, `uname` and `npm` stubbed on `PATH`. The `tar` stub creates `<dest>/bin/node` and
`<dest>/bin/npm` as wrappers that exec the real `node` and the `npm` stub. Rows:

- `PYTHON=relative/python` and `PYTHON='/a b/python'` → `python must be an absolute path`
- `SETTINGS='[1]'` → `settings must be a JSON object`, nothing under `BIN_DIR`
- `PYTHON=/opt/py/bin/python`, `TYPECHECKINGMODE=strict`, `SETTINGS` with quotes → all three
  `BAKED_` lines rewritten, and `describe` on a fixture reflects them
- a 2,000-character `SETTINGS` → the baked line is still one line
- `uname -m` → `riscv64` gives `unsupported architecture: riscv64`
- a Node tarball with different bytes → `node checksum mismatch`
- the `npm` stub is called with `ci` and `--omit=dev`, never `install`

## Validation

- [ ] `bash features/python-lsp/test/launcher_test.sh` passes every fixture row
- [ ] `bash tests/features_test.sh --feature python-lsp` passes
- [ ] `bash features/python-lsp/test/install_options_test.sh` passes every row
- [ ] **(Docker host)** `bash features/python-lsp/test/run-features-test.sh` passes every
      scenario
- [ ] **(human)** Manual (core complete): in deephaven-core,
      `cp -r <devc-tools>/features/python-lsp .devcontainer/` and add
      `"./python-lsp": {"python": "/usr/local/share/deephaven-core/venv/bin/python"}` to
      `.devcontainer/devcontainer.json`'s `features`; `devc build`, `devc web`. (Afterwards:
      `git checkout .devcontainer && rm -rf .devcontainer/python-lsp`, `devc build`.) Open
      `py/server/deephaven/pandas.py`:
  - [ ] the status names `basedpyright 1.40.2 (Python 3.12)` and clears within 10 s
  - [ ] hover on `new_table` shows its signature
  - [ ] F12 opens `py/server/deephaven/table_factory.py`, the **source**, not `site-packages`
  - [ ] `pd.` on a new line offers `DataFrame`
  - [ ] `devc_probe: int = "x"` underlines within 2 s
- [ ] **(human)** Manual: from a terminal, change `new_table`'s return annotation in
      `py/server/deephaven/table_factory.py` to `int`. `pandas.py` line 296
      (`return new_table(cols=input_cols)` in `to_table`, declared `-> Table`) shows a type
      error within 5 s. Revert.
- [ ] **(human)** Manual: open `py/client/pydeephaven/session.py` too. In the container,
      `for p in $(pgrep -f langserver.index.js); do readlink /proc/$p/cwd; done` prints two
      lines, ending `py/server` and `py/client`.
- [ ] **(human)** Manual: without the `python` option, a repo with `.venv` gets that interpreter (status
      text), and imports from packages installed only there resolve.
- [ ] **(human)** Manual (per project, no Feature option): in deephaven-core, **Language server
      settings…** on `py/server/deephaven/pandas.py` sets **Python** to the deephaven venv.
      `py/server` restarts with `basedpyright 1.40.2 (Python 3.12)` and its imports resolve.
      `py/client`, with no entry, keeps its own detected interpreter.
      `~/.config/devc/repos/deephaven-core-<hash>/language-servers.json` holds exactly one
      `python` entry, root `py/server`.
- [ ] `git status` in every repo used shows nothing the server wrote
- [ ] `deno fmt --check` passes for every touched `.md` / `.json`

## Relevant Files

- `features/python-lsp/devcontainer-feature.json` — new
- `features/python-lsp/install.sh` — new
- `features/python-lsp/devc-lsp-python` — new
- `features/python-lsp/README.md` — new
- `features/python-lsp/basedpyright/package.json` — new
- `features/python-lsp/basedpyright/package-lock.json` — new, generated
- `features/python-lsp/test/launcher_test.sh` — new
- `features/python-lsp/test/install_options_test.sh` — new
- `features/python-lsp/test/test.sh` — new
- `features/python-lsp/test/scenarios.json` — new
- `features/python-lsp/test/with_python.sh` — new
- `features/python-lsp/test/no_python_in_image.sh` — new
- `features/python-lsp/test/run-features-test.sh` — copied from `features/xvfb/test/`
- `features/README.md` — row
- `features/CONTRIBUTING.md` — test inventory and `### python-lsp` note (private Node; the
  nearest-marker rule; never put basedpyright's `.bin` on `PATH`)
- `features/PUBLISH_ALLOWLIST.txt` — `python-lsp`, last
- `devc/README.md` — the **Language servers** bullet names `python-lsp`
- `.plans/PLAN.md` — status
