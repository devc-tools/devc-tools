# Contributing to devc-tools

Pull requests are welcome. For anything bigger than a small fix, open an issue
first so we can agree on the approach before you write it.

## Set up

Develop inside this repo's own dev container. Its config is in
[`.devc/`](.devc/):

```sh
devc claude .    # or: devc attach .
```

To run the tools from source, source
[`scripts/bash_aliases.sh`](scripts/bash_aliases.sh) from `~/.bashrc`. It
defines `devc2` and `devc-bridge2`, which run straight from the source tree
alongside any installed `devc` / `devc-bridge`.

## Where things live

| Path                 | What it is                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `devc/`              | The dev container CLI and config TUI. See [Development](devc/README.md#development)         |
| `devc-core/`         | `devc`'s lifecycle logic, also published as `@devc-tools/core`                              |
| `devc-bridge/`       | The host command bridge: `host/` (macOS daemon) and `client/` (container client)            |
| `features/`          | Published devcontainer Features. See [features/CONTRIBUTING.md](features/CONTRIBUTING.md)   |
| `install.sh`         | The `curl \| sh` installer                                                                  |
| `tests/`             | Repo-level shell harnesses (installer, workflow guards, Features)                           |
| `.github/workflows/` | Release and publish workflows                                                               |
| `scripts/`           | Source-run aliases, plus version-bump and preflight scripts                                 |
| `docs/`              | User guides. [`docs/maintainers/`](docs/maintainers/) holds the release and publish process |
| `.plans/`            | Plan docs. `.plans/PLAN.md` is the status index                                             |

## Before you open a PR

Run the checks for what you changed. There is no PR CI yet, so these are the
gate:

```sh
deno fmt --check                                            # repo root, always
(cd devc && deno task check && deno task test)              # devc
(cd devc-core && deno task check && deno task test)         # devc-core
(cd devc-bridge/host && deno task check && deno task test)  # bridge host
(cd devc-bridge/client && deno task check)                  # bridge client
bash tests/install_test.sh install.sh                       # installer
bash tests/workflow_guards_test.sh                          # workflows
bash tests/features_test.sh                                 # Features
```

Each Feature also has its own harnesses. See
[Running a Feature's tests](features/CONTRIBUTING.md#running-a-features-tests).

In the PR description, say what you changed and how you tested it. If the
change needs Docker, a Mac or GitHub Actions to verify, say which checks you
couldn't run.

## Versions and releases

**Leave versions as they are in your PR.** That includes the binary `VERSION`
consts, `devc/deno.json`, `devc-core/package.json` and every Feature's
`devcontainer-feature.json`. The maintainer bumps versions and cuts releases
separately, and a Feature publishes as soon as its version changes on `main`.

If your change should reach users in a particular release, or changes behavior
every consumer of a Feature gets, say so in the PR description.

The release and publish process is documented in
[docs/maintainers/](docs/maintainers/) for the maintainer:
[releasing](docs/maintainers/releasing.md),
[publishing Features](docs/maintainers/publishing-features.md) and
[manual verification](docs/maintainers/manual-verification.md).
