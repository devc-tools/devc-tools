# devc-bridge-client-auto-mount

devc automatically bind-mounts the host's installed container client
(`~/.config/devc-bridge/client/`) **read-only** over the Feature's client
directory in every bridge-enabled container it starts. The installer keeps
putting the client there, so a typical devc user runs a client that always
matches their host bridge, and developing the client becomes "replace the
binary": `deno task build:client`, and every devc container sees it live, with
no image rebuild or release.

Non-devc consumers are unchanged: the Feature still downloads its pinned client
at image build time, and that stays the fallback for everyone devc does not
start.

## Background — why this is now safe

[devc-bridge-client-download](archived/devc-bridge-client-download.md) moved the
client off a host mount because `readonly` could only be expressed by an
off-schema Feature string mount. That constraint is gone for devc: the
`devc.json` overlay and devc's own contributions are now merged into one full
`devcontainer.json` (`devc-core/merge.ts`), where `readonly` is specified, and
devc already contributes the read-only token mount this way
(`bridgeMount`, `devc-core/overlay.ts`). The client mount rides the same layer.

What still has to be handled, and how this plan handles it:

| Hazard                                                                       | Handling                                                                     |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A missing bind-mount source fails `docker run`                               | Mount only when the client **file** exists at merge time                     |
| A placeholder / non-binary file would replace a working client               | Mount only when the file starts with the ELF magic                           |
| Host-arch client in a different-arch container (`--platform`)                | Mount only when the ELF `e_machine` matches the host arch; opt-out key       |
| Compose drops `readonly` (`dockerCompose.ts:738`) → a writable shared binary | Never mount in a Compose project                                             |
| User wants the Feature's client anyway                                       | devc-only key `"bridgeClientMount": false`, or their own mount on the target |

## Decisions

1. **Mount string** — exactly, appended to devc's layer `mounts` after the token mount:

   ```
   type=bind,source=${localEnv:HOME}/.config/devc-bridge/client,target=/usr/local/share/devc-bridge/client,readonly
   ```

   `${localEnv:HOME}` is written verbatim (the CLI resolves it), like
   `bridgeMount`. **Mount the directory, never the file**: `build:client` and
   `install.sh` replace the binary by rename, which gives it a new inode. A
   file bind mount would keep showing the old inode. A directory mount shows the
   new file, and the Feature's `/usr/local/bin/devc-bridge` symlink follows it.

2. **Fixed source path. `DEVC_BRIDGE_CLIENT_DIR` is not honored.** It is always
   `$HOME/.config/devc-bridge/client/devc-bridge`, the same path `devc-bridge status`
   inspects (`devc-bridge/host/config.ts` `clientBin`, which doesn't read that
   variable either). A client installed elsewhere is simply not mounted.

3. **When the mount is contributed** — all must hold, checked in this order; the
   first that fails is the reported reason (exact strings, used by `devc status`):

   | # | Condition                                                                   | Reason when it fails                                         |
   | - | --------------------------------------------------------------------------- | ------------------------------------------------------------ |
   | 1 | Merged Features declare devc-bridge (`declaresBridge`)                      | _(no client line at all — bridge not enabled)_               |
   | 2 | Resolved `bridgeClientMount` is not `false`                                 | `bridgeClientMount is false`                                 |
   | 3 | Provisional config has no `dockerComposeFile`                               | `Docker Compose project — readonly would be dropped`         |
   | 4 | `$HOME/.config/devc-bridge/client/devc-bridge` exists and is a regular file | `no host client at ~/.config/devc-bridge/client/devc-bridge` |
   | 5 | Its first 4 bytes are `7F 45 4C 46` (ELF magic)                             | `host client is not a Linux binary`                          |
   | 6 | Its `e_machine` matches the host arch (below)                               | `host client is <elf-arch>, host is <host-arch>`             |

   `e_machine` is the little-endian `uint16` at byte offset 18. Mapping:
   `62` (`0x3E`) → `x86_64`, `183` (`0xB7`) → `aarch64`, anything else →
   `unknown(<n>)`. Host arch: `process.arch` `'x64'` → `x86_64`, `'arm64'` →
   `aarch64`, anything else → the raw `process.arch` value (never matches). Read
   only the first 20 bytes. A read error counts as condition 4 failing.

   The check is at merge time, on the host, with `node:fs/promises` (devc-core is
   runtime-neutral; follow the file I/O already in `merged_config.ts`).

4. **Opt-out key `bridgeClientMount`**: a devc-only boolean, default `true`.
   Add it to `DEVC_ONLY_KEYS` so `stripDevcOnlyKeys` removes it before the CLI
   sees the config. Merge semantics: normal (highest layer wins, like
   `gitProtect`), **not** a veto like `baselineFeatures`. Validate it on each
   overlay file: any non-boolean fails the merge with
   `bridgeClientMount in <path> must be true or false`. Pure opt-out only,
   meaning `true` does not bypass conditions 3–6.

5. **Override by target** needs no code. A user mount whose target is
   `/usr/local/share/devc-bridge/client` wins through the existing
   `mounts` target dedupe, because devc's layer is lowest.

6. **`MergedConfig` carries the decision** so `devc status` can report it
   without re-deriving: a new field whose value is either "mounted" or the reason
   string from decision 3 (`null` when the bridge isn't enabled). Tests need a
   home directory other than the real one, so add a test-only `home` option to
   `MergedConfigOptions` that defaults to the existing `homeDir()`.

7. **`devc status`**: when the bridge is enabled, `bridgeStatusLines` prints one
   more line directly after the `token:` line:

   ```
   client:    host copy, mounted read-only (~/.config/devc-bridge/client)
   client:    Feature's copy — <reason>
   ```

   When the decision is "mounted" and a container exists whose live mount table
   (`getContainerMounts`) has no entry targeting
   `/usr/local/share/devc-bridge/client`, append
   `— not in this container yet; run \`devc build\``. Mounts are fixed at create
   time, so an existing container keeps the Feature's client until it is
   recreated. No container means no suffix.

8. **Host `devc-bridge status` wording** (`clientStatus`, `devc-bridge/host/main.ts`).
   The detection logic stays the same; only the three strings change:

   | Case        | New string                                                                            |
   | ----------- | ------------------------------------------------------------------------------------- |
   | missing     | `client: none on host (containers use the Feature's client)`                          |
   | placeholder | `client: none (leftover placeholder — safe to delete)`                                |
   | present     | `client: host copy present (devc mounts it read-only into bridge-enabled containers)` |

   Rewrite the `status()` comment and the `clientStatus` / `Config.client` doc
   comments: this directory is now the normal source for devc containers, not a
   developer-only override.

9. **The installer does not change its behavior.** It keeps installing the client by
   default on macOS and Linux. Its header comment for `DEVC_BRIDGE_CLIENT_DIR`
   gets one added sentence: devc mounts only the default directory, so a
   client installed elsewhere is not mounted into containers.

10. **No Feature version bump.** `features/devc-bridge/` gets a README-only
    change and nothing about the image changes. An unbumped Feature does not
    publish (`features/CONTRIBUTING.md#versions`), which is what we want.

## Gotchas

- **Deleting the host client after a container was created with the mount**
  leaves `/usr/local/bin/devc-bridge` dangling in that container, because the
  mount shadows the downloaded copy. Recovery: reinstall, or `devc build` (the
  merge then skips the mount). Document it and don't try to handle it.
- The ELF check reads the **host** file, so it runs in the devc process, never in
  the container. Don't use `uname -m` here. That's the Feature's `install.sh`
  rule, which runs inside the image.
- `absolutizePaths` in zero-config mode must leave the `${localEnv:HOME}` source
  alone, the same way it already does for the token mount. Add a test for it.

## Checklist

- [ ] `devc-core/overlay.ts`: `bridgeClientMount` in `DEVC_ONLY_KEYS`, per-file validation, resolved-value reader; client mount string constant/function; `devcContributions` appends it when told the mount applies
- [ ] `devc-core/merged_config.ts`: condition checks 2–6 (decision 3), new `MergedConfig` field (decision 6), test-only `home` option
- [ ] `devc/bridge.ts`: `client:` status line and the live-mount suffix (decision 7)
- [ ] `devc-bridge/host/main.ts`: three new `clientStatus` strings plus comments (decision 8)
- [ ] `devc-bridge/host/config.ts`: `Config.client` doc comment and the `ensureDir(cfg.client)` comment
- [ ] Tests: `devc-core/tests/overlay_test.ts`, `devc-core/tests/merged_config_test.ts`, `devc/tests/bridge_test.ts`, `devc-bridge/host/tests/start_test.ts` (assert `client: none on host`)
- [ ] Docs: `devc/README.md` (new "The client mount" subsection after "The token mount"; `bridgeClientMount` in the overlay key list), `devc-bridge/README.md` (Setup step 1/2 comments and `status` example, "The container client" section, "Developing the client"), `features/devc-bridge/README.md` ("You can shadow the client" bullet: devc does this automatically), root `README.md` Install paragraph ("developer override only"), `install.sh` `DEVC_BRIDGE_CLIENT_DIR` header comment (decision 9)
- [ ] `docs/manual-verification.md`: add the host checks from Validation below as a section

## Validation

- [ ] `cd devc-core && deno task check && deno task test` passes, including new tests proving:
  - bridge Feature and a valid host-arch ELF at `<home>/.config/devc-bridge/client/devc-bridge` → merged `mounts` contains the exact string from decision 1 exactly once, alongside the token mount
  - each of conditions 2–6 failing on its own → no mount with target `/usr/local/share/devc-bridge/client`, and the `MergedConfig` field holds that row's exact reason
  - no bridge Feature → no client mount, field is `null`
  - a user mount on target `/usr/local/share/devc-bridge/client` wins (appears once, with the user's source)
  - `"bridgeClientMount": "no"` fails the merge with `bridgeClientMount in <path> must be true or false`
  - `bridgeClientMount` never appears in the written config
  - zero-config and project mode both get the mount, with the source still `${localEnv:HOME}/…`
- [ ] `cd devc && deno task check && deno task test` passes. The status test covers the mounted line, one reason line, and the `run \`devc build\`` suffix (fake mount table without the target)
- [ ] `cd devc-bridge/host && deno task check && deno task test` passes with `start_test.ts` asserting `client: none on host`
- [ ] `deno fmt --check` is clean at the repo root
- [ ] `grep -rn "client override" --exclude-dir=.git --exclude-dir=archived --exclude-dir=node_modules .` returns nothing outside `.plans/`
- [ ] (user, macOS host) After `curl … install.sh | sh`, `devc up --print-config` in a bridge-enabled project shows the decision-1 mount
- [ ] (user) `devc build`, then inside the container: `grep /usr/local/share/devc-bridge/client /proc/mounts` shows `ro`; `sudo touch /usr/local/share/devc-bridge/client/x` fails with `Read-only file system`; `devc-bridge --version` prints the host's release version
- [ ] (user) On the host, `cd devc-bridge/client && deno task build:client` after a visible change (e.g. temporarily edit `VERSION` in `client/version.ts`). Inside the **same** running container, `devc-bridge --version` shows it with no rebuild. Revert the edit afterwards
- [ ] (user) `devc status` prints `client:    host copy, mounted read-only (~/.config/devc-bridge/client)`; `devc-bridge status` prints `client: host copy present (…)`
- [ ] (user) `"bridgeClientMount": false` in `.devc/devc.jsonc`, `devc build`: no mount in `/proc/mounts`, `devc status` prints `client:    Feature's copy — bridgeClientMount is false`

## Relevant Files

- `devc-core/overlay.ts`
- `devc-core/merged_config.ts`
- `devc-core/tests/overlay_test.ts`
- `devc-core/tests/merged_config_test.ts`
- `devc/bridge.ts`
- `devc/tests/bridge_test.ts`
- `devc-bridge/host/main.ts`
- `devc-bridge/host/config.ts`
- `devc-bridge/host/tests/start_test.ts`
- `devc/README.md`
- `devc-bridge/README.md`
- `features/devc-bridge/README.md`
- `README.md`
- `install.sh` (the `DEVC_BRIDGE_CLIENT_DIR` header comment only)
- `docs/manual-verification.md`
- `.plans/PLAN.md`
