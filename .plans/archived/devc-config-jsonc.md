# devc-config-jsonc

devc's global config can be `~/.config/devc/config.jsonc`, a JSON file with comments and
trailing commas, instead of `~/.config/devc/config.json`. When `config.jsonc` exists it is the
config, and `config.json` is ignored. The two are **never merged**. Saves to a `.jsonc` keep
its comments and formatting.

Read `devc-core/config.ts` (`GLOBAL_CONFIG_PATH`, `loadGlobalConfig`, `saveGlobalConfig`,
`globalConfigExists`, the `*FromConfig` accessors), `devc-core/jsonc_edit.ts` (`parseJsonc`,
`findArraySpan`, `splitElements`, `spliceBlock`, `ensureArray`, `normalizeArrayCommas`),
`devc/tui/config_flow.ts`'s load and save, `devc-desktop/src/main/launch.ts` (`desktopConfig`)
and `devc-desktop/src/main/main.ts` (`CONFIG_PATH`), and `watchConfigFile` in
`devc/web/server.ts` first.

## Decisions

- **Which file:** `config.jsonc` if it exists (any file type `stat` follows, including a
  symlink), else `config.json`. The choice is made on every load, so creating or deleting
  `config.jsonc` takes effect on the next command without a restart.
- **Both present:** `config.jsonc` is used. One notice goes to stderr per process, the first
  time a command loads the config:
  `devc: ~/.config/devc/config.json is ignored because ~/.config/devc/config.jsonc exists`.
  Nothing from `config.json` is read.
- **Neither present:** today's behavior (empty config). The first-run flow and the wizard create
  **`config.json`**, as today. A user opts into JSONC by renaming the file.
- **Parsing:** both names go through the same JSONC parse (`parseJsonc`). A `config.json` with
  comments therefore also loads. That's harmless, and it means one code path.
- **An invalid file:** today a missing **or invalid** file loads as empty, silently. Keep that
  for a missing file. For a file that exists but doesn't parse, or isn't a JSON object, keep
  loading it as empty, but print one stderr notice per process:
  `devc: <display path>: not valid JSONC (<parser message>), ignored`.
  - **gotcha:** otherwise a typo in a hand-edited `.jsonc` would silently drop every key,
    including `bridgeDefaultAllow`.
  - The commands that validate a key and exit 2 (`bridgeDefaultAllow`, `bridgeRepoAllow`,
    `webSource`) keep doing that for bad values.
- **Saving a `.jsonc`** never re-serializes the file. Only `saveGlobalConfig` writes the global
  config, and it changes only `codeRoots`, `skillsRoots` and `recentSkills`. All three are string
  arrays. For a `.jsonc`, each array whose value changed has its elements replaced in place
  (`findArraySpan` + a splice). A missing key is inserted with `ensureArray`, as the first
  top-level key. `extra` keys are **not** written, because the file already holds them
  byte for byte. Every byte outside a changed array's brackets is left exactly as it was.
  - The new elements are JSON-encoded strings, one per line, in the array's existing indent
    (`elementIndent`), or `` + the key's indent for a new array. An array that was on one line
    is rewritten in the multi-line form only if its contents change.
  - Saving `config.json` is unchanged (pretty JSON, today's key order).
- **Messages name the file actually read.** Every user-facing string that says
  `~/.config/devc/config.json` because it reports on a loaded value uses the loaded config's
  display path instead (`displayPath(cfg.path)`). Static help and docs say
  `~/.config/devc/config.jsonc (or config.json)`.
- **devc-desktop** reads the same file by the same rule: `config.jsonc` first, else
  `config.json`. It parses with a small comment-and-trailing-comma stripper of its own, because
  the app doesn't import devc-core. Copy the behavior of `devc-core/jsonc_edit.ts`'s
  `stripComments` / `parseJsonc`, with a header comment naming the original, and test the two
  against the same cases. The app never writes the file.
- **Watching:** any watcher of the global config, in devc web or devc-desktop, now or added by
  another plan meanwhile (`devc-web-open-in-jira` may add one for its `"jira"` key), must react
  to events on **both** names, since creating `config.jsonc` switches the file. Today
  `watchConfigFile` takes one path. Give it a way to match two basenames, and use it for any
  global-config watch.
- **Trust is unchanged:** `config.jsonc` sits in the same host-only folder, which no container
  mounts. The comment in `devc-core/config.ts` and `devc/bridge.ts`'s header that cite
  `config.json` as host-only must name both files.

## Contracts

- `devc-core/config.ts` exports the two paths (for example `GLOBAL_CONFIG_JSONC_PATH` and the
  existing `GLOBAL_CONFIG_PATH`), and a resolver returning which one is in use.
  `loadGlobalConfig()` with no argument uses the resolver. With an explicit `path`, it reads that
  path (tests). `GlobalConfig.path` is the file actually read, or the `config.json` path when
  neither exists, so a save creates `config.json`.
- `globalConfigExists()` is true when either file exists.
- The two notices, exactly:
  - `devc: ~/.config/devc/config.json is ignored because ~/.config/devc/config.jsonc exists`
  - `devc: <display path>: not valid JSONC (<message>), ignored`

  Paths are shown with `displayPath`. Each prints at most once per process.
- Error messages that already name the config file, such as
  `devc: ~/.config/devc/config.json: bridgeDefaultAllow: <reason>`, keep their shape with the
  path in use: `devc: ~/.config/devc/config.jsonc: bridgeDefaultAllow: <reason>`.

## Checklist

- [x] `devc-core/config.ts`: both paths, the resolver, the JSONC load, the two notices
      (once per process), `globalConfigExists`, the comment-preserving save for `.jsonc`, and
      header comments
- [x] `devc-core/jsonc_edit.ts`: only if a helper is missing for replacing one array's
      elements. Reuse the existing scanner; don't write a second one
- [x] `devc/args.ts`, `devc/main.ts`, `devc/web/pr_review.ts`, `devc/bridge.ts`, `devc/help.ts`,
      `devc/projects.ts`, `devc-core/mod.ts`: messages and comments that name the file, as in
      Decisions. Find them with
      `grep -rn 'config\.json' devc devc-core devc-desktop/src --include=*.ts` (ignore
      `devcontainer.json`, `deno.json`, `package.json` and `tsconfig.json`)
- [x] `devc/web/server.ts`: `watchConfigFile` can watch both global-config names. Apply it to
      any existing global-config watch
- [x] `devc-desktop/src/main/launch.ts`: the JSONC parse in `desktopConfig`. `main.ts`: the
      `config.jsonc`-first lookup for `CONFIG_PATH`, and error text naming the file read
- [x] Tests: `devc-core/tests/global_config_test.ts`, `devc/tests/args_test.ts` (a message
      naming `config.jsonc`), the devc-desktop launch tests (find the test file for
      `desktopConfig`), and a `devc/tests/web_server_test.ts` case if `watchConfigFile`'s
      matching is testable there
- [x] Docs: `devc/README.md` (a short **config.jsonc** note where the global config is
      introduced, and the examples in the bridge defaults sections may use `.jsonc` with a
      comment), `devc-desktop/README.md` (where it names `config.json`), `devc-bridge/README.md`
      and `docs/bridge-github.md` (where they name `config.json`),
      `.plans/design/devc-design.md` ("Global user configuration")

## Validation

- [x] `(cd devc && deno task check && deno task test)` passes
- [x] `(cd devc-core && deno task check && deno task test)` passes, apart from the known
      `cliWorktreeMounts` failure (the embedded devcontainer CLI exits 1 in this container)
- [x] `(cd devc-desktop && npm ci && npm run check && npm test)` passes
- [x] `deno fmt --check` on every touched file
- [x] `global_config_test.ts` (temp `CONFIG_DIR`, or the explicit-path and resolver APIs):
  - [x] **Which file:**
    - [x] only `config.json` → read;
    - [x] only `config.jsonc` with `//` and `/* */` comments and trailing commas → read;
    - [x] both → `config.jsonc` read, nothing from `config.json`, and the ignored notice printed
          once across two loads;
    - [x] neither → empty, and `path` is `config.json`.
  - [x] **An invalid file:** an invalid `config.jsonc` → empty config and the invalid notice,
        once.
  - [x] **Saving a `.jsonc`:**
    - [x] a file with comments above and inside `codeRoots`, a trailing comma, an unknown key
          with a comment, and a `bridgeRepoAllow` object: changing `recentSkills` alters only
          the bytes between that array's brackets (compare the rest byte for byte);
    - [x] the result parses and loads back to the new value;
    - [x] adding a missing `skillsRoots` inserts it and keeps every other byte;
    - [x] a save with nothing changed leaves the file byte-identical.
  - [x] **Saving `config.json`:** unchanged output, as the existing tests show.
  - [x] **`globalConfigExists`:** true for either file.
- [x] `args_test.ts`: with only a `config.jsonc` holding a bad `bridgeDefaultAllow`, the
      message is `devc: ~/.config/devc/config.jsonc: bridgeDefaultAllow: <reason>`.
- [x] devc-desktop tests:
  - [x] `desktopConfig` accepts comments and trailing commas;
  - [x] its parse agrees with devc-core's `parseJsonc` on a shared set of cases: comments
        inside strings stay, `//` in a URL string stays, and `/* */` across lines is removed;
  - [x] the lookup picks `config.jsonc` over `config.json`.
- [ ] By hand (any host):
  - [ ] Rename `config.json` to `config.jsonc` and add comments. `devc up` still applies
        `bridgeDefaultAllow`.
  - [ ] Run the config wizard and change a code root. The comments survive.
  - [ ] devc-desktop launches with `desktopWebArgs` from the `.jsonc`.

  2026-10-21: the three by-hand checks are not done (implemented in a container with no host
  Docker session, wizard TTY or Electron display); the automated tests cover each path.

## Notes

Decisions made during implementation, where the plan left a gap:

- **Trailing commas.** `parseJsonc` rejected them, though the plan has `config.jsonc` accept
  them through it. It now blanks each comma that only trivia separates from `]` or `}`
  (`stripTrailingCommas`, same scanner) before `JSON.parse`, for every caller. The two
  `jsonc_edit_test.ts` checks that relied on it to prove comma normalization now use strict
  `JSON.parse(stripComments(…))`.
- **API shape.** `resolveGlobalConfigPath(dir = CONFIG_DIR)` is the resolver (it prints the
  ignored notice); `globalConfigExists(path?, dir = CONFIG_DIR)` checks `path` when given, else
  both names in `dir`. `GLOBAL_CONFIG_PATHS` lists both, `config.jsonc` first, for watches.
- **Saving a `.jsonc`.** An array key that is absent and still empty is not a change (nothing
  inserted). A `.jsonc` that no longer parses is refused (`devc: <path>: not valid JSONC
  (<message>), not saved`), the file untouched, rather than overwritten; a saved key whose value
  is not an array is refused the same way rather than duplicated. A `.jsonc` path that does not
  exist yet is written as pretty JSON. A one-line array that changes gets the key's indent +
  two spaces. Comments inside a changed array's brackets go with its old elements.
- **Watching.** No global-config watch exists yet, and `devc-web-open-in-jira` had not landed:
  `watchConfigFile` takes one path or several of one directory (matching by
  `configEventMatches`), for a future watch to pass `GLOBAL_CONFIG_PATHS`.
- **`no_grant`.** Now `noGrantMessage(path)`, the path resolved per answer from the
  `PrReview` deps' `home`.
- **Shared parse cases.** devc-desktop cannot import `jsonc_edit.ts` (a parameter property is
  not erasable syntax), so both test suites run `devc-core/tests/fixtures/jsonc_parse_cases.json`.
- **devc-desktop's error text** keeps naming the full path, now of the file read.
- `deno fmt` drops trailing commas in the READMEs' `jsonc` examples.

## Relevant Files

| File                                              | Change                                                          |
| ------------------------------------------------- | --------------------------------------------------------------- |
| `devc-core/config.ts`                             | both paths, resolver, JSONC load, notices, comment-keeping save |
| `devc-core/jsonc_edit.ts`                         | only if an array-replace helper is missing                      |
| `devc-core/mod.ts`                                | comment naming the file                                         |
| `devc-core/tests/global_config_test.ts`           | file choice, notices, save tests                                |
| `devc-core/tests/jsonc_edit_test.ts`              | trailing commas, shared parse cases (see Notes)                 |
| `devc-core/tests/fixtures/jsonc_parse_cases.json` | cases shared with devc-desktop                                  |
| `devc/tests/web_pr_review_test.ts`                | `noGrantMessage`                                                |
| `devc/args.ts`                                    | messages name the file in use                                   |
| `devc/main.ts`                                    | `webSource` messages name the file in use                       |
| `devc/bridge.ts`                                  | header comment                                                  |
| `devc/projects.ts`                                | header comment                                                  |
| `devc/help.ts`                                    | `config.jsonc (or config.json)`                                 |
| `devc/web/pr_review.ts`                           | the `no_grant` message                                          |
| `devc/web/server.ts`                              | `watchConfigFile` for both names                                |
| `devc/tests/args_test.ts`                         | message test                                                    |
| `devc/tests/web_server_test.ts`                   | only if the watcher is testable there                           |
| `devc-desktop/src/main/launch.ts`                 | JSONC parse                                                     |
| `devc-desktop/src/main/main.ts`                   | `config.jsonc`-first lookup, error text                         |
| devc-desktop's `desktopConfig` test file          | JSONC and lookup tests                                          |
| `devc/README.md`                                  | `config.jsonc` note, examples                                   |
| `devc-desktop/README.md`                          | file name                                                       |
| `devc-bridge/README.md`                           | file name                                                       |
| `docs/bridge-github.md`                           | file name                                                       |
| `.plans/design/devc-design.md`                    | Global user configuration                                       |
| `.plans/PLAN.md`                                  | Pending entry and Development Phases row                        |
