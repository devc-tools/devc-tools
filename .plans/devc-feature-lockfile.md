# devc-feature-lockfile

devc keeps its rule of never writing a Feature lockfile on its own. It gains two
things:

1. `devc lock [PATH]` writes the lockfile for a project's own
   `devcontainer.json`, on demand.
2. Every start in project mode **honors** an existing project lockfile by
   pinning the Feature references in the merged config to the digests the lock
   records.

## Background: why devc does the pinning itself

`buildUpArgs` passes `--no-lockfile` on every run (`devc-core/container.ts`),
for the reasons in the comment above it (commit `579f6e7`). Under that flag the
CLI neither reads nor writes a lock, so today a project's tracked
`devcontainer-lock.json` is honored by VS Code and ignored by devc.

`@devcontainers/cli` 0.88.0 has three lockfile modes, and none of them is
"read, never write":

| CLI mode            | Reads lock | Writes lock                                               | Why devc can't use it                                                                                                                                                                                                                      |
| ------------------- | ---------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--no-lockfile`     | no         | no                                                        | (today) nothing is honored                                                                                                                                                                                                                 |
| default             | yes        | always: creates if missing, rewrites if it differs        | In project mode `--override-config` records the project's config path, so the CLI writes into the project's `.devcontainer/`. It locks the **merged** config, so devc's injected Features (`devc-config`, …) land in the project's lock. |
| `--frozen-lockfile` | yes        | no; fails `Lockfile does not exist` / `does not match`    | The merged config's Features never match a lock that lists only the project's, so every project-mode start fails                                                                                                                          |

So devc keeps `--no-lockfile` and applies the lock's pins itself. This is the
same substitution the CLI makes internally: it fetches an OCI Feature by its
lock entry's `resolved` digest. devc does it by rewriting the Feature key in the
merged config to that `resolved` value (`registry/path@sha256:<hex>`), which the
CLI accepts as a Feature reference.

## Decisions

1. **`--no-lockfile` stays unconditional.** `buildUpArgs` doesn't change. The
   removal of a stale lock in devc's own cache directory (`LOCKFILE_NAME` in
   `merged_config.ts`) doesn't change. devc never writes a lockfile except from
   `devc lock`.

2. **Lockfile path**: the same rule the CLI uses (`SQ` in 0.88.0). Given the
   project's own config path `C`:
   - the directory is `dirname(C)`
   - the name is `.devcontainer-lock.json` when `basename(C)` starts with `.`,
     otherwise `devcontainer-lock.json`

   So `.devcontainer/devcontainer.json` uses `.devcontainer/devcontainer-lock.json`,
   and a root `.devcontainer.json` uses `.devcontainer-lock.json`. `C` is what
   `findOwnDevcontainerConfig` returns. Zero-config projects have no lockfile:
   devc never looks for one, and `devc lock` refuses (decision 6).

3. **Reading the lock** (project mode only, in `ensureMergedConfig`):

   | File state                                                        | Result                                                                                                                                      |
   | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
   | absent                                                            | no pinning; `MergedConfig.lockfile` is `null`                                                                                              |
   | empty or whitespace only                                          | no pinning; `lockfile` is `null`. The CLI treats this as "initialize" and `upgrade` truncates before writing, so it is not an error.     |
   | not JSON, not an object, or `features` missing or not an object | **fail the merge**: `<relpath>: not a valid devcontainer lockfile — <detail>; regenerate it with \`devc lock\``                            |
   | valid                                                             | pin per decision 4                                                                                                                          |

   `<relpath>` is the lock path relative to the project folder, e.g.
   `.devcontainer/devcontainer-lock.json`. `<detail>` is the JSON parse error
   message, `top level is not an object`, or `"features" is not an object`.
   Read with `node:fs/promises` (core stays runtime-neutral; `npm run
   portability-check` must stay clean).

4. **Pinning rule.** This is applied to the **final** merged config: after
   `mergeConfigs([devcContributions(...), gitProtectLayer(...), provisional])`
   and `stripDevcOnlyKeys`, before writing. For each key `K` of
   `config.features`, in order:
   - `lock.features[K]` absent → leave `K` alone. It floats, exactly as under
     the CLI's non-frozen mode. This covers devc's injected Features and
     anything an overlay added.
   - `lock.features[K].resolved` is a string matching
     `/^[^\s@]+@sha256:[0-9a-f]{64}$/` → replace key `K` with that string,
     keeping its value (options object) unchanged and its **position** in the
     object. Rebuild `features` in order; don't delete and re-add.
   - otherwise (tarball URI, missing or malformed `resolved`) → leave `K` alone
     and emit `logWarning(\`<relpath>: <K> not pinned — lock entry is not an OCI digest\`)`.

   Lock entries for keys not in the config are ignored silently. Keys are
   matched **verbatim**, with no normalization: the CLI writes the reference
   exactly as the config spells it. The lock's `version`, `integrity` and
   `dependsOn` fields are not read.

5. **`MergedConfig.lockfile`**: a new field.
   `{ path: string; pinned: string[] } | null`. `path` is absolute. `pinned`
   lists the original keys that were replaced, in config order. It is `null` in
   zero-config mode, when the file is absent, and when it is empty. A valid lock
   that pins nothing gives `{ path, pinned: [] }`.

6. **`devc lock [PATH] [--dry-run]`**:
   - Dispatched in `devc/main.ts` **before** the first-run global-config hook,
     like `init`. It needs no folder roots and must never trigger that wizard.
   - Target: `resolveLocalFolder(arg)`. No own config
     (`findOwnDevcontainerConfig` is `null`) → stderr
     `devc: no devcontainer.json in <target> — devc lock only locks a project's own config`,
     exit 1.
   - Runs the embedded CLI through `selfExecDevcontainerRunner`, with exactly
     `['upgrade', '--workspace-folder', <target>, '--config', <C>]`, plus
     `'--dry-run'` when given. stderr is inherited (the CLI's progress log).
   - `upgrade` resolves against the project's **own** config. It doesn't use
     devc's merged config and doesn't apply overlays, so the lock lists exactly
     the project's Features. It re-resolves every Feature to the newest version
     its tag allows (internally it runs with `noLockfile: true`), so it
     regenerates the lock rather than "adding missing entries". It needs
     registry access but no Docker daemon.
   - Exit code 0 with `--dry-run` → write the runner's captured stdout to
     stdout verbatim. Without it → print `Wrote <absolute lock path>`. Exit 0.
   - Non-zero exit code `n` → stderr `devc: devcontainer upgrade failed (exit <n>)`,
     exit 1.
   - The core half lives in `devc-core` and takes a `DevcontainerRunner`, so it
     is testable with a fake runner and usable by other consumers. The `devc`
     binary binds `selfExecDevcontainerRunner`, the same way
     `devc/container.ts` does for `startContainer`.
   - Arg parsing: `parseLockArgs` in `devc/args.ts`. `--dry-run` is a boolean,
     and the target is the first arg not starting with `--`. Like
     `parseUpArgs`, it does not reject unknown flags.

7. **Help** (`devc/help.ts`, and verbatim in `.plans/design/devc-design.md`):
   - `COMMANDS` entry placed directly after `build`:
     `{ name: 'lock', summary: "Write the Feature lockfile for the project's own devcontainer.json" }`.
     Update the "The fifteen subcommands" doc comment to sixteen.
   - `COMMAND_HELP.lock`:

     ```text
     Usage: devc lock [PATH] [OPTIONS]

     Arguments:
       [PATH]  Path to the project (default: current directory)

     Options:
           --dry-run   Print the lockfile instead of writing it
       -h, --help      Print help
     ```

8. **`devc status`** prints one more line directly after the
   `running`/`stopped`/`missing` line, before git protection:
   - project mode, `lockfile` non-null → `lockfile: <relpath> — <n> Feature(s) pinned`
   - project mode, `lockfile` null → `lockfile: none`
   - zero-config → `lockfile: none (zero-config)`
   - merge failed → no lockfile line (git protection already prints `unknown — …`)

   Per-Feature "not pinned" warnings come from the core logger during the
   merge, so `status` doesn't repeat them.

9. **`declaresFeatureNamed` strips a digest.** In `devc-core/default_config.ts`,
   remove a trailing `@sha256:<hex>` (generally, an `@` suffix on the last path
   segment) before the existing tag strip. Decision 4 already runs after every
   name-based check (`devcContributions`, `declaresBridge`,
   `bridgeClientDecision` all read `provisional`). This fix covers a user who
   writes a digest reference by hand, where today
   `…/devc-bridge@sha256:abc` comes out as `devc-bridge@sha256` and silently
   loses the bridge mounts and the baseline dedupe.

10. **No version bumps** to Features. The devc / `@devc-tools/core` versions
    move at release time, as usual.

## Gotchas

- **Order matters.** Pin **after** `devcContributions` and the second merge.
  Pinning `provisional` instead would rename keys before the name-based checks
  run. Decision 9 makes that survivable, but the order is the primary guard.
- **Lock path follows the config's basename** (decision 2). Hard-coding
  `.devcontainer/devcontainer-lock.json` breaks root `.devcontainer.json`
  projects.
- **`upgrade` truncates the lock to empty before writing.** A failure between
  the two leaves an empty file. Decision 3 treats that as "no lock", which is
  what the CLI does too, so the next run still works. Rerun `devc lock`.
- **Transitive Features float.** A Feature pulled in only through another's
  `dependsOn` is in the lock, but it is not a key in `features`, so decision 4
  can't pin it. Document this; don't try to handle it.
- **VS Code still writes the lock** on its own builds (CLI default mode). A
  project used from both tools gets its lock updated by VS Code whenever its
  Features change. That's VS Code's behavior, and devc just reads whatever is
  there.
- **`selfExecDevcontainerRunner` pipes stdout.** `--dry-run` output only
  reaches the user if devc prints the captured `stdout` itself.
- The existing test `a lockfile in the project is left alone` must keep
  passing. devc reads the project lock now, but still never writes it.

## Checklist

- [ ] `devc-core/lockfile.ts` (new): lock path rule (decision 2), read and validate (decision 3), pin a merged config (decision 4), and the `upgrade` wrapper taking a `DevcontainerRunner` (decision 6 core half). Export it from `devc-core/mod.ts` and add it to `devc-core/deno.json`'s `check` task
- [ ] `devc-core/merged_config.ts`: apply pinning in project mode at the point decision 4 names; the `MergedConfig.lockfile` field (decision 5); update the `LOCKFILE_NAME` doc comment (devc now reads a project's lock, still never writes one)
- [ ] `devc-core/container.ts`: update the `buildUpArgs` doc comment's `--no-lockfile` paragraph to say a project's lock is honored by devc's own pinning (`lockfile.ts`), not by the CLI
- [ ] `devc-core/default_config.ts`: `declaresFeatureNamed` digest strip (decision 9)
- [ ] `devc/args.ts`: `parseLockArgs`
- [ ] `devc/main.ts`: `lock` dispatch before the first-run hook (decision 6); the `devc status` lockfile line (decision 8)
- [ ] `devc/help.ts`: `COMMANDS` entry and `COMMAND_HELP.lock` (decision 7)
- [ ] Tests: `devc-core/tests/lockfile_test.ts` (new), `devc-core/tests/merged_config_test.ts`, `devc-core/tests/default_config_test.ts`, `devc/tests/args_test.ts`, `devc/tests/help_test.ts`
- [ ] Docs: `.plans/design/devc-design.md` (Delivery paragraph near "`.devcontainer-lock.json` is still found beside it" is now wrong, so rewrite it; new `## \`lock\`` section after `## \`build\``; top-level help list), `devc/README.md` (Commands block line `devc lock    [PATH] [--dry-run]` with summary `Write the project's Feature lockfile on demand`; new section "Feature lockfile" covering decisions 1–4 and the Gotchas a user can hit: transitive deps float, VS Code also writes it, empty file = no lock)
- [ ] `docs/maintainers/manual-verification.md`: new numbered section with the host checks from Validation

## Validation

- [ ] `cd devc-core && deno task check && deno task test` passes, including new tests proving:
  - lock path: `<p>/.devcontainer/devcontainer.json` → `<p>/.devcontainer/devcontainer-lock.json`; `<p>/.devcontainer.json` → `<p>/.devcontainer-lock.json`
  - project config `{"image":"x","features":{"ghcr.io/a/b/foo:1":{"opt":true},"ghcr.io/a/b/bar:2":{}}}` with a lock pinning only `ghcr.io/a/b/foo:1` to `ghcr.io/a/b/foo@sha256:` + 64 hex → merged `features` has `ghcr.io/a/b/foo@sha256:…` with value `{"opt":true}` in **first** position, `ghcr.io/a/b/bar:2` unchanged, no `ghcr.io/a/b/foo:1`; `lockfile` is `{ path: <abs>, pinned: ["ghcr.io/a/b/foo:1"] }`
  - devc's injected `devc-config` Feature is present and unpinned when the lock doesn't name it
  - a lock entry whose `resolved` is `https://example.com/devcontainer-feature-x.tgz` → key unchanged, and a captured logger (`setLogger`) receives exactly `.devcontainer/devcontainer-lock.json: <K> not pinned — lock entry is not an OCI digest`
  - empty lock file and absent lock file → `lockfile` is `null`, features unchanged
  - lock `not json` → `ensureMergedConfig` rejects with a message starting `.devcontainer/devcontainer-lock.json: not a valid devcontainer lockfile — `; `{"features":[]}` → `… — "features" is not an object; regenerate it with \`devc lock\``
  - root `.devcontainer.json` project reads `.devcontainer-lock.json`
  - project declaring `ghcr.io/devc-tools/features/devc-bridge:0`, pinned by the lock → `bridgeKey` non-null and the bridge token mount still present
  - project lock bytes are unchanged after a merge that pinned something
  - zero-config: `lockfile` is `null`; the cache-dir lock is still removed (existing test)
  - `buildUpArgs` still includes `--no-lockfile` in both modes (existing `up_args_test.ts`, unchanged)
  - `declaresFeatureNamed({'ghcr.io/x/devc-bridge@sha256:' + 64 hex: {}}, 'devc-bridge')` is `true`; the existing tag and path cases still pass
  - `upgrade` wrapper with a fake runner: args are exactly `['upgrade','--workspace-folder',<p>,'--config',<C>]`, with `'--dry-run'` appended when asked; a fake exit code 3 rejects with `devcontainer upgrade failed (exit 3)`; a zero-config folder rejects with `no devcontainer.json in <p> — devc lock only locks a project's own config` without calling the runner
- [ ] `cd devc-core && npm run portability-check` is clean
- [ ] `cd devc && deno task check && deno task test` passes, with `args_test.ts` covering `parseLockArgs` (`[]`, `['--dry-run']`, `['some/path','--dry-run']`) and `help_test.ts` asserting `lock` follows `build` in `COMMANDS` and `COMMAND_HELP.lock` matches decision 7 exactly
- [ ] `deno fmt --check` is clean at the repo root
- [ ] (user) In a scratch project with `.devcontainer/devcontainer.json` declaring `ghcr.io/devc-tools/features/git-container-config:0`: `devc lock --dry-run` prints a lock JSON with that key and writes no file; `devc lock` prints `Wrote <abs>/.devcontainer/devcontainer-lock.json`
- [ ] (user) Set that lock entry's `resolved` to the 0.1.1 digest (`ghcr.io/devc-tools/features/git-container-config@sha256:f12bfd010e0e2b97af07236fd0b0c8f78ba6ae6c67e81305c951814fd15b1ee2`, from deephaven-core's lock). `devc up --print-config | jq '.features | keys'` shows that `@sha256:` key. After `devc build`, inside the container `grep -c 'bind-mounted on its own' /usr/local/share/devc-features/git-container-config/post-create.sh` prints `0` (0.1.2 prints `1`). Restore with `devc lock`, `devc build`, and the same grep prints `1`
- [ ] (user) `devc status` prints `lockfile: .devcontainer/devcontainer-lock.json — 1 Feature(s) pinned`; in a zero-config folder, `lockfile: none (zero-config)`
- [ ] (user) `devc lock` in a zero-config folder exits 1 with the decision-6 message
- [ ] (user) After any `devc up`/`devc build`, `git status` in the project shows the lock unchanged

## Relevant Files

- `devc-core/lockfile.ts` (new)
- `devc-core/merged_config.ts`
- `devc-core/container.ts` (doc comment only)
- `devc-core/default_config.ts`
- `devc-core/mod.ts`
- `devc-core/deno.json`
- `devc-core/tests/lockfile_test.ts` (new)
- `devc-core/tests/merged_config_test.ts`
- `devc-core/tests/default_config_test.ts`
- `devc/args.ts`
- `devc/main.ts`
- `devc/help.ts`
- `devc/tests/args_test.ts`
- `devc/tests/help_test.ts`
- `devc/README.md`
- `.plans/design/devc-design.md`
- `docs/maintainers/manual-verification.md`
- `.plans/PLAN.md`
