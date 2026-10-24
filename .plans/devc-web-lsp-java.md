# devc-web-lsp-java

## Checklist

- [ ] `features/java-lsp/devcontainer-feature.json`, per [Manifest](#manifest)
- [ ] `features/java-lsp/install.sh`, per [install.sh](#installsh)
- [ ] `features/java-lsp/devc-jdtls.gradle`, the Gradle init script, per
      [Init script](#init-script)
- [ ] `features/java-lsp/devc-lsp-java`, the launcher, per [Launcher](#launcher)
- [ ] `features/java-lsp/README.md`, per [README](#readme)
- [ ] Offline harness `features/java-lsp/test/launcher_test.sh`, per [Tests](#tests)
- [ ] Docker scenarios: `test/test.sh`, `test/scenarios.json` plus one script per scenario,
      `test/run-features-test.sh` (copied unchanged from `features/xvfb/test/`)
- [ ] devc web: `lsp_build`, `lsp_reload` and `lsp_build_output` messages (`protocol.ts`,
      `server.ts`, `lsp_manager.ts`), with parser tests
- [ ] devc web: automatic reload when a generated-source folder appears or disappears
      (`lsp_watch.ts` hook, `lsp_manager.ts`), with tests
- [ ] devc web: **Build (Gradle)**, **Reload Gradle project** and **Show build output** in the
      file tile menu for Java sessions (`menus.js`, `lsp.js`)
- [ ] devc web: `jdt:` URIs open read-only text tiles (`lsp.js` `registerUriScheme('jdt', …)`,
      `tiles.js`)
- [ ] `features/README.md` row; `features/CONTRIBUTING.md` test inventory and `### java-lsp`
      note; `devc/README.md` Java paragraph
- [ ] Run all of [Validation](#validation), Docker scenarios included
- [ ] Add `java-lsp` to `features/PUBLISH_ALLOWLIST.txt`, **only after** the Docker scenarios
      pass
- [ ] `deno fmt` every touched file

**Depends on [devc-web-lsp-core](devc-web-lsp-core.md)** being complete. Do it after
[devc-web-lsp-typescript](devc-web-lsp-typescript.md) and
[devc-web-lsp-python](devc-web-lsp-python.md): those exercise the core with no
project-specific workarounds, which keeps core problems apart from Java ones.

A new Feature, `java-lsp`, gives devc web Java intelligence through **Eclipse JDT LS 1.63.0**
on a private **JDK 25**, configured so that it **writes nothing into the repo**: no `bin/`, no
`.project`, `.classpath` or `.settings`, and no `.gitignore` or git-exclude changes. Generated
sources (Immutables, protoc) come from Gradle, as in IntelliJ: importing never runs a build, and
**Build (Gradle)** on a Java tile runs one, then reloads the project. Background and
measurements are in
[design/devc-web-language-services.md](design/devc-web-language-services.md).

## Decisions (settled with the user, 2026-10-23)

- **IntelliJ-style build.** IntelliJ's Gradle sync runs no tasks; generated sources appear on
  the first Build Project, which runs Gradle. Here:
  - the import never runs Gradle tasks
  - **Build (Gradle)** runs the Feature's `buildCommand` and then reloads
  - a generated-source folder created or removed by **any** Gradle run, including a terminal or
    an agent, triggers the same reload automatically
- **Nothing may be written into the repo by the language server**, and no ignore file may be
  changed to hide output. That rules out JDT LS's defaults (`<project>/bin`, metadata at
  project roots).
- **Settings live in Feature options.**

## Concept boundaries

- **JDT LS never compiles (`java.autobuild.enabled: false`).** Its build is what creates
  `<project>/bin`. With it off, the probe wrote no class files. Diagnostics for open files still
  come from JDT's reconcile: a planted error was reported 2.6 s after the edit, and that is all
  devc web shows. Lost: diagnostics for files that are not open.
- **Metadata goes to JDT's workspace area through a JVM system property,
  `-Djava.import.generatesMetadataFilesAtProjectRoot=false`.** That property is read by the
  `org.eclipse.jdt.ls.filesystem` bundle. Sent as an LSP setting, as the exploration first did,
  it is ignored, and 197 `.project` files appear. With the `-D` flag, the probe wrote none.
- **The init script corrects Gradle's Eclipse model**, which every Buildship consumer gets
  wrong on deephaven-core:
  - it drops `compileOnly` / `compileOnlyApi` project dependencies (`:util-annotations`,
    `:util-immutables`)
  - it omits source folders that did not exist at import

  It writes nothing.
- **JDT annotation processing stays off.** Its `apt/init.gradle` fails under Gradle 9
  (eclipse.jdt.ls#3807, #3924). Gradle's own generated sources are used instead, so a changed
  `@Value.Immutable` interface shows stale generated types until the next Gradle build, as with
  IntelliJ's delegated builds.
- **One root per Gradle build**: the topmost `settings.gradle(.kts)` up to the git top-level.
  Each worktree is its own root and its own server (2–3 GB each; the idle stop applies).
- **Not covered:** cross-project test-class dependencies
  (`project(path: …, configuration: 'tests')`) and custom source sets' classpaths
  (`engine/benchmark`'s `src/benchmark/java`). Both left errors in the exploration and are a
  follow-up for the init script; see [Known gaps](#known-gaps).

## Contracts

### Manifest

```json
{
  "id": "java-lsp",
  "version": "0.1.0",
  "name": "Java language server for devc web",
  "description": "Installs devc-lsp-java, the launcher devc web uses for Java intelligence: Eclipse JDT LS 1.63.0 on a private JDK 25, configured to write nothing into your repo (no bin/, no .project/.classpath/.settings). Gradle builds are imported without running tasks; generated sources come from your own Gradle builds, as in IntelliJ.",
  "documentationURL": "https://github.com/devc-tools/devc-tools/tree/main/features/java-lsp",
  "licenseURL": "https://github.com/devc-tools/devc-tools/blob/main/LICENSE",
  "options": {
    "buildCommand": {
      "type": "string",
      "default": "./gradlew compileJava compileTestJava --continue",
      "description": "What Build (Gradle) runs in the project root, through a login shell. It should produce generated sources (annotation processors, protoc); compile tasks do, since source-generating tasks are their dependencies."
    },
    "jdk": {
      "type": "string",
      "default": "",
      "description": "Absolute path of the JDK your project builds with. It runs the Gradle import and is the JavaSE runtime JDT LS checks against. Empty: $JAVA_HOME, then the JDK of `java` on PATH."
    },
    "maxHeap": {
      "type": "string",
      "default": "4G",
      "description": "JDT LS's -Xmx. deephaven-core (197 Gradle projects) settled near 2.4 GB resident with autobuild off."
    },
    "gradleArguments": {
      "type": "string",
      "default": "",
      "description": "Extra arguments for the Gradle import, appended after the Feature's own --init-script, e.g. -PuseIdeaPaths=false."
    }
  }
}
```

### install.sh

`set -e`, `LC_ALL=C`, and `die()` with the prefix `java-lsp:`, in `features/xvfb/install.sh`'s
style.

1. **Validate.**
   - `MAXHEAP` matches `^[0-9]+[mMgG]$`.
   - `JDK` is empty or absolute with no whitespace or `"`.
   - `BUILDCOMMAND` and `GRADLEARGUMENTS` must not contain a newline.
   - The values are baked base64, so other characters are safe.
2. **Fetch tools.** `curl`, `tar` and `gzip`; same `apt-get` fallback as the other LSP Features.
3. **Architecture.** `x86_64` → `x64`, `aarch64`/`arm64` → `aarch64`, else die.
4. **JDK 25 (Temurin), pinned `JDK_RELEASE='jdk-25.0.5+8'`.**
   - Download
     `https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5%2B8/OpenJDK25U-jdk_<arch>_linux_hotspot_25.0.5_8.tar.gz`
     and verify against the `.sha256.txt` published beside it.
   - Extract to `/usr/local/share/devc-features/java-lsp/jdk` (`--strip-components=1`).
   - It runs only JDT LS; it is never put on `PATH` and never set as `JAVA_HOME`.
5. **JDT LS 1.63.0, pinned.**
   - Download
     `https://download.eclipse.org/jdtls/milestones/1.63.0/jdt-language-server-1.63.0-202610191322.tar.gz`.
   - Verify the SHA-256 baked into `install.sh`:
     `b1f2abe0b3cccb462cf64fb4a5587c7d09df60cf8be7748b152cbd89d018bdc4`.
   - Extract to `/usr/local/share/devc-features/java-lsp/jdtls`. It stays read-only, and each
     user gets a writable copy of its config at run time.
6. **Init script.** `devc-jdtls.gradle` → `/usr/local/share/devc-features/java-lsp/devc-jdtls.gradle`.
7. **Launcher.** `/usr/local/bin/devc-lsp-java`, `0755`, with the four options baked base64.
8. `chmod -R a+rX` on everything installed.

### Init script

`devc-jdtls.gradle`, given to the import as `--init-script <path>`. Start from the exploration's
`design/devc-web-language-services/devc-jdtls.gradle`. For every project with the `java` plugin,
it applies `eclipse` and, in `eclipse.classpath.file.whenMerged`:

1. **Output under `build/`.** Rewrites any source entry output `bin/<x>` to
   `build/jdtls-bin/<x>`, and sets `eclipse.classpath.defaultOutputDir` to
   `build/jdtls-bin/default`. With autobuild off nothing is compiled, so this is defense in
   depth: if anything ever does build, it lands in a directory every Gradle repo ignores.
2. **Missing project dependencies.** Adds a `ProjectDependency` for every project in
   `compileClasspath` or `testCompileClasspath` (resolved project components other than
   itself) that the merged entries lack, named `/<eclipse.project.name>`.
3. **Generated source folders.** Adds a `SourceFolder` for each existing directory below that
   is not already a source entry, with the attribute `optional=true`, and `test=true` for test
   ones. They are added **only if the directory exists**: a missing required source folder
   stops JDT from building that project.
   - `build/generated/sources/*/java/main` and `build/generated/sources/*/java/test` (any
     generator: `annotationProcessor`, `protoc`, …)
   - `out/production/classes/generated` and `out/test/classes/generated_tests` (deephaven-core's
     `useIdeaPaths` locations)

**Gotcha:** `whenMerged` is applied to the tooling-API model Buildship reads; the exploration
verified the output and dependency changes landing in JDT. It must not resolve configurations
outside the project being configured. JDT's own `apt/init.gradle` breaks Gradle 9 doing exactly
that.

### Launcher

`devc-lsp-java` is a bash script (no JSON parsing is needed: every input is a path or a baked
string). Its `json_str` helper escapes `\` and `"`, and refuses (exit 1) any value containing a
control character.

**`describe <file>`:**

1. Extension `java` → `languageId` `java`; anything else exits 3 with `not a Java file`.
2. **Top**: `git rev-parse --show-toplevel`, or `/`.
3. **Root**:
   - the topmost directory from the file's directory to top holding `settings.gradle` or
     `settings.gradle.kts` → kind `Gradle`
   - else the topmost holding `pom.xml` → `Maven`
   - else top, or the file's directory when top is `/` → `no build`
4. **Project JDK**: the first of the baked `jdk` option, `$JAVA_HOME`, or
   `$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")`, that has an executable
   `bin/java`.
   - Its major version comes from `JAVA_VERSION="<v>"` in `<jdk>/release` (the part before the
     first `.`; `1.8` → 8).
   - Not found → no runtime entry and no `java.import.gradle.java.home`.
5. Print, on one line:

```json
{
  "protocol": 1,
  "root": "<root>",
  "languageId": "java",
  "server": "JDT LS 1.63.0 (Gradle, JDK 21)",
  "initializationOptions": {
    "settings": <S>,
    "extendedClientCapabilities": {"classFileContentsSupport": true}
  },
  "settings": <S>
}
```

where `<S>` is:

```json
{
  "java": {
    "autobuild": { "enabled": false },
    "import": {
      "generatesMetadataFilesAtProjectRoot": false,
      "gradle": {
        "enabled": true,
        "wrapper": { "enabled": true },
        "annotationProcessing": { "enabled": false },
        "arguments": "--init-script /usr/local/share/devc-features/java-lsp/devc-jdtls.gradle <gradleArguments>",
        "java": { "home": "<jdk>" }
      },
      "maven": { "enabled": true }
    },
    "configuration": {
      "updateBuildConfiguration": "automatic",
      "runtimes": [
        { "name": "JavaSE-<major>", "path": "<jdk>", "default": true }
      ]
    }
  }
}
```

The server string's parts are the kind and `JDK <major>` (omitted when not found).
`generatesMetadataFilesAtProjectRoot` is in the settings only so JDT LS's view agrees with the
`-D` flag; the flag is what works.

**`serve --root <root>`:**

- `cache="${XDG_CACHE_HOME:-$HOME/.cache}/devc-lsp/java"`.
- **Data dir**: `$cache/data/<first 16 hex of sha256 of root>`. It is outside the repo, and
  persists across restarts (not rebuilds) so a second start is fast: about 3 s instead of 15 s
  on deephaven-core.
- **Config dir**: `$cache/config-1.63.0-<arch>`, copied from
  `jdtls/config_linux` (`x64`) or `jdtls/config_linux_arm` (`aarch64`) when absent. JDT LS writes
  into it, and the install is read-only.
- `cd <root>`, then exec:

```sh
exec <jdk25>/bin/java \
  -Djava.import.generatesMetadataFilesAtProjectRoot=false \
  -Declipse.application=org.eclipse.jdt.ls.core.id1 \
  -Dosgi.bundles.defaultStartLevel=4 \
  -Declipse.product=org.eclipse.jdt.ls.core.product \
  -Xmx<maxHeap> -XX:+UseParallelGC \
  --add-modules=ALL-SYSTEM \
  --add-opens java.base/java.util=ALL-UNNAMED \
  --add-opens java.base/java.lang=ALL-UNNAMED \
  -jar <jdtls>/plugins/org.eclipse.equinox.launcher_*.jar \
  -configuration <config dir> -data <data dir>
```

Resolve the launcher jar's glob to exactly one file; if it doesn't resolve to one, exit 1.

**`build --root <root>`:** `cd <root>`, then exec `bash -lc "$BUILD_COMMAND"`. Output goes to
stdout and stderr, and the exit code is the build's.

### devc web additions

Browser → server (`protocol.ts`):

```ts
| { type: 'lsp_build'; id: string; session: string }
| { type: 'lsp_reload'; id: string; session: string }
```

**`lsp_build`** is refused with `bad_request` unless the session's language is `java`, and with
`busy` while a build of the same session runs. Otherwise:

1. Run `devc-lsp-java build --root <root>` through `docker exec` (`spawnLines`, login shell, as
   the core runs `describe`).
2. Keep the last 2,000 output lines.
3. While it runs, send `lsp_status` with the current state and detail
   `Gradle build: <last line, truncated to 120 chars>`.
4. Reply `{ok: true, result: {code}}` when the build ends.
5. Then **reload**, whatever the exit code; a failed build may still have generated sources.
   Detail: `Gradle build finished` or `Gradle build failed (exit N)`, then the reload's own
   progress.

**`lsp_reload`** reloads now: send `workspace/executeCommand {command: "java.project.getAll"}`,
then the notification `java/projectConfigurationsUpdate {identifiers: [{uri} for each]}`. The
detail is `Reloading Gradle project…` until the next `language/status` `ProjectStatus`, or 120 s.

The exploration verified that `java/projectConfigurationsUpdate` picks up a generated-source
folder created after import: the unresolved `ImmutableBaseboardOshi` error cleared. Do not use
the deprecated `java/projectConfigurationUpdate`.

**Automatic reload.** The core's host watcher gives Java sessions a hook for **directory**
create and remove events whose path relative to the root matches either:

- `**/build/generated/sources/*/java/{main,test}`
- `**/out/{production/classes/generated,test/classes/generated_tests}`

Any match schedules a reload 10 s after the last such event (debounced), skipped while a build
of that session runs, since the build ends in a reload anyway. File events inside those folders
reach JDT LS as usual (`didChangeWatchedFiles`) and need no reload.

**Show build output** is one more browser → server request, returning the kept lines:

```ts
| { type: 'lsp_build_output'; id: string; session: string }
```

Reply `{ok: true, result: {lines: string[], code: number | null}}`.

**Page (`lsp.js`, `menus.js`, `tiles.js`).** Java tiles' menus, after **Restart language
server**:

- **Build (Gradle)**: disabled while that session's build runs
- **Reload Gradle project**
- **Show build output**: only after a build in this session

**`jdt:` URIs.** `registerUriScheme('jdt', uri => …)` calls
`client.request('java/classFileContents', {uri})`. It opens a **read-only text tile** titled with
the class name (the last path segment of the URI before `?`, without `.class`), with Java
highlighting and no language attachment. The text is the decompiled class, or its source when
JDT has a source jar. **Show build output** uses the same read-only text tile.

- Read-only text tiles are not saved in the layout state: they are gone after a reload.
- They have **Close** only in their menu.

## Known gaps

- **Cross-project test classes and custom source sets** (`ArrayGenerator`, `DoubleVectorTest`,
  `engine/benchmark`) remain unresolved. A follow-up plan extends the init script; it is not
  verified here.
- **Edits to `@Value.Immutable` types** show stale generated code until a Gradle build.
- **No workspace-wide error list:** with autobuild off, only open files have diagnostics.

## Gotchas

- **JDT LS needs Java 25 to run.** The 1.64 snapshot refused JDK 21 (`osgi.ee` `version=25`).
  Hence the private JDK; the project's JDK stays whatever it is.
- **`java.import.gradle.java.home` = project JDK.** Gradle runs on the project's JDK, as in a
  terminal. Running an older Gradle on JDK 25 fails.
- **Stdout noise.** On a bad start, JDT LS prints `An error has occurred. See the log file` to
  stdout. The core's framing reader discards it and shows it in the `exited` detail. The real
  log is `<config dir>/<timestamp>.log` and `<data dir>/.metadata/.log`; the README says so.
- **`processId: null`** (the core sends it). JDT LS otherwise watches a pid that does not exist
  in the container and exits.
- **Do not send `textDocument/didSave`** from any probe or test. JDT re-reads the file from disk
  on save, so an unsaved planted error disappears. (This misled the exploration once.)
- **First import of deephaven-core**: about 15 s with a warm Gradle daemon, much longer cold.
  The status line shows JDT's `language/status` progress meanwhile.

## Tests

`test/launcher_test.sh` (offline, needs `git` and `sha256sum`). It runs `describe` against
fixtures in `mktemp -d`, and checks fields with `grep` / `sed` on the one-line JSON (fields are
emitted in a fixed order to allow this):

| Fixture                                                                              | Expect                                                  |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| git repo, `settings.gradle` at top and in `buildSrc/`; file `a/src/main/java/X.java` | root = repo; `Gradle`                                   |
| git repo, `pom.xml` only                                                             | `Maven`                                                 |
| no build files                                                                       | `no build`; root = repo                                 |
| baked `jdk` = a fake JDK dir with `bin/java` and `release` `JAVA_VERSION="21.0.12"`  | `JavaSE-21`, `java.home` = that dir, server `… JDK 21)` |
| baked `jdk` empty, `JAVA_HOME` = a fake JDK with `JAVA_VERSION="1.8.0_402"`          | `JavaSE-8`                                              |
| no JDK anywhere (`PATH` without `java`, `JAVA_HOME` unset)                           | no `runtimes`, no `java.home`, server without `JDK`     |
| baked `gradleArguments` `-PuseIdeaPaths=false`                                       | `arguments` ends with it                                |
| a file path containing a newline                                                     | exit 1                                                  |
| `X.kt`                                                                               | exit 3                                                  |

`devc/tests/`:

- parser tests for `lsp_build`, `lsp_reload` and `lsp_build_output`
- `web_lsp_manager_test.ts` cases with the fake server:
  - build then reload order
  - `busy` on a second build
  - the reload notification carries every project URI from `java.project.getAll`
  - the automatic reload is debounced and fires once for three folder creations in 1 s,
    never for file events inside them

Docker scenarios (image `mcr.microsoft.com/devcontainers/base:ubuntu`):

- **`test.sh`** (default `{}`): a generated 2-project Gradle build (wrapper included). `serve`
  answers `initialize` and reaches `language/status` `ServiceReady` within 180 s. Afterwards,
  `find <root> -name .project -o -name .classpath -o -name .settings -o -name bin` is empty.
- **`with_options`**: `{"maxHeap": "2G", "buildCommand": "./gradlew compileJava"}`. The
  launcher's baked values show in `describe`, and `build` runs the command.
- **`bad_heap`**: `{"maxHeap": "lots"}` must fail the build.

## Validation

- [ ] `bash features/java-lsp/test/launcher_test.sh` passes every fixture row
- [ ] `bash tests/features_test.sh --feature java-lsp` passes
- [ ] `bash features/java-lsp/test/run-features-test.sh` passes every scenario (Docker)
- [ ] `cd devc && deno task check && deno task test` passes with the new parser and manager tests
- [ ] Manual setup: a **fresh** deephaven-core worktree with the Feature added to its
      devcontainer (copy into `.devcontainer/`, `"./java-lsp": {}`), then `devc build` and
      `devc web`.
- [ ] Manual: open `engine/table/src/main/java/io/deephaven/engine/table/impl/QueryTable.java`.
  - [ ] the status shows import progress, then clears
  - [ ] hover on `getRowSet()` shows `TrackingRowSet … getRowSet()`
  - [ ] `getRowSet().` offers `copy()`
  - [ ] F12 on `TrackingRowSet` opens its source file
  - [ ] imports of `io.deephaven.util.annotations` have **no** error (the dependency fix)
- [ ] Manual: plant `int devcProbe = "x";` in the class body; underlined within 3 s
- [ ] Manual: `DHProcess/src/main/java/io/deephaven/process/BaseboardOshi.java` shows
      `ImmutableBaseboardOshi cannot be resolved` (fresh worktree, no build yet).
      **Build (Gradle)** shows Gradle output in the status line; when it ends, the error clears
      within 2 minutes.
- [ ] Manual: in a second fresh worktree, run `./gradlew :DHProcess:compileJava` **from a
      terminal** while `BaseboardOshi.java` is open. The error clears without using the menu
      (automatic reload).
- [ ] Manual: F12 on `java.util.List` opens a read-only `List` tile with source or decompiled
      text. Reloading the page drops that tile.
- [ ] Manual: **Show build output** shows the last build's lines and exit code
- [ ] **No repo writes.** After all of the above, `git status --porcelain --ignored` in the
      worktree, compared with a snapshot taken before devc web opened anything, has **no**
      `.project`, `.classpath`, `.settings/`, `bin/` or `build/jdtls-bin` entries. The only
      differences are Gradle's own `build/` and `out/` from the Build runs. `.gitignore` and
      `.git/info/exclude` are unchanged (`git diff` and `stat`).
- [ ] Manual: with `DEVC_WEB_LSP_IDLE_MS=60000`, close the Java tiles. After a minute,
      `pgrep -f org.eclipse.jdt.ls` in the container finds nothing. Reopening `QueryTable.java`
      is ready in under 10 s (the data dir is reused).
- [ ] `deno fmt --check` passes for every touched file

## Relevant Files

- `features/java-lsp/devcontainer-feature.json` — new
- `features/java-lsp/install.sh` — new
- `features/java-lsp/devc-jdtls.gradle` — new, from
  `.plans/design/devc-web-language-services/devc-jdtls.gradle`
- `features/java-lsp/devc-lsp-java` — new
- `features/java-lsp/README.md` — new: what it writes (nothing in the repo; caches under
  `~/.cache/devc-lsp/java`), options, the IntelliJ-style build, the deephaven-core
  `buildCommand` (default works: `compileJava` depends on `syncProtocJava`), log locations,
  known gaps
- `features/java-lsp/test/launcher_test.sh` — new
- `features/java-lsp/test/test.sh` — new
- `features/java-lsp/test/scenarios.json` — new
- `features/java-lsp/test/with_options.sh` — new
- `features/java-lsp/test/bad_heap.sh` — new
- `features/java-lsp/test/run-features-test.sh` — copied from `features/xvfb/test/`
- `features/README.md` — row
- `features/CONTRIBUTING.md` — test inventory and `### java-lsp` note (private JDK 25; the `-D`
  metadata flag; autobuild off; pinned JDT LS sha256)
- `features/PUBLISH_ALLOWLIST.txt` — `java-lsp`, last
- `devc/web/protocol.ts` — `lsp_build`, `lsp_reload`, `lsp_build_output`
- `devc/web/server.ts` — handlers
- `devc/web/lsp_manager.ts` — build runs, kept output, reload, automatic reload debounce
- `devc/web/lsp_watch.ts` — directory-event hook for sessions
- `devc/web/static/lsp.js` — `jdt` scheme handler, build/reload/output calls
- `devc/web/static/tiles.js` — read-only text tiles (not persisted)
- `devc/web/static/menus.js` — the three Java items
- `devc/tests/web_server_test.ts` — parser tests
- `devc/tests/web_lsp_manager_test.ts` — build/reload cases
- `devc/tests/fixtures/fake_lsp_server.ts` — answers `java.project.getAll` and records
  `java/projectConfigurationsUpdate`
- `devc/README.md` — Java in the **Language servers** bullet: Build (Gradle), Reload Gradle
  project, read-only class tiles
- `.plans/design/devc-web-language-services.md` — corrected Java findings (see that doc)
- `.plans/PLAN.md` — status
