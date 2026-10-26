# Language services in devc web: Java, TypeScript, Python

Exploration doc, not a plan. It answers one question: what would it take for devc web's file
editor (the CodeMirror view in `devc/web/static/viewer.js`) to offer completion, hover,
go-to-definition and diagnostics for Java, TypeScript and Python, in a way that works on the
repos it is actually used with. The design aims for one mechanism that every language server
plugs into.

Measured 2026-10-23 inside a deephaven-core devcontainer (8 cores, 58 GB, JDK 21 on `PATH`,
Gradle 9.6.1 wrapper, Node 24.10, Python 3.12). Targets:

- **Java:** a scratch clone of [deephaven-core](https://github.com/deephaven/deephaven-core)
  at `974fe346e8`
- **TypeScript:** [web-client-ui](https://github.com/deephaven/web-client-ui) at `fe173e95`
  (37 packages, TS 5.6.3, project references, `paths`), and devc-tools itself (Deno)
- **Python:** deephaven-core's `py/server`, with its venv at
  `/usr/local/share/deephaven-core/venv`

No devc code was changed. The probe clients and the Gradle init script are beside this file
in [`devc-web-language-services/`](devc-web-language-services/).

## Summary

- **Java: Eclipse JDT LS** (the engine behind VS Code's Java extension), run inside the
  container, configured to write **nothing** into the repo:
  - autobuild off
  - the `-Djava.import.generatesMetadataFilesAtProjectRoot=false` JVM flag
  - a Gradle init script

  Generated sources come from Gradle builds, as in IntelliJ. The NetBeans-based server is not
  recommended (slow, missed a planted error, non-standard `initialize`). See
  [Java](#why-vs-codes-java-support-misbehaves-on-deephaven-core) and
  [the corrected setup](#update-2026-10-23-nothing-written-into-the-repo).
- **VS Code itself (outside devc): settings, not a custom extension.** With the Java
  Extension Pack, `java.autobuild.enabled: false`,
  `java.import.gradle.annotationProcessing.enabled: false` and a 4 GB JDT LS heap gave zero
  errors in the files checked, no `bin/`, and saves that cost almost nothing. The pack's Gradle
  build server, on by default, supplies the classpath, so no init script is needed. See
  [VS Code on deephaven-core](#vs-code-vscode-java-on-deephaven-core).
- **TypeScript: pick the server from the repo.** See [TypeScript](#typescript).
  - `deno.json` → `deno lsp`
  - workspace TypeScript ≥ 7 → its own `tsc --lsp --stdio`
  - otherwise **vtsls** on the workspace's TypeScript
  - All three worked on their targets out of the box. TS 7 is about 10× faster but must not
    replace an older workspace TypeScript, because it rejects config that TS 5.x accepts.
- **Python: basedpyright, rooted at the nearest `pyproject.toml`**, with the interpreter set to
  the project's venv. See [Python](#python). The root matters more than the server: rooted at
  the repo, most servers jump to the stale installed wheel instead of the source. ty is the
  fastest and is the one to watch, but it is pre-1.0.
- **Client: `@codemirror/lsp-client`** (6.3.0, MIT, by the CodeMirror author) plus the
  language packages, vendored into the existing CodeMirror bundle. It handles only push
  diagnostics, so the host turns pull results into push (TS 7, Deno, ty).
- **Transport:** devc web's server keeps one long-lived language server per (container,
  workspace root, server) through `docker exec -i`, and relays LSP over the existing `/ws`
  socket. All tabs and browser connections share it.

## Why VS Code's Java support misbehaves on deephaven-core

"It makes `bin` folders" is one of four separate problems. All four were reproduced with a
stock JDT LS 1.64.0 snapshot (Buildship 3.1.13, JDT core 3.48.0):

1. **`bin/` output folders.** JDT LS imports Gradle builds through Buildship, which compiles
   each project into `<project>/bin/<sourceSet>`. deephaven-core's `.gitignore` does not cover
   `bin/`, so 80 untracked folders appear.
2. **Eclipse metadata in the tree.** `.project`, `.classpath` and `.settings/` were written
   into 196 project folders, even with `java.import.generatesMetadataFilesAtProjectRoot:
   false` sent as an LSP setting. All three are untracked (not ignored) in deephaven-core.
   **Corrected later:** that setting is read as a JVM system property, not an LSP setting.
   See [the update](#update-2026-10-23-nothing-written-into-the-repo).
3. **Annotation processing fails under Gradle 9.** JDT LS injects `gradle/apt/init.gradle`,
   which resolves each project's `annotationProcessor` configuration from a model builder.
   Gradle 9 rejects that: "Resolution of the configuration ':application-mode:annotationProcessor'
   was attempted without an exclusive lock". The model fetch aborts, so no
   Immutables-generated type (`ImmutableFoo`) resolves. Open upstream:
   [eclipse.jdt.ls#3807](https://github.com/eclipse-jdtls/eclipse.jdt.ls/issues/3807),
   [eclipse.jdt.ls#3924](https://github.com/eclipse-jdtls/eclipse.jdt.ls/issues/3924).
4. **Gradle's Eclipse model drops `compileOnly` and `compileOnlyApi` project dependencies.**
   For `:engine-table`, `configurations.compileClasspath` contains `:util-annotations` and
   `:util-immutables`, but `eclipse.classpath.resolveDependencies()` does not. That yields
   hundreds of "The import io.deephaven.util.annotations cannot be resolved" errors. This is
   Gradle's model, not a JDT LS bug, so any Eclipse-model consumer inherits it.

IntelliJ works on the same repo because it reads Gradle's IDEA/per-source-set model rather
than the Eclipse model, and delegates builds (including annotation processing and protoc) to
Gradle. deephaven-core's `Tools.applyAnnotationProcessorPathHacks` exists to keep IntelliJ's
and Gradle's generated sources in one place (`out/production/classes/generated`). Only
`DHProcess` uses that path; the other 58 annotation-processing projects use Gradle's default
`build/generated/sources/annotationProcessor/java/<sourceSet>`.

Two more facts any Java server has to live with on deephaven-core:

- **Proto Java sources are generated in Docker.** `:proto:proto-backplane-grpc` adds
  `syncProtocJava`'s output as a source dir, and `generateProtobuf` runs protoc in a Docker
  image. Until that task has run, `io.deephaven.proto.backplane.*` is unresolved (958 errors
  in the probe).
- **Build files are named `<Project>.gradle`** (e.g. `Util/Util.gradle`), and Gradle projects
  nest inside each other's folders (`:Util` at `Util/`, `:util-annotations` at
  `Util/annotations/`). Buildship handled both.

## Java measurements

|                                    | JDT LS, stock settings        | JDT LS + init script + pre-build          | NetBeans LSP (Oracle Java 27.0.0)                   |
| ---------------------------------- | ----------------------------- | ----------------------------------------- | --------------------------------------------------- |
| Time to ready                      | 172 s (first import)          | ~16 s (warm daemon, configuration cached) | 502 s (projects load one at a time)                 |
| Hover / go-to-definition           | ✅                            | ✅                                        | ✅                                                  |
| Member completion (`getRowSet().`) | ✅                            | 50 items in ~1 s                          | 74 items in 10.7 s, top items were `Object` members |
| Files with error diagnostics       | 1,099 (run 2, after settling) | 280                                       | 0 reported (published only for open files)          |
| Planted `int x = "s";` reported    | –                             | ✅ within 25 s                            | ❌ not within 25 s                                  |
| Written into the repo              | `bin/` ×80, metadata ×196     | metadata ×196; output under `build/`      | only gitignored `.gradle/nb-cache`, `build/`        |
| Server RSS                         | 1.6 → 3.1 GB                  | 1.4 → 4.7 GB peak (`-Xmx6G`)              | 3.6 GB                                              |
| Runtime requirement                | **JDK 25** to run the server  | same                                      | JDK 17+ (ran on 25)                                 |

Notes on the numbers:

- **JDK 25.** Current JDT LS will not start on JDK 21: OSGi refuses
  `org.eclipse.core.filesystem` with `Require-Capability: osgi.ee; (version=25)`. The project
  still compiles against the JDK 21 toolchain via `java.configuration.runtimes`. A Feature has
  to ship its own JDK 25 for the server.
- **Stdout noise.** On startup failure, JDT LS prints "An error has occurred. See the log file"
  to stdout, which is the LSP channel. A framing reader must skip non-header lines rather than
  crash.
- **The 280 remaining error files** (steady state on the second boot of the same workspace)
  fall into three groups:
  - **Immutables in projects that were not pre-built** (ssl/config, extensions/json,
    extensions/iceberg, java-client/session). The pre-build only covered `:engine-table` and
    its dependencies. A full `compileJava compileTestJava` should clear these; not run.
  - **Cross-project test classes** (`ArrayGenerator`, `DoubleVectorTest`,
    `BaseTestDoubleTimSortKernel`) used through `project(path: …, configuration: 'tests')`,
    which the Eclipse model cannot express. Probably fixable in the init script by marking those
    project entries `without_test_code=false`; not verified.
  - **`engine/benchmark`'s `src/benchmark/java` source set**, whose classpath configurations
    are not in the Eclipse model's `plusConfigurations`. Probably fixable in the init script;
    not verified.
- **NetBeans** crashed on `initialize` (NPE in `NbCodeClientCapabilities`) until the client
  sent `initializationOptions.nbcodeCapabilities`, which is private to its own VS Code client.
  It may support pull diagnostics (`textDocument/diagnostic`), which the probe did not send,
  so the missing planted error is "not observed", not "unsupported".

## The deephaven-core workaround for JDT LS

Two parts, both outside JDT LS itself:

1. **Init script**, passed via `java.import.gradle.arguments: "--init-script <path>"`
   ([`devc-jdtls.gradle`](devc-web-language-services/devc-jdtls.gradle)). Through
   `eclipse.classpath.file.whenMerged`, which the probe showed Gradle applies to the
   tooling-API model Buildship reads, it does three things:
   - moves `bin/<sourceSet>` output to `build/jdtls-bin/<sourceSet>` (gitignored)
   - adds every project from `compileClasspath`/`testCompileClasspath` that the model dropped
   - adds the annotation-processor output dirs as optional source folders, **only if they
     exist**. A missing required source folder stops JDT from building that project at all.
2. **Settings:**
   - `java.import.gradle.annotationProcessing.enabled: false`, to avoid the Gradle 9 failure
     and use Gradle's generated sources instead
   - `java.configuration.runtimes` pointing at the container's JDK 21
   - the workspace data dir (`-data`) outside the repo
3. **Pre-build before import (probe only; the plan uses an IntelliJ-style build action instead, see the update below):**
   `./gradlew :proto:proto-backplane-grpc:syncProtocJava compileJava compileTestJava --continue`.
   The probe ran only `:engine-table:compileTestJava` plus the proto task, which took about 1 min
   with the build cache warm.

The trade-off of turning annotation processing off: an `ImmutableFoo` stays stale after its
interface changes until Gradle runs again. IntelliJ users who delegate builds to Gradle live
with the same model.

### Update 2026-10-23: nothing written into the repo

Hiding output with `.gitignore` or git excludes is not acceptable, so the follow-up runs
removed the need for it. Verified on a scratch clone of deephaven-core:

| Setup                                                                                       | `.project` / `.classpath` / `.settings` | `bin/` | Untracked files (`git status`) | Planted error reported        |
| ------------------------------------------------------------------------------------------- | --------------------------------------- | ------ | ------------------------------ | ----------------------------- |
| stock                                                                                       | 197 / 160 / many                        | 154    | many                           | ✅                            |
| autobuild off, no `-D`, no init script                                                      | 197 / 160 / many                        | **0**  | many                           | (imports unresolved)          |
| **autobuild off + `-Djava.import.generatesMetadataFilesAtProjectRoot=false` + init script** | **0**                                   | **0**  | **0**                          | ✅ about 2.6 s after the edit |

- **`bin/` comes from JDT LS's own compiler** (`java.autobuild`), not from any Gradle build.
  With autobuild off, nothing is compiled. Open files are still checked as you type
  (reconcile). Lost: diagnostics for files that are not open, which devc web does not show
  anyway.
- **The metadata setting is a JVM system property.** The `org.eclipse.jdt.ls.filesystem`
  bundle reads `System.getProperty("java.import.generatesMetadataFilesAtProjectRoot")`. VS Code
  passes it as `-D…=false`, and sent as an LSP setting it is ignored. With the flag, Eclipse
  project metadata lives in the server's `-data` directory.
- **The init script is still needed** for the dropped `compileOnly` dependencies and the
  generated-source folders. Its `bin/` redirect is now only defense in depth.
- **Pre-build, done the IntelliJ way.** IntelliJ's Gradle sync runs no tasks; generated sources
  appear on the first Build Project, which runs Gradle (`compileJava` depends on
  `syncProtocJava`). Here:
  - the import runs no tasks
  - a **Build (Gradle)** action runs `./gradlew compileJava compileTestJava --continue`
  - JDT LS reloads with `java/projectConfigurationsUpdate`, which was verified to pick up a
    generated folder created after import
- A probe that sent `textDocument/didSave` lost its planted error, because JDT re-reads the
  file from disk on save. Probes must not send it.

### File changes made outside the editor

With a client that does not advertise `workspace/didChangeWatchedFiles`, an on-disk edit to a
file that is not open (as an agent makes) was noticed only by `tsserver`-based servers
(typescript-language-server, vtsls). TS 7, `deno lsp`, pyright, basedpyright and ty all missed
it. All four that were re-tested (TS 7, Deno, basedpyright, ty) picked it up within about 4 s
once the client sent `workspace/didChangeWatchedFiles`. So devc web watches each root from the
host (`Deno.watchFs`; the repo is bind-mounted) and forwards matching changes.

## TypeScript

Every probe used `lsp_generic.py` on one file, run in the same way:

- hover and go-to-definition on a symbol imported from another package
- dot-completion
- a planted `const devcProbe: number = "x";`

For web-client-ui the file was `packages/iris-grid/src/IrisGrid.tsx` (5,888 lines), the
symbol was `GridRange` (imported from `@deephaven/grid` through `paths`), and completion was
on `GridRange.`. For devc-tools the file was `devc/web/server.ts`, the symbol was `confine`
(from `./files.ts`), and completion was on `await Deno.`.

| Server                                                | Target        | Ready (first diagnostics) | Definition                          | Completion        | Planted error | RSS      | Diagnostics                                        |
| ----------------------------------------------------- | ------------- | ------------------------- | ----------------------------------- | ----------------- | ------------- | -------- | -------------------------------------------------- |
| typescript-language-server 6.0.2 (workspace TS 5.6.3) | web-client-ui | 10.2 s                    | `packages/grid/src/GridRange.ts` ✅ | 35 items, 0.03 s  | ✅ 1.5 s      | 1,015 MB | push                                               |
| vtsls 0.3.0 (workspace TS 5.6.3)                      | web-client-ui | 10.4 s                    | ✅ same                             | 35 items, 0.03 s  | ✅ 1.7 s      | 1,048 MB | push                                               |
| TypeScript 7.0.2 native (`tsc --lsp --stdio`)         | web-client-ui | ~1.0 s                    | ✅ same                             | 35 items, <0.01 s | ✅ 0.17 s     | 308 MB   | **pull**                                           |
| deno lsp 2.9.8                                        | devc-tools    | 3.3 s                     | `devc/web/files.ts` ✅              | 124 items, 0.03 s | ✅ 0.5 s      | 554 MB   | **pull**                                           |
| typescript-language-server                            | devc-tools    | –                         | –                                   | –                 | –             | –        | `initialize` fails: no TypeScript in the workspace |

Findings:

- **typescript-language-server and vtsls are equivalent here.** Both wrap the workspace's own
  `tsserver`. vtsls wraps VS Code's TypeScript extension, so it has a few more features
  (call hierarchy, linked editing, on-type formatting), at the price of VS Code-specific noise
  ("Command setContext not found"). Before they finish loading the project, both answer hover
  with `(loading...)` and a local-only definition. The client must not treat early answers as
  final.
- **TypeScript 7 is the Go rewrite and is the fastest by far, but it isn't faithful to repos
  still on 5.x.** On web-client-ui, its CLI stops on three config errors before checking
  anything:
  - `baseUrl` has been removed
  - `moduleResolution=node10` has been removed
  - non-relative `paths` are not allowed

  The repo's TS 5.6.3 accepts all three. TS 7's language server did not surface those errors
  in the editor; it resolved imports anyway, under rules the project's own build does not use.
  The rule is: **run the TypeScript the workspace depends on.** If it is ≥ 7, use its
  `tsc --lsp --stdio`; if older, wrap it with vtsls.
- **Deno repos need `deno lsp`.** A `tsserver`-based server cannot read `jsr:`/`npm:` imports
  or `deno.json` import maps, and on devc-tools it does not even start. Detect `deno.json` or
  `deno.jsonc` above the file.
  - `deno lsp` needs `initializationOptions: {"enable": true}`.
  - Its one error before the plant was `JSR package "@std/path@^1" is not installed`. The
    dependency cache (`DENO_DIR`) has to be warm, the same way node projects need
    `npm install`.
- **What a TS server needs:**
  - Node in the container for vtsls and typescript-language-server; TS 7 and Deno are native
    binaries.
  - `node_modules` installed. Without workspace TypeScript, the wrappers either fail or fall
    back to a bundled version.
- **The workspace root is the folder holding the `tsconfig.json` / `package.json` /
  `deno.json`**, not necessarily the git root. deephaven-core holds small TS projects
  (`web/client-api/types`, `proto/raw-js-openapi`) inside a Java repo.
- **Lint is a second server.** web-client-ui's lint is ESLint and deephaven-core's Python lint
  is ruff (`ruff server`). In editors that run beside the type server and merge diagnostics,
  so the design should allow more than one server per file.

## Python

Every probe used `py/server/deephaven/pandas.py` in deephaven-core:

- hover and definition on `new_table` (from `deephaven.table_factory`)
- completion on `pd.`
- a planted `devc_probe: int = "x"`

The interpreter was the deephaven venv. It has `deephaven-core 43.0+snapshot` installed **as
a regular wheel**, per `AGENTS.md`'s `pip install --force-reinstall …whl`, not editable. So the
same modules exist twice: the source in `py/server/` and a copy in `site-packages`.

| Server                      | Root = repo: definition                                                 | Root = `py/server`: ready | Definition | Completion `pd.`                                      | Planted error         | RSS    | Diagnostics |
| --------------------------- | ----------------------------------------------------------------------- | ------------------------- | ---------- | ----------------------------------------------------- | --------------------- | ------ | ----------- |
| pyright 1.1.414             | `site-packages` copy ❌ (31.5 s, "enumeration… longer than 10 seconds") | 5.4 s                     | source ✅  | 138 items, 0.65 s                                     | ✅ 1.3 s              | 564 MB | push        |
| basedpyright 1.40.2         | `site-packages` copy ❌ (32.4 s)                                        | 4.4 s                     | source ✅  | 138 items, 2.1 s                                      | ✅ 0.9 s              | 683 MB | push        |
| ty 0.0.91                   | `site-packages` copy ❌ (0.2 s)                                         | 0.1 s                     | source ✅  | 157 items on a fresh line                             | ✅ 0.05 s             | 248 MB | **pull**    |
| pyrefly 1.4.0               | source ✅                                                               | 0.5 s                     | source ✅  | **0** for `pandas` (773 for `np.`, 40 for `DHError.`) | ✅ 0.02 s             | 347 MB | push        |
| jedi-language-server 0.47.0 | `site-packages` copy ❌                                                 | 1.5 s                     | source ✅  | 139 items, 3.0 s                                      | ❌ (no type checking) | 347 MB | push        |

Findings:

- **Root on the Python project, not the repo.** deephaven-core has several Python projects
  (`py/server`, `py/client`, `py/embedded-server`, `py/client-ticking`, `plugin/pyecho`), each
  with its own `pyproject.toml`.
  - Rooted at the repo, pyright and basedpyright walk the whole monorepo for over 20 s, and
    every server except pyrefly resolves `deephaven` from the installed wheel. Go-to-definition
    then opens a stale copy in `site-packages`, and edits there are lost on the next reinstall.
  - Rooted at `py/server`, every server resolves to the source.
  - So devc web should root a Python server at the nearest `pyproject.toml` / `setup.py` /
    `setup.cfg` above the file, one server per Python root. The alternatives are an editable
    install, or `extraPaths` settings per server.
- **Interpreter.** Every server needs to know the project's venv:
  - pyright and basedpyright: the `python.pythonPath` setting (served through
    `workspace/configuration`)
  - ty and pyrefly: `VIRTUAL_ENV` in the server's environment
  - jedi: `initializationOptions.workspace.environmentPath`

  deephaven-core's venv sits outside the repo, so this has to be per-repo configuration;
  detecting a `.venv` folder in the project covers the common case.
- **Noise differs by checker.** Errors reported in the untouched file:
  - pyright: 3, mostly pandas stubs
  - basedpyright: 7, from stricter defaults
  - ty: 4, including "Cannot resolve imported module `jpy`", because jpy is a compiled module
    with no stubs
  - pyrefly: 3

  deephaven-core actually checks with mypy and ruff (`[tool.mypy]`, `[tool.ruff]`), and mypy
  has no first-party language server. None of these servers will match the project's own
  checks exactly.
- **Importing `deephaven` without a running JVM raises** ("The Deephaven Server has not been
  initialized"). All five servers analyze statically, so this didn't matter; anything that
  imports modules to introspect them would fail on deephaven-core.
- **Recommendation: basedpyright**, at `typeCheckingMode: "standard"` to match pyright's noise
  level.
  - It is the most complete of the mature servers (semantic tokens, inlay hints, docstrings
    for builtins), MIT-licensed, and its PyPI package bundles Node, so a Python container
    needs no Node install.
  - pyright is the same engine with fewer features.
  - **ty** was the fastest and most accurate on the planted error, but it is 0.0.x and uses
    pull diagnostics. Revisit it once it reaches 1.0.
  - **pyrefly** is fast but returned no `pandas` completions.
  - **jedi** does no type checking.

## Proposed architecture

```
browser tile (CodeMirror + @codemirror/lsp-client)
   │  /ws: lsp.* messages (JSON-RPC payloads, container paths)
devc web server (host)  ── one LspSession per (container, root, server)
   │  docker exec -i -u <remoteUser> <container> devc-lsp <language> --root <root>
language server in the container (stdio, Content-Length framing)
```

- **Client.**
  - Vendor `@codemirror/lsp-client` 6.3.0 and `@codemirror/lang-java` 6.0.2 into
    `static/vendor/codemirror/codemirror.mjs` via `scripts/codemirror-entry.js`.
    `lang-javascript` and `lang-python` are already bundled.
  - 6.3.0 implements completion, hover, definition, declaration, type definition,
    implementation, references, rename, signature help, formatting and **push** diagnostics
    (`publishDiagnostics`) only. It has no `textDocument/diagnostic` and no semantic tokens.
  - `lsp-client` adds `marked` and `vscode-languageserver-protocol` as dependencies. The latter
    is types only at runtime, but check bundle size.
  - Its `Transport` is just `send`/`subscribe`/`unsubscribe` of JSON strings, so it maps onto
    `/ws` messages.
  - Add `java` to `lib/languages.js`; Java has no highlighting today.
  - `viewer.js` stays the only CodeMirror importer and gains an optional LSP extension.
- **Server-side session owner.** LSP is one client per server, while devc web has many tabs
  and many browser connections. So devc web's server, not the browser, owns `initialize`,
  `didOpen` reference counting per document, version numbers, and fanning diagnostics out to
  every subscriber. It also rewrites request ids per browser connection.
  `@codemirror/lsp-client`'s `Workspace` class is the browser-side hook for "several views of
  one file". Two more jobs land on the host:
  - **Pull to push.** For a server that advertises `diagnosticProvider` (TS 7, Deno, ty), send
    `textDocument/diagnostic` after each open or change (debounced) and send the result to
    browsers as `publishDiagnostics`.
  - **Server requests.** Answer `workspace/configuration` from the per-repo settings, and
    answer `client/registerCapability` and `window/workDoneProgress/create`, so no
    server-to-client request ever reaches a browser.
- **Process.**
  - A new framed-stdio child type beside `proc.ts`'s `spawnLines`, which is line-based. It is
    tracked for shutdown the same way.
  - Start lazily. Stop on idle: 3–5 GB per Java server, and each git worktree is its own root
    and its own server.
- **Paths.** Servers speak container `file://` URIs. Tiles already carry
  `localFolder`/`root`/`path`, and `@devc-tools/core/mount_paths.ts` translates host ↔
  container paths. Library sources (`jdt://` URIs from go-to-definition into a jar) need JDT's
  `java/classFileContents` request and a read-only tile.
- **Choosing the root and the server** is per file, by marker files above it, stopping at the
  workspace mount. It is detection, not configuration:

  | Language                | Root marker (nearest wins)                          | Server                                                                                                       |
  | ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
  | Java                    | `settings.gradle(.kts)` (outermost), else `pom.xml` | JDT LS                                                                                                       |
  | TypeScript / JavaScript | `deno.json(c)`                                      | `deno lsp`                                                                                                   |
  |                         | `tsconfig.json` / `jsconfig.json` / `package.json`  | workspace `typescript` ≥ 7: `tsc --lsp --stdio`; else vtsls on it; none installed: vtsls with its bundled TS |
  | Python                  | `pyproject.toml` / `setup.py` / `setup.cfg`         | basedpyright, interpreter from per-repo config, else `<root>/.venv`                                          |

  Java uses the outermost Gradle settings file because a Gradle build is one tree. TypeScript
  and Python use the nearest marker because their projects nest inside other repos
  (deephaven-core's `py/server`, `web/client-api/types`).
- **Shipping servers.**
  - A devc-tools Feature per language, each installing its servers and exposing one fixed
    launcher command, `devc-lsp <language> --root <dir>`, speaking stdio.
    - `java-lsp`: JDT LS plus a private JDK 25
    - `typescript-lsp`: vtsls; TS 7 and Deno come from the workspace and the image
    - `python-lsp`: basedpyright from PyPI, Node bundled
  - The launcher does the per-language choice in the table above, so devc web only knows
    languages and roots.
  - devc web finds the launcher with `command -v`, as it does `herdr`, so a container without
    the Feature simply gets no language service.
  - Later languages (Go, Rust) are each one more launcher behind the same command.
- **More than one server per file** (type checker plus ESLint or `ruff server`) is a later
  step. Leave room for it: key sessions by server, not language, and merge their diagnostics
  per document on the host.
- **Per-repo configuration.** The generic layer only needs three things: extra server
  settings, a command to run before first import, and an interpreter path. Per language:
  - Java on deephaven-core: an init script, settings and a pre-build command
  - TypeScript: nothing beyond `npm install` / a warm `DENO_DIR`
  - Python: the interpreter (deephaven-core's venv is at
    `/usr/local/share/deephaven-core/venv`)

## VS Code (vscode-java) on deephaven-core

Measured 2026-10-24 to answer three complaints about VS Code's Java support on deephaven-core:

1. `bin/` folders appear
2. the first load is very slow
3. any change sets off a cascade of rebuilding

The probe ran the **extension's own bundled server and JRE** headless:

- `redhat.java` 1.59.2026102308 from Open VSX (`linux-arm64`): JDT LS 1.64.0 and Buildship
  3.1.13 on its JRE 25.0.4.1
- the scratch clone of deephaven-core, with generated sources already built and a warm Gradle
  daemon
- 8 cores, Linux

The driver, [`vscode_sim.py`](devc-web-language-services/vscode_sim.py), behaves like VS Code:
it opens files, edits, and saves (didChange, disk write, didSave, and
`workspace/didChangeWatchedFiles` for the saved file). Every configuration gets the same
sequence:

- a cold import (fresh `-data` directory)
- a one-line method-body edit in `QueryTable.java`, saved
- a new default method on `Table.java`, which 631 files import, saved
- both files reverted, saved

Each phase is measured until CPU goes quiet. Configurations with the Gradle build server count
**whole-machine** CPU, because that path compiles in Gradle's daemon, not in JDT LS.

### What the extension does by default

From `package.json` and `dist/extension.js` in the vsix:

| Setting                                           | Default                           | Effect here                                                                                                                                                           |
| ------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `java.jdt.ls.vmargs`                              | `… -Xmx2G -Xms100m -Xlog:disable` | 24–26 full GCs per run, heap at its cap                                                                                                                               |
| `java.autobuild.enabled`                          | `true`                            | compiles every project on import and after every save, into `<project>/bin` (Buildship path)                                                                          |
| `java.import.gradle.annotationProcessing.enabled` | `true`                            | the Gradle 9 apt failure (eclipse.jdt.ls#3807, #3924)                                                                                                                 |
| `java.import.generatesMetadataFilesAtProjectRoot` | `false`                           | passed as the `-D…=false` JVM flag, so **no** `.project` / `.classpath` / `.settings`. deephaven-core's `.gitignore` also already covers those three, but not `bin/`. |

With the **Extension Pack for Java** installed, `vscjava.vscode-gradle` 3.18.0 adds
`java.gradle.buildServer.enabled: "on"`. Its description: _"It will replace the original
Buildship to import the Gradle."_

- JDT LS loads its bundle `com.microsoft.gradle.bs.importer-0.5.4.jar`, which reaches the Build
  Server for Gradle (inside the extension's `gradle-server`) over a named pipe, relayed by the
  extension's `BspProxy`.
- The importer installs `BuildServerBuilder` as each project's builder. Its `build()` (source:
  `microsoft/vscode-gradle`,
  `extension/jdtls.ext/com.microsoft.gradle.bs.importer/.../builder/BuildServerBuilder.java`):
  1. ignores the change delta and the build kind
  2. calls `buildTarget/compile`, which runs Gradle's `classes` task for every source set of the
     project, upstream tasks included (`BuildTargetService.compile` →
     `getBuildTaskName`), and waits for it (`join()`)
  3. refreshes the output folders of the project and all its transitive dependencies,
     `DEPTH_INFINITE`
- Upstream: microsoft/vscode-gradle#1441, "Performance issue when enabling Build Server", is
  open with 20 comments, and its report waited 30 minutes after opening a project.

### Results

Wall times are ±2 s: the precision of the quiet window. "Files with errors" counts files the
server reported errors in. With autobuild off, that is only the opened files (`QueryTable`,
`Table`).

| Config                                                      | Import, time to quiet | Import CPU-s            | Files with errors | Each save: CPU-s                            | Diagnostics published per save | GC (full) | Repo writes |
| ----------------------------------------------------------- | --------------------- | ----------------------- | ----------------- | ------------------------------------------- | ------------------------------ | --------- | ----------- |
| A: vscode-java alone, defaults (2 GB)                       | 131 s                 | 381                     | 818               | 13–18                                       | 290–580                        | 26        | 154 `bin/`  |
| B: as A, 4 GB                                               | 131–138 s             | 376–438 (whole machine) | 818–852           | 15–21                                       | 370–590                        | 11–12     | 154 `bin/`  |
| C: as B + init script + apt off, autobuild on               | 137 s                 | 381                     | 232               | 14–16                                       | 380–540                        | 12        | 0           |
| D: as C, **autobuild off**                                  | 89 s                  | 176                     | **0**             | 2–3                                         | 4–8                            | 5         | 0           |
| E: Java pack defaults (build server on, autobuild on), 4 GB | 123 s                 | 365 (whole machine)     | 24                | 17–24, **plus a Gradle build per save**     | 1,400–1,900                    | 8         | 0           |
| **G: build server on, autobuild off, apt off, 4 GB**        | 126 s                 | 324 (whole machine)     | **0**             | 5–7 (whole machine, mostly idle background) | 2–4                            | 5         | 0           |

- **#1 `bin/`:** from Buildship + autobuild (A, B). Gone with the init script's redirect (C),
  autobuild off (D), or the build server (E, G), which uses Gradle's own `build/classes`.
- **#2 slow load:**
  - Autobuild doubles import CPU (full compile).
  - On the plain-extension path, the missing `compileOnly` dependencies and broken apt leave
    818 files with errors.
  - The 2 GB default heap ran at its cap with 24–26 full GCs, but it didn't set the pace here:
    131 s at 2 GB vs 138 s at 4 GB.
- **#3 cascade:**
  - With autobuild on, every save rebuilds and re-reports 290–1,900 files' diagnostics, about
    15–24 CPU-s each time, even for a one-line body edit.
  - On the build-server path, each save also runs a Gradle build. One save-time build in E
    ran 94 s (daemon log 00:15:20–00:16:54); later ones were quick.
  - With autobuild off, a save re-checks only the open files.
- **Terminal Gradle builds are not the trigger.** After a one-line edit plus
  `./gradlew compileJava`, 405 watched files changed. JDT LS (B) then spent 16.6 CPU-s and
  published 748 diagnostics, about one save's worth. D spent 2.5 CPU-s.
- **Not reproduced: "unusable".** On this machine the defaults cost a few seconds per save. The
  waste is real, but it never became unusable. The user's setup adds things this probe doesn't:
  a macOS host, the VS Code UI and the pack's other extensions, cold caches, and possibly older
  versions. Next evidence to collect there: the JDT LS log, the Java build status, and VS Code's
  startup-performance and CPU-profile reports, before and after applying configuration G.

### Recommended VS Code settings for deephaven-core

```jsonc
// with the Extension Pack for Java (vscode-gradle's build server stays on, its default)
"java.autobuild.enabled": false,
"java.import.gradle.annotationProcessing.enabled": false,
"java.jdt.ls.vmargs": "-XX:+UseParallelGC -XX:GCTimeRatio=4 -XX:AdaptiveSizePolicyWeight=90 -Dsun.zip.disableMemoryMapping=true -Xmx4G -Xms100m -Xlog:disable"
```

- **vscode-java alone** (no Gradle extension) needs the init script too:
  `"java.import.gradle.arguments": "--init-script /abs/path/devc-jdtls.gradle"` (configuration
  D).
- **Cost of autobuild off:** no workspace-wide Problems list; open files are still checked as
  you type. Generated code (Immutables, protoc) updates after a Gradle build, as with IntelliJ's
  delegated builds.
- **Where the settings live.** `contributes.configurationDefaults` (VS Code docs: "override
  their defaults") would apply them to every Java project. deephaven-core gitignores `.vscode/`,
  so the choices are per-developer workspace settings, or un-ignoring and committing
  `.vscode/settings.json`, which is a team decision.

### A custom VS Code extension

Not justified for intellisense. vscode-java runs the same JDT LS every option here uses, and all
three problems were configuration. A custom client would have to make the same choices. A tiny
companion extension (settings defaults, the init script, Build/Reload commands) would only buy
zero-setup onboarding.

### Moving the fixes into deephaven-core's build (tried, not working yet)

A `buildSrc` convention plugin (`io.deephaven.java-ide-conventions`, applied from
`io.deephaven.java-common-conventions`) carried the init script's dependency and
generated-source fixes.

- Gradle's merged Eclipse classpath was correct (`eclipseClasspath` for `:engine-table` and
  `:server`: JDK container, `/Base`, `/util-annotations`).
- But JDT LS with settings only (F) still reported errors in one to three opened files:
  `java.lang.Object cannot be resolved` in `QueryTable`, and `io.deephaven.base…` unresolved in
  `SessionState`.
- The init-script version (D) had none. The difference is unexplained; with configuration G it
  isn't needed.

## Decisions and plans

Settled with the user on 2026-10-23, and carried into four plans:

- **Settings:** per project, set from devc web's **Language server settings…** and stored on
  the host in the repo's devc config directory
  (`~/.config/devc/repos/<name>-<hash>/language-servers.json`, shared by every worktree; the
  root is detected per file by the launcher and can be overridden there). Feature options are
  only container-wide defaults. (Revised 2026-10-24: a container holds several projects, so
  nothing project-specific is baked into the image. The first version put the settings in
  Feature options in the project's `devcontainer.json`.)
- **Start:** automatic on opening a file; stop after 30 idle minutes.
- **Java pre-build:** IntelliJ-style **Build (Gradle)** action, plus an automatic reload when a
  generated-source folder appears.
- **Metadata:** none written (JVM flag), so no git excludes.
- **Python interpreter:** a Feature option, then `<root>/.venv`, `$VIRTUAL_ENV`, `python3`.
- **Lint servers:** a later plan.
- **Order:** core, then TypeScript, Python, Java.

The plans:

1. [devc-web-lsp-core](../devc-web-lsp-core.md): protocol, host multiplexer, file watching,
   CodeMirror client, launcher contract
2. [devc-web-lsp-typescript](../devc-web-lsp-typescript.md): `typescript-lsp` Feature
3. [devc-web-lsp-python](../devc-web-lsp-python.md): `python-lsp` Feature
4. [devc-web-lsp-java](../devc-web-lsp-java.md): `java-lsp` Feature, Build/Reload actions,
   `jdt:` tiles

Still open, and a follow-up to the Java plan: the init script's cross-project test-class and
custom source-set fixes.

## Reproducing

[`lsp_generic.py`](devc-web-language-services/lsp_generic.py) is the TypeScript/Python probe.
It handles push and pull diagnostics and answers `workspace/configuration` from `--settings`:

```sh
lsp_generic.py --root /workspaces/web-client-ui --file packages/iris-grid/src/IrisGrid.tsx \
  --lang typescriptreact --at GridRange.boundedRanges --complete-after GridRange. \
  --plant 'const devcProbe: number = "x";' -- vtsls --stdio
```

The servers came from npm (`typescript@7.0.2`, `typescript-language-server@6.0.2`,
`@vtsls/language-server@0.3.0`, `pyright@1.1.414`, `basedpyright@1.40.2`), PyPI (`ty==0.0.91`,
`pyrefly==1.4.0`, `jedi-language-server==0.47.0`) and Deno's GitHub release (2.9.8).

Two gotchas from the runs:

- basedpyright's npm package also installs a `pyright-langserver` bin that shadows pyright's.
  Run pyright as `node node_modules/pyright/langserver.index.js --stdio`.
- Completion requested in the middle of an identifier (`pd.|__version__`) returns nothing from
  ty. [`complete_check.py`](devc-web-language-services/complete_check.py) appends a fresh
  `x = <EXPR>` line instead.

[`vscode_sim.py`](devc-web-language-services/vscode_sim.py) is the VS Code simulation:
`vscode_sim.py <label> <root> <settings.json> -- <server argv>`.

- `SIM_GRADLE=1` adds the terminal-build phase.
- `SIM_BSP=<vscode-gradle extension dir>` with `SIM_BSP_JAVA_HOME` emulates the Gradle build
  server (it starts `lib/gradle-server` and relays the importer's pipe).
- `SIM_SYSCPU=1` with `SIM_QUIET_CORES` measures whole-machine CPU.
- `GC_LOG` summarizes `-Xlog:gc`.

[`open_check.py`](devc-web-language-services/open_check.py) imports, waits `SETTLE` seconds and
prints errors in given files. Gotcha: JDT LS 1.64 reports `ServiceReady` before its
progressive import has resolved every classpath, so wait for CPU to go quiet, not for ready.

[`lsp_probe.py`](devc-web-language-services/lsp_probe.py) is the Java probe, a throwaway stdio
LSP client:
`lsp_probe.py <root> <ready-timeout-s> -- <server argv…>`. It waits for JDT LS's
`ServiceReady` (or, with `PROBE_NB=1`, for `$/progress` to go quiet), then:

- hovers, jumps to definition and completes on `QueryTable.getRowSet()`
- waits for diagnostics to settle and groups the errors by message and project

Environment variables:

- `PROBE_GRADLE_ARGS`: passed as `java.import.gradle.arguments`
- `PROBE_APT=true`: re-enables JDT LS annotation processing
- `PROBE_VALIDATE=1`: plants a type error and opens files outside the pre-built tree
- `PROBE_CP=1`: dumps `java.project.getClasspaths` for `:engine-table`
- `PROBE_AUTOBUILD=false`: turns JDT LS's own compiler off
- `PROBE_SAVE=1`: also sends `didSave`, which **hides** an unsaved planted error (kept only to
  reproduce that pitfall)

The Java plan's final configuration also needs the JVM flag
`-Djava.import.generatesMetadataFilesAtProjectRoot=false` on the server command line.
[`plant_trace.py`](devc-web-language-services/plant_trace.py) traces diagnostics for a planted
error, [`watch_check.py`](devc-web-language-services/watch_check.py) checks external-edit
detection (`NOTIFY=1` sends `didChangeWatchedFiles`), and
[`reload_check.py`](devc-web-language-services/reload_check.py) checks
`java/projectConfigurationsUpdate` after a generated folder appears.

JDT LS was launched as:

```sh
$JDK25/bin/java -Declipse.application=org.eclipse.jdt.ls.core.id1 \
  -Dosgi.bundles.defaultStartLevel=4 -Declipse.product=org.eclipse.jdt.ls.core.product \
  -Xmx6G -XX:+UseParallelGC --add-modules=ALL-SYSTEM \
  --add-opens java.base/java.util=ALL-UNNAMED --add-opens java.base/java.lang=ALL-UNNAMED \
  -jar plugins/org.eclipse.equinox.launcher_*.jar \
  -configuration <writable copy of config_linux> -data <workspace dir outside the repo>
```

The NetBeans server, from the Open VSX `Oracle.oracle-java` 27.0.0 vsix, was launched as
`extension/nbcode/bin/nbcode.sh --jdkhome $JDK25 --userdir <dir> -J-Xmx6G
--start-java-language-server=stdio`.
