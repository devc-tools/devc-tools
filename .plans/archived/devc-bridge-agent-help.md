# devc-bridge-agent-help

Three fixes found by an agent's first run of the bridge PR loop from inside a
container with no prior knowledge of the bridge:

1. **No discoverable help.** `devc-bridge --help` / `help` are forwarded to the
   host and come back `unknown command`; no-args prints only the usage line.
   `docs/bridge-git-push.md` (the agent guide) exists only on the host.
2. **`git-doctor` false negative.** It fails with `transport SSH remote, but no
   usable ssh agent` when `ssh-add -l` lists nothing, yet `git-push` succeeds
   with a passphrase-less key file under `~/.ssh` (BatchMode ssh reads it
   directly). The agent check is a proxy; test the real transport instead.
3. **Client crash on a closed pipe.** `devc-bridge pr-comments | <reader that
   exits early>` dies with an uncaught Deno `BrokenPipe` stack trace
   (`client/devc-bridge.ts` stdout write).

Out of scope: HTTPS/`gh`-credential push, `pr-request-review` (pending
org-repo testing).

## Decisions

### Client help (answered locally, never forwarded — like `version`)

| Invocation                                   | Output                                                                       | Exit |
| -------------------------------------------- | ---------------------------------------------------------------------------- | ---- |
| `devc-bridge help` / `--help` / `-h`         | overview → stdout                                                            | 0    |
| `devc-bridge` (no args)                      | overview → stderr                                                            | 2    |
| `devc-bridge help guide`                     | embedded agent guide → stdout                                                | 0    |
| `devc-bridge help <anything else>` or >1 arg | `devc-bridge: unknown help topic <t> (try: devc-bridge help guide)` → stderr | 2    |

The overview, exactly:

```text
usage: devc-bridge <command> [args...]

Runs allowlisted commands on the host. This container has no git or GitHub
credentials: pushing and PR review go through the bridge.

Built-in commands (capability in brackets, granted on the host with
`devc up --bridge-allow <caps>`):
  git-push                     publish the pinned branch; no arguments  [git-push]
  git-doctor                   show the pin and why a push would fail   [git-push]
  pr-comments                  unresolved threads on your PR, as JSON   [pr-review]
  pr-reply <thread-id> <body>  reply to a review thread                 [pr-review]
  pr-resolve <thread-id>       resolve a Copilot review thread          [pr-resolve]
  ping [label]                 keep the host awake

Answered by this client, with the bridge up or down:
  help [guide]                 this overview, or the full agent guide
  version                      client version (also --version, -V)

Other commands are whatever the host keeps in ~/.config/devc-bridge/commands/.

Start with: devc-bridge git-doctor
Full guide (output, exit codes, the PR review loop): devc-bridge help guide
```

The guide is `docs/bridge-git-push.md`, embedded at compile time with
`deno compile --include ../../docs/bridge-git-push.md` and read via
`new URL('../../docs/bridge-git-push.md', import.meta.url)` (the same mechanism
as `build_info.json`). Every compile path must include it: the `build` and
`build:release` tasks in `devc-bridge/client/deno.json` and `build-client.sh`.
`deno task run` reads it from the checkout (it already has `--allow-read`).

### Closed pipe

Every write the client makes (help, guide, forwarded stdout/stderr) swallows
`Deno.errors.BrokenPipe` for that stream and continues. A forwarded command
still exits with the script's exit code. No stack trace, no extra message.

### `git-doctor` transport check

- The `ssh agent:` section stays, **informational only — never a finding**.
  Suffix both non-listing messages with
  `(fine for a key file without a passphrase — see transport below)`, and drop
  the "SSH remotes will fail" wording.
- Per policy, replace the `is_ssh` / "no usable ssh agent" finding with a real
  probe: `git ls-remote --heads <remote> refs/heads/<branch>`, run from `/`
  with no repo, in the same environment as `git-push` (its `unset` list,
  `GIT_TERMINAL_PROMPT=0`, `GIT_SSH_COMMAND='ssh -oBatchMode=yes
  -oConnectTimeout=30'`, `GIT_ALLOW_PROTOCOL=file:ssh:https`, and the
  `-c core.askPass=` / `protocol.ext.allow=never` flags), killed by a
  process-group timeout copied from `git-push`'s `run_t`.
- Timeout: `DEVC_BRIDGE_GIT_TIMEOUT` (the knob `git-push` already honors), but
  defaulting to **30** in `git-doctor`.
- Output lines (two-space indent, `transport` column like the others):
  - success: `transport ok (git ls-remote reached <remote> non-interactively)`
  - failure (finding): `transport FAILED: git ls-remote exited <rc>: <first non-empty stderr line>` (git's trailing lines are generic boilerplate; the first carries the transport's own error),
    and for an SSH remote a second plain line
    `SSH runs with BatchMode=yes: use a key file without a passphrase, or an agent in the bridge's environment`
  - timeout (finding): `transport TIMED OUT after <n>s reaching <remote>`
- A read probe proves the credential reaches the remote, not that it may write.
  Say so in the README.

## Checklist

- [x] `devc-bridge/client/devc-bridge.ts`: local `help` / `--help` / `-h` / no-args / `help guide`; BrokenPipe-safe writes; header comment
- [x] `devc-bridge/client/deno.json` (`build`, `build:release`) and `devc-bridge/client/build-client.sh`: `--include ../../docs/bridge-git-push.md`
- [x] `devc-bridge/builtin/git-doctor`: informational agent section; `git ls-remote` transport probe with timeout; header comment
- [x] `devc-bridge/tests/git_push_test.sh`: doctor transport cases (ok, failing ssh shim, hung ssh shim)
- [x] Docs: `docs/bridge-git-push.md` (mention `devc-bridge help`; git-doctor tests the connection), `devc-bridge/README.md` (command table `git-doctor` + new `help` row, SSH bullet, `### git-doctor [key]`), `features/devc-bridge/README.md` (smoke test adds `devc-bridge help`)

## Validation

- [x] `bash devc-bridge/tests/git_push_test.sh` → `0 failed`, including new cases:
  - healthy local-path remote → exit 0, output has `transport ok`
  - `ssh://` remote with an `ssh` shim that prints `Permission denied (publickey).` and exits 255 → exit 1, output has `transport FAILED` and `Permission denied (publickey).` and `BatchMode=yes`
  - `ssh://` remote with the existing hung `ssh` shim and `DEVC_BRIDGE_GIT_TIMEOUT=2` → exit 1 within 15s, output has `transport TIMED OUT after 2s`
  - with `SSH_AUTH_SOCK` unset and a local-path remote → exit 0 (the agent is not a finding)
- [x] `bash devc-bridge/tests/pr_review_test.sh` → `0 failed`
- [x] `cd devc-bridge/client && deno task check` passes
- [x] Build the client (`deno compile` with the `build` task's flags, output to a scratch path) and, from inside a container:
  - `./devc-bridge help` → exit 0, stdout starts `usage: devc-bridge <command> [args...]`
  - `./devc-bridge` → exit 2, same text on stderr, nothing on stdout
  - `./devc-bridge help guide | head -1` → `# Pushing and PR review from inside a devcontainer (`devc-bridge`)`
  - `./devc-bridge help nope` → exit 2, stderr `devc-bridge: unknown help topic nope (try: devc-bridge help guide)`
  - `DEVC_BRIDGE_ADDR=127.0.0.1:1 ./devc-bridge help` → exit 0 (never contacts the host)
  - `./devc-bridge help guide | head -c1 >/dev/null` and `./devc-bridge pr-comments | head -c1 >/dev/null` → no `BrokenPipe` on stderr
- [x] `deno fmt --check` on the changed `.ts` and `.md` files

## Relevant Files

- `devc-bridge/client/devc-bridge.ts`
- `devc-bridge/client/deno.json`
- `devc-bridge/client/build-client.sh`
- `devc-bridge/builtin/git-doctor`
- `devc-bridge/tests/git_push_test.sh`
- `docs/bridge-git-push.md`
- `devc-bridge/README.md`
- `features/devc-bridge/README.md`
- `.plans/PLAN.md`
