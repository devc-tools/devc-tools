# devc-mount-preflight

**Repo:** `devc-tools`
**Run on:** any checkout for the code and offline tests; a host with Docker for the last
Validation item.

`devc build` (and any `up` that creates a container) can spend minutes building an image and
then fail at container create on a bind mount: a missing host source, or a mount spec Docker
rejects. Catch both **before the image build**, with no prompt, by checking at the one point in
`devcontainer up` where the answer is final: right after `initializeCommand`.

## Findings (what the investigation settled)

Order inside one `devcontainer up` (`@devcontainers/cli` 0.88.0, read from
`devc-core/node_modules/@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js`):

1. config read + variable substitution
2. **`initializeCommand`** on the host (`/bin/sh -c <string>`, an array exec'd directly, or an
   object's entries **in parallel**; `cmd.exe /c` on win32). A non-zero exit throws
   `The initializeCommand in the devcontainer.json failed.` and stops `up`.
3. find the existing container; with `--remove-existing-container` (`devc build`) **remove it**
4. build the image (Features included) — the slow part
5. create the container — **where a bad bind mount fails**

So there is no chicken-and-egg: `initializeCommand` (which is what creates mount sources — the
bundled default's `initialize-command.sh` creates every `~/.config/devc/*` source) needs no
build, and nothing between step 2 and step 5 creates host paths. A check that runs **at the end
of step 2** is exact. As a bonus it also runs before step 3, so a `devc build` that would fail no
longer destroys the working container first — today it does.

devc owns the merged config file the CLI reads (`ensureMergedConfig`, both modes), so devc can
append the check to `initializeCommand` there. Nothing in the project's own files changes, and
VS Code (which never reads the merged file) is unaffected.

A static check before `up` cannot decide missing sources (the init script may create them), which
is why the prompt-and-continue idea is not needed: the post-init check gives the exact answer, in
non-interactive callers (`devc web`, devc-desktop) too. The static check still runs before `up`,
for what it **can** decide: malformed specs.

## Checklist

- [x] Step 1: mount validator — static spec checks and source-existence check (§ Step 1)
- [x] Step 2: pre-`up` validation in `startContainer` (§ Step 2)
- [x] Step 3: post-init check appended to the merged config's `initializeCommand` (§ Step 3)
- [x] Step 4: post-failure diagnosis in `startContainer` (§ Step 4)
- [x] Step 5: docs (§ Step 5)
- [x] Tests (§ Tests)

## Which mounts are checked

The merged config's `mounts` entries (string and object form) plus `workspaceMount` when it is a
non-empty string. Not checked: Feature-declared mounts (a Feature cannot declare a bind source a
project controls — see `.plans/design/devc-feature-split.md`), the CLI's own workspace and
`--mount-git-worktree-common-dir` mounts (their sources exist by construction), and a compose
file's own `volumes`.

Parse rules (do **not** change `parseMountSpec` in `devc-core/mounts.ts` — git protection depends
on its current behavior; the validator parses entries itself):

- String form: split on `,`; each part is `key=value` or a bare flag. Keys are trimmed.
  `source` and `src` are the source; `target`, `destination`, `dst` the target; `type` defaults
  to `bind`. Unknown keys are ignored (Docker's key set grows; no false positives).
- Object form: `type` (default `bind`), `source`, `target`.
- Substitute each `source` and `target` with `substituteVars(value, CWF, localFolder)` from
  `devc-core/default_config.ts`, where `CWF` is `/workspaces/<basename of localFolder>` — used only
  so `${containerWorkspaceFolder}` in a target reads as absolute; the CLI's real value is also
  absolute.
- A field that still contains `${` after substitution (`${devcontainerId}`, a misspelt variable)
  is **skipped** by the absolute-path and existence checks — devc cannot know its value.

## Step 1: validator

A pure module, new file `devc-core/mount_check.ts`. Two functions (names at the implementer's
discretion):

**Spec problems** — returns one problem per offending entry, in config order. Reasons, exact
strings:

| Condition                                                       | Reason                                |
| --------------------------------------------------------------- | ------------------------------------- |
| entry is neither a string nor a plain object                    | `not a mount spec`                    |
| no target, or empty                                             | `no target`                           |
| target does not start with `/`                                  | `target is not an absolute path`      |
| type not one of `bind`, `volume`, `tmpfs`, `image`              | `unsupported type "<type>"`           |
| `bind` with no source, or empty                                 | `bind mount has no source`            |
| `bind` source does not start with `/`                           | `bind source is not an absolute path` |
| `tmpfs` with a source                                           | `tmpfs mount takes no source`         |
| target equals an earlier entry's target (trailing `/` stripped) | `duplicate target <target>`           |

One entry reports only its first matching reason, in table order.

**Missing sources** — for every well-formed `bind` entry whose substituted source has no `${`,
`existsSync(source)` false (follows symlinks, so a dangling link counts as missing, as it does for
Docker) → `{ source, target }` (substituted values), config order.

## Step 2: pre-`up` validation

In `startContainer` (`devc-core/container.ts`), after `opts.beforeUp` and before `runner.run`:
run the spec check on `merged.config`. Any problem → throw, with nothing run:

```
invalid mount(s) in the merged config <displayPath(merged.path)>:
  <entry>: <reason>
  <entry>: <reason>
```

`<entry>` is the string as written, or `JSON.stringify(entry)` for any other form. Missing
sources are **not** checked here (Step 3 does it, after `initializeCommand`).

## Step 3: post-init check in the merged config

In `ensureMergedConfig` (`devc-core/merged_config.ts`), after `absolutizePaths`/before writing,
rewrite `initializeCommand` on the config that is written **and** returned. Inputs: the list of
checkable bind mounts (Step 1's well-formed `bind` entries with a `${`-free source, substituted).

No rewrite (command left exactly as merged) when any of:

- that list is empty;
- `process.platform === 'win32'` (the CLI runs `cmd.exe`);
- `initializeCommand` is an object (its entries run in parallel; there is no "after all of them"
  to append to). Step 2 and Step 4 still cover these.

Otherwise the new `initializeCommand` is one **string** (the CLI runs it via `/bin/sh -c`):

```sh
<ORIGINAL>
devc_missing=0
[ -e '<source1>' ] || { printf 'devc: bind mount source does not exist: %s (target %s)\n' '<source1>' '<target1>' >&2; devc_missing=1; }
[ -e '<source2>' ] || { …same… }
[ "$devc_missing" -eq 0 ] || { printf '%s\n' 'devc: stopping before the image build - create the missing path(s) or fix the mount, then run devc again' >&2; exit 1; }
```

`<ORIGINAL>` by form:

- absent / `null` / `""` / `[]`: nothing (the check alone).
- string `S`: a subshell, so an `exit 0` inside `S` cannot skip the check, and `S`'s failure
  still stops `up` with its own status:
  ```sh
  (
  S
  ) || exit $?
  ```
- array `[a0, a1, …]`: each element shell-quoted, then `|| exit $?`:
  `'a0' 'a1' … || exit $?`.

Quoting: every literal devc inserts (`<sourceN>`, `<targetN>`, array elements) is wrapped in
single quotes with each `'` written as `'\''`. Gotcha: the CLI substitutes `${…}` variables in
the **whole** command text after devc writes it — sources and targets are already substituted
by devc, but a string/array original keeps its own `${localWorkspaceFolder}` etc. for the CLI,
exactly as today. A CLI-substituted value containing `'` inside an array element would break
the quoting; accepted (it would already be a strange path).

The rewrite is deterministic for the same inputs (same env), so `ensureMergedConfig`'s "pure
function of its inputs" note holds with the environment counted as an input — update that doc
comment to say so.

## Step 4: post-failure diagnosis

In `startContainer`, on every path that currently throws `devcontainer up failed…` (no output,
unparseable output, `outcome !== 'success'`): after `dumpBuildOutput`, run Step 1's
missing-sources check on `merged.config`. If non-empty, append to the error message:

```
devcontainer up failed: <existing text>
bind mount source(s) missing on the host:
  <source> (target <target>)
```

Empty → message unchanged. This names the cause when injection was skipped (object form, win32)
and replaces the CLI's bare `The initializeCommand in the devcontainer.json failed.` with the
reason.

## Step 5: docs

- `devc/README.md`: in the `build` bullet (~line 71), one sentence: mounts are checked before the
  image build — malformed specs before anything runs, missing bind sources right after
  `initializeCommand` — so a bad mount fails in seconds and `devc build` leaves the existing
  container in place. In the `initializeCommand` paragraph (~line 1139), note that devc appends
  its source check to the command in the merged config (not in the project's file), and that an
  object-form `initializeCommand` gets no check.
- `.plans/design/devc-design.md`: near the "Bind mounts are established when a container is
  **created**" section (~line 883), a short paragraph with the step 1–5 order from § Findings and
  where the two checks sit.

## Tests

New `devc-core/tests/mount_check_test.ts` (pure, no Docker):

- each reason in the Step 1 table, with exact strings; first-reason-only per entry;
- `src=` accepted as the source; `destination=`/`dst=` as the target;
- `${localEnv:HOME}` substituted (set `HOME` in the test); `${containerWorkspaceFolder}/x` target
  is valid; `${devcontainerId}` in a source → no absolute/existence complaint;
- `type=volume` with no source and `type=tmpfs,target=/t` are valid;
- missing-sources: existing dir, existing file, missing path, dangling symlink (missing);
- the `initializeCommand` rewrite, as strings: absent, string, array, object (unchanged), empty
  bind list (unchanged), win32 (unchanged), a source containing `'`.
- the rewritten command **run** with `/bin/sh -c` in a temp dir:
  - all sources present → exit 0, no stderr;
  - one missing → exit 1, stderr has the exact `devc: bind mount source does not exist: …` line
    and the stopping line;
  - original string `exit 0` with a missing source → still exit 1;
  - original string `exit 7` → exit 7, check output absent;
  - original string `mkdir -p '<missing>'` → exit 0 (init creating the source passes).

`devc-core/tests/merged_config_test.ts`: a project whose overlay adds a bind mount gets the
rewritten `initializeCommand` in both the written file and the returned `config`; existing
assertions on configs with bind mounts are updated to the rewritten command.

New `devc-core/tests/start_container_mount_check_test.ts`, end to end in a child process like
`connection_for_test.ts` (real merged config, real pinned CLI, temp `HOME`, stub `docker` on
`PATH` that appends its argv to a log file and answers what the CLI needs before
`initializeCommand`):

- overlay mount with a missing source → `startContainer(dir, true)` rejects; message contains
  `bind mount source(s) missing on the host:` and the path; the stub log has no `build`,
  `buildx`, `rm`, `create` or `run` invocation.
- overlay mount `type=bind,target=/x` → rejects with `invalid mount(s) in the merged config`
  and `bind mount has no source`; the stub log is empty (the CLI never ran).

## Validation

> Accepted 2026-10-26 by the user with the unchecked items below not run (marked `[x]` on acceptance): they will be tested in use and any issues re-planned.

- [x] `cd devc-core && deno task test` passes
- [x] `cd devc && deno task test` passes
- [x] `deno fmt --check` and `deno lint` pass at the repo root; `cd devc-core && deno check *.ts`
      passes
- [x] On a Docker host with an existing devc container for a project: add
      `"mounts": ["type=bind,source=/nonexistent/devc-check,target=/x"]` to the project's
      `devc.json` overlay, run `devc build`. It fails within seconds of starting, before any image
      build output, printing `devc: bind mount source does not exist: /nonexistent/devc-check
      (target /x)` and an error ending with `bind mount source(s) missing on the host:`;
      `docker ps -a` still lists the old container.
- [x] Same project, `mkdir -p /tmp/devc-check-src` and point the source there: `devc build`
      succeeds and `/x` exists in the container.
- [x] Same project, mount changed to `type=bind,target=/x`: `devc build` fails immediately with
      `invalid mount(s) in the merged config` / `bind mount has no source`, and no
      `devcontainer up` output appears.
- [x] A fresh `HOME` (no `~/.config/devc/*` dirs) with the bundled default: `devc up` succeeds —
      the bundled `initialize-command.sh` creates the sources before the check runs.

## Relevant Files

- `devc-core/mount_check.ts` (new) — validator, missing-source check, `initializeCommand` rewrite
- `devc-core/merged_config.ts` — apply the rewrite in `ensureMergedConfig`; doc comment
- `devc-core/container.ts` — pre-`up` spec check and post-failure diagnosis in `startContainer`
- `devc-core/tests/mount_check_test.ts` (new)
- `devc-core/tests/merged_config_test.ts`
- `devc-core/tests/start_container_mount_check_test.ts` (new)
- `devc/README.md`
- `.plans/design/devc-design.md`

## Out of scope

- Docker Desktop file-sharing restrictions (a source that exists but is outside the shared
  paths) — not checkable from the host side without Docker.
- Validating unknown `--mount` keys, compose `volumes`, and Feature-declared mounts.
- A standalone `devc check` command or a `--skip-mount-check` flag: the check only fails what
  Docker would fail anyway, so there is nothing to opt out of.
