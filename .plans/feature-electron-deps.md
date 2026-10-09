# Electron runtime libraries as a Feature — placeholder

**Status: not ready.** A note of what was learned while testing `xvfb`, so the decision can be
made later without re-deriving it. Nothing here is settled, including whether to build it.

## Checklist

- [ ] Decide whether this is worth a Feature at all (see Open questions)
- [ ] Decide the name and the shape
- [ ] Turn this into a real plan (contracts, touchpoints, validation)

## The problem

VS Code extension tests need a display **and** Electron's own runtime libraries. `xvfb`
provides the first; the second is eleven packages a consumer pastes into `xvfb`'s
`extraPackages` from its README:

```
libgtk-3-0t64,libnss3,libasound2t64,libgbm1,libxss1,libxkbfile1,libsecret-1-0,libxshmfence1,libdrm2,libatk-bridge2.0-0t64,libcups2t64
```

That works, but it is a long string to carry in every project, and it lives in a README.

## What was measured (2026-10-08, Ubuntu 24.04, `xvfb` 0.1.0)

- **VS Code is the only one of the three `xvfb` consumers that needs anything extra.** Godot
  (GL Compatibility) and Aseprite both work on a bare `"xvfb": {}`; Godot's Forward+/Mobile
  renderers need only `"vulkan": true`. So a general "profiles"/"recipes" option on `xvfb`
  would have one entry with content and two that do nothing — considered and dropped.
- **The list above is sufficient.** With it installed, `vscode-test` (`@vscode/test-cli`,
  VS Code 1.141.0) in `devc-vscode` ran 197 tests green under `eval "$(xvfb-ensure)"`, and the
  window painted. Without a display the same run dies with
  `Missing X server or $DISPLAY` / `The platform failed to initialize`.
- **It is not known to be minimal.** On a bare `{}`, four of the eleven were already present as
  dependencies of `xvfb`'s own groups (`libgbm1 libxkbfile1 libxshmfence1 libdrm2`); seven were
  absent. Nobody has tried removing entries one at a time.
- **Harmless noise to expect, not to fix:** Electron logs `Failed to connect to the bus …
  /run/dbus/system_bus_socket` on every start (no D-Bus in the container). The tests pass
  regardless. Godot prints a similar `libdbus-1.so.3: cannot open shared object file`.
- **`vscode-test` downloads VS Code itself** (~344 MB, into the project's `.vscode-test/`), so a
  Feature has no reason to install the editor — only the libraries.
- **The `t64` fallback already exists** in `xvfb`'s `install.sh` (four of the eleven names carry
  the suffix). A separate Feature would have to copy that block — Features here are
  self-contained, there is no `features/common/`.

## The shape that looked best

A small Feature that installs only this list and declares `dependsOn` `xvfb`, so one line in a
consumer's `devcontainer.json` brings both. It keeps `xvfb`'s scope rule intact (groups are for
the display, not for applications) and puts the list in one maintained place; `xvfb`'s README
recipe would then shrink to a pointer.

The alternative is an `electron` boolean group inside `xvfb`: less to build, but it is exactly
the exception that scope rule exists to refuse, and the next application will ask for the same.

## Open questions

- **Is the README recipe enough?** One consumer (`devc-vscode`) needs this today. A Feature
  earns its keep at two or three.
- **Name.** `electron-deps` says what it is and covers any Electron app; `vscode-test` is what
  someone would search for. `vscode` alone would read as "installs the editor".
- **`dependsOn` needs a published ref**, so this cannot be built and tested as it would ship
  until `xvfb` is on ghcr.io. Unverified: how `dependsOn` behaves when the consumer also
  declares `xvfb` with its own options, and under devc's zero-config merged config.
- **Who owns drift?** The list is Electron's, and changes with Electron. A Feature that owns it
  needs a test that would notice — the offline harness can only check the list against itself;
  catching a new requirement takes a scenario that actually launches a current VS Code.
- **Testing a local Feature under devc** is awkward in a zero-config project: the key has to be
  a `../` path from devc's cache back into the project's `.devcontainer/`
  (`devc-dev/scripts/sync-local-feature.sh` does the copy and prints the key). Worth knowing
  before starting, and possibly worth fixing in devc first.
