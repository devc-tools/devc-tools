# Testing

Two tiers: **§A** runs entirely inside the devcontainer (no host, no GUI) and is
already automated/verified; **§B** is host-only (macOS + GUI + the devcontainer
tool) and must be run by hand.

Transport is **loopback TCP + a shared token** (a bind-mounted unix socket does
not cross the Docker Desktop VM boundary — see the README). §A exercises this
over `127.0.0.1` inside the container; §B exercises it over
`host.docker.internal`.

## §A — In-container (client + server, no host)

Proves the protocol, token auth, dispatch, allowlist, and injection-safety
without a Mac. Run from `devc-bridge/` inside the devcontainer.

```sh
# 1. Start the bridge on loopback, in the foreground (headless — `run` has no tray).
export DEVC_BRIDGE_HOST=127.0.0.1 DEVC_BRIDGE_PORT=48227
export DEVC_BRIDGE_BASE=/tmp/devc-bridge
export DEVC_BRIDGE_COMMANDS="$PWD/host/commands"
export DEVC_BRIDGE_STATE=/tmp/devc-bridge/state
export DEVC_BRIDGE_TOKEN_FILE=/tmp/devc-bridge/token
export DEVC_BRIDGE_KEEPAWAKE_IDLE_MS=1500
rm -rf /tmp/devc-bridge
deno run --allow-read --allow-write --allow-run --allow-env --allow-net host/main.ts run &

# 2. Client helper (points at the same loopback + token)
export DEVC_BRIDGE_ADDR=127.0.0.1:48227
client() { deno run --allow-read --allow-net --allow-env=DEVC_BRIDGE_ADDR,DEVC_BRIDGE_TOKEN_FILE client/devc-bridge.ts "$@"; }
```

| Check               | Command                                                         | Expected                                            |
| ------------------- | --------------------------------------------------------------- | --------------------------------------------------- |
| A1 round-trip       | `client echo hello`                                             | `echo: hello`, exit 0                               |
| A2 multi-arg        | `client echo a b c`                                             | `echo: a b c`                                       |
| A2 exit propagation | `client toggle badarg; echo $?`                                 | usage on stderr, exit `2`                           |
| A3 injection safety | `client echo '; touch /tmp/pwned; #'`                           | printed literally; `/tmp/pwned` NOT created         |
| A4 unknown command  | `client nope; echo $?`                                          | `unknown command: nope`, exit 1                     |
| A4 traversal        | `client ../core.ts; echo $?`                                    | `invalid command name`, exit 1                      |
| AUTH bad token      | `DEVC_BRIDGE_TOKEN_FILE=<file with wrong token> client echo hi` | `unauthorized`, exit 1                              |
| A5 state watcher    | `client toggle on` then `client toggle off`                     | server log shows `active: []` → `["toggle"]` → `[]` |

Cleanup: `pkill -f 'host/main.ts run'; rm -rf /tmp/devc-bridge`.

`host/main.ts`'s own automated tests (`cd host && deno task test`) cover the
lifecycle around this: the relaunch argv in both modes, and `start` spawning a
detached bridge that survives SIGHUP, logs to `devc-bridge.log`, and answers
`status`/`stop`. They need no host and no GUI either.

### §A — keepalive (`ping` builtin + idle-timeout `caffeinate`)

The real `caffeinate` script is macOS-only, so these use a stub `commands/caffeinate`
with `toggle`-style marker semantics (`start` → touch `$DEVC_BRIDGE_STATE/caffeinate`

- append `start` to an invocation log; `stop` → remove the marker + append `stop`).
  Put the log **outside** `$DEVC_BRIDGE_STATE` (e.g.
  `$(dirname "$DEVC_BRIDGE_STATE")/caffeinate-invocations.log`) — a file inside
  `state/` is read by the active-marker scan and would break A5/regression checks.
  Point `DEVC_BRIDGE_COMMANDS` at a directory with that stub (plus `echo`/`toggle`)
  instead of `host/commands` for these rows; `DEVC_BRIDGE_KEEPAWAKE_IDLE_MS=1500` in
  the setup snippet above keeps the idle window short.

| Check              | Command                                                                                     | Expected                                                              |
| ------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| K1 round-trip      | `client ping PostToolUse`                                                                   | `pong`, exit 0 — same response shape as `client echo`                 |
| K2 starts          | `client ping A`                                                                             | marker `caffeinate` appears; invocation log shows exactly one `start` |
| K3 no double-start | two more `client ping` calls while active                                                   | still exactly one `start` in the log                                  |
| K4 expiry stops    | wait ~1.5s after the last ping                                                              | marker gone; log gains one `stop`                                     |
| K5 re-arm          | `client ping` again after expiry                                                            | marker returns; log gains a second `start`                            |
| K6 ping gap reset  | ping, wait 1s, ping, wait 1s (each gap < idleMs)                                            | still active (no `stop` yet); silence afterward then stops            |
| K7 unauthorized    | `client ping` with a wrong token                                                            | `unauthorized`, exit 1; marker does NOT appear                        |
| K8 `close()` stops | keepalive armed, `kill -TERM` the server pid                                                | marker removed, log gains `stop` (proves the await, not just intent)  |
| K9 unconfigured    | a `startServer({ keepawake: undefined })` unit test — no entrypoint expresses this any more | `ping` falls through to script dispatch (`unknown command: ping`)     |

Cleanup: as above, plus remove the stub commands dir and its invocation log.

### §A — the git built-ins (`git-push`, `git-doctor`)

An offline harness with a local bare repo standing in for the remote — no
network, no bridge running, no Docker. It runs the scripts directly with the
environment the bridge would give them (`DEVC_BRIDGE_KEY`,
`DEVC_BRIDGE_POLICY_DIR`) under a throwaway `$HOME`, so it never touches your
real mirrors or policies. From the repo root:

```sh
bash devc-bridge/tests/git_push_test.sh   # → "N passed, 0 failed", exit 0
```

It covers the safety property (a planted `pre-push` hook and `core.fsmonitor`
fire under `git -C <repo>`, and none of four planted payloads fire through the
mirror), every exit-2 refusal (no policy, malformed lines, any argument, the
shared token, a remote/mirror mismatch, a redirected `commondir` or worktree
pointer), the exit-3 content policy (workflows, LFS, a `master` default), the
TOCTOU race (a `git` shim moves the branch at push time — the inspected SHA
still lands), mirror re-creation, `git-doctor`'s findings, and a hung SSH
transport killed at a 2s `DEVC_BRIDGE_GIT_TIMEOUT` with exit 4 and no process
left behind. CI runs it in `release.yml`.

That the **bridge** sets `DEVC_BRIDGE_KEY` from the caller's token, and replaces
any value inherited by the daemon, is `host/tests/keys_test.ts`;
The server-side grant check (every refusal message, revocation without a
restart, shadowing), materialization, "built-ins are never seeded" and the
removed `install-command` are `host/tests/capabilities_test.ts`.

### §A — the PR review built-ins (`pr-comments`, `pr-reply`, `pr-resolve`)

The same shape, with a `gh` shim first on `PATH` standing in for GitHub: it logs
every call (cwd and argv) and answers from fixtures the harness writes per case,
applying `--jq` with the real `jq` — so the harness needs `jq`; the scripts do
not. From the repo root:

```sh
bash devc-bridge/tests/pr_review_test.sh   # → "N passed, 0 failed", exit 0
```

It covers the byte-identical `pr-prelude` blocks, every exit-2 refusal (policy,
shared token, argument count and thread-id shape, unsupported remotes including
`..` and a port), fork-aware PR resolution (the parent's PR is found, another
fork's same-name branch is not, two matches are refused), `pr-comments`' JSON
(unresolved threads across two pages, a JSON-hostile body round-tripped,
`copilotReview` and `pending`), `pr-reply`'s body rules at the 4000-byte
boundary (bytes, not characters) with nothing sent on exit 3, `pr-resolve`'s
Copilot-only rule, that every `gh` call ran from `/` as `gh api` with container
values only in `-f` variables, and a hung `gh` killed at a 2s
`DEVC_BRIDGE_GH_TIMEOUT` with no process left behind. CI runs it in
`release.yml`.

Lint: `shellcheck -x devc-bridge/builtin/* devc-bridge/tests/*.sh`
(or `docker run --rm -v "$PWD:/mnt:ro" -w /mnt koalaman/shellcheck:stable -x …`
where it is not installed).

## §B — Host verification (macOS)

Requires Deno 2.9+ on the host (only to _build_ — the built binary needs no Deno
at all, which B4 checks). Run **in order — stop at the first failure.**

```sh
# One-time build: self-contained binary with the command scripts embedded.
cd devc-bridge/host && deno task build  # → ./devc-bridge
install devc-bridge /usr/local/bin/     # anywhere on PATH

# GATE: zero-setup start (no hand-created ~/.config) reaches the container over
# host.docker.internal?
rm -rf ~/.config/devc-bridge        # prove first-run seeding (optional; destroys existing config)
devc-bridge start                   # seeds config, writes token, backgrounds the bridge
# → reopen the devcontainer, then INSIDE it:
devc-bridge echo hello              # expect: echo: hello
```

If the gate fails, check in this order:

1. **`cannot read token /run/devc-bridge/token`** → run dir not mounted, or
   server not started. Confirm the repo-root `.devc/devc.json` mount +
   `devc-bridge status` shows `running`.
2. **`cannot connect to host.docker.internal:48227`** → the container can't
   reach host loopback. Try `DEVC_BRIDGE_HOST=0.0.0.0 devc-bridge restart` on
   the host.
3. **`unauthorized`** → stale token in the container's mount;
   `devc-bridge restart` / reopen.
4. **`unknown command: echo`** → commands not seeded; check
   `~/.config/devc-bridge/commands/` exists (it is auto-created on `start`).

| Check                 | Where     | Command                                                                                                                                                                                                                                            | Expected                                                                                                                                                                                                                    |
| --------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B0 zero-setup         | host      | `rm -rf ~/.config/devc-bridge && devc-bridge start`                                                                                                                                                                                                | `started (pid N)`; `~/.config/devc-bridge/{run,state,commands}` + token created; `commands/` has `echo`/`caffeinate`/`toggle`                                                                                               |
| B0 idempotent         | host      | `devc-bridge start` again                                                                                                                                                                                                                          | `already running (pid N)`                                                                                                                                                                                                   |
| B0 status/stop        | host      | `devc-bridge status` then `devc-bridge stop`                                                                                                                                                                                                       | `running (pid N)` — idle → `stopped` (exit 1)                                                                                                                                                                               |
| B1 gate               | container | `devc-bridge echo hello`                                                                                                                                                                                                                           | `echo: hello`                                                                                                                                                                                                               |
| B2 caffeinate start   | container | `devc-bridge caffeinate start`                                                                                                                                                                                                                     | `started`                                                                                                                                                                                                                   |
| B2 assertion          | host      | `pmset -g assertions \| grep -i caffeinate`                                                                                                                                                                                                        | assertion present                                                                                                                                                                                                           |
| B2 status             | container | `devc-bridge caffeinate status`                                                                                                                                                                                                                    | `running`                                                                                                                                                                                                                   |
| B2 stop               | container | `devc-bridge caffeinate stop`                                                                                                                                                                                                                      | `stopped`, assertion gone                                                                                                                                                                                                   |
| B3 detached           | host      | `devc-bridge start`, then close the terminal window                                                                                                                                                                                                | `devc-bridge status` from a new terminal still reports `running` (SIGHUP ignored, output still going to `devc-bridge.log`)                                                                                                  |
| B4 no deno needed     | host      | `env PATH=/usr/bin:/bin devc-bridge start` with the **compiled** binary                                                                                                                                                                            | `started (pid N)` — nothing is built, nothing shells out to `deno`                                                                                                                                                          |
| B5 real caffeinate    | container | `devc-bridge ping PostToolUse`                                                                                                                                                                                                                     | `pmset -g assertions` (host) shows the caffeinate assertion; `devc-bridge status` → `active: caffeinate`                                                                                                                    |
| B6 idle stop          | host      | stop pinging, wait ~5 min (default idle timeout)                                                                                                                                                                                                   | assertion and marker gone; `devc-bridge status` back to `idle`                                                                                                                                                              |
| B7 stop while armed   | host      | `devc-bridge stop` mid-keepalive                                                                                                                                                                                                                   | `pmset -g assertions` no longer shows caffeinate (no leak — `close()` awaits the stop)                                                                                                                                      |
| B8 status unchanged   | container | `devc-bridge status` while armed                                                                                                                                                                                                                   | still reports `— active: caffeinate` (unchanged code path — confirms nothing regressed)                                                                                                                                     |
| B9 real hook          | container | install the README's `PreToolUse`/`PostToolUse`/`UserPromptSubmit` hook snippet in `settings.json`, run a short Claude session                                                                                                                     | assertion appears on the first tool call; clears ~5 min after the session goes quiet                                                                                                                                        |
| B10 env inherited     | host      | `DEVC_BRIDGE_KEEPAWAKE_IDLE_MS=600000 devc-bridge restart`                                                                                                                                                                                         | `devc-bridge.log` shows `keepawake: caffeinate (idleMs: 600000)`; idle stop now takes 10 min. **No `settings.json` is written**                                                                                             |
| B10 not sticky        | host      | `devc-bridge restart` again with the var unset                                                                                                                                                                                                     | back to `idleMs: 300000` — the environment is the only source, so nothing persists                                                                                                                                          |
| B10 needs restart     | host      | `DEVC_BRIDGE_KEEPAWAKE_IDLE_MS=900000 devc-bridge start` while running                                                                                                                                                                             | `already running (pid N)`; the value does **not** apply until `restart`                                                                                                                                                     |
| B11 flags             | host      | `pmset -g assertions` while armed                                                                                                                                                                                                                  | `PreventUserIdleSystemSleep` held; **no** `UserIsActive` (confirms `-dims`, no `-u`)                                                                                                                                        |
| B12 orphaned bridge   | host      | while running: `rm -rf ~/.config/devc-bridge && devc-bridge start`                                                                                                                                                                                 | `48227 is already in use, but no devc-bridge pidfile exists` + the `lsof` hint, exit 1 — _not_ the 30s ready timeout                                                                                                        |
| B12 no false alarm    | host      | `devc-bridge stop` then `devc-bridge start`                                                                                                                                                                                                        | starts normally (a just-released port must not read as still in use)                                                                                                                                                        |
| B13 tray (opt-in)     | host      | `cd devc-bridge/host && deno task dev`                                                                                                                                                                                                             | menu bar shows ○→● as markers appear/clear; "Quit" exits. Nothing else in this table needs it                                                                                                                               |
| B14 git-push live     | container | `devc up --bridge-allow git-push` on a throwaway branch, bridge started with `devc-bridge start` from a shell with an ssh agent, then close that terminal; in the container `devc-bridge git-push`                                                 | `pushed: <branch> at <sha> to git@github.com:…`; the GitHub branch is at that SHA. A second call prints `up to date`                                                                                                        |
| B15 git-push hang     | host      | point a policy at `ssh://<a host that accepts TCP but never answers>/x.git` and run `DEVC_BRIDGE_GIT_TIMEOUT=10 devc-bridge restart`, then `devc-bridge git-push` from the container                                                               | exit `4`, `timed out after 10s`, within ~15s — the client does not hang                                                                                                                                                     |
| B16 pr-comments live  | container | `devc up --bridge-allow git-push,pr-review,pr-resolve` on a throwaway branch with an open PR Copilot has reviewed; in the container `devc-bridge pr-comments`                                                                                      | JSON naming that PR; Copilot's threads carry `"copilot": true`. If they read `false`, the GraphQL bot login is not `copilot-pull-request-reviewer` — fix `COPILOT_LOGIN` in all three scripts                               |
| B17 reply + resolve   | container | `devc-bridge pr-reply <copilot thread> 'test'`, `pr-resolve` on it, then `pr-resolve` on a thread you started                                                                                                                                      | the reply shows on GitHub as `🤖 test`; the Copilot thread is resolved; yours is exit 3                                                                                                                                     |
| B18 fork PR           | container | as B16–B17, but the pinned remote is your fork and the PR targets an upstream you cannot write to                                                                                                                                                  | same results — the PR is found in the parent, and the author may reply and resolve there                                                                                                                                    |
| B19 review after push | container | on the B16 PR, `git-push` a fix, then poll `pr-comments`                                                                                                                                                                                           | `copilotReview.pending` goes `true` while Copilot reviews, then `false` with `commit` equal to `pr.headSha`. If `pending` never goes `true`, REST does not list the bot as a requested reviewer — change the `pending` rule |
| B20 grants live       | container | `devc-bridge restart` on the upgraded binary; `devc up --bridge-allow git-push` a throwaway branch; in the container `devc-bridge pr-comments`, then `devc-bridge git-push`; then `devc up` (no flag) on the host and `devc-bridge git-push` again | `pr-comments`: exit 1, `needs capability pr-review, which this container was not granted (it has: git-push)`. `git-push`: B14's output. After the flagless `up`: exit 1, `no capabilities granted`, with no bridge restart  |

### Notes / gotchas

- **Transport:** a bind-mounted unix socket is refused across the Docker Desktop
  boundary (`ECONNREFUSED` in the container while a host-local `nc -U` works).
  We use loopback TCP via `host.docker.internal` instead; a token file (carried
  over the same mount, since regular files cross fine) authorizes requests.
- **Permissions:** unix/TCP `listen`/`connect` need **`--allow-net`**, not
  `--allow-read/write`. The client also needs `--allow-read` (token file) and
  `--allow-env=DEVC_BRIDGE_ADDR,DEVC_BRIDGE_TOKEN_FILE`. All baked into the
  `deno.json` tasks.
- **A compiled binary runs from a virtual temp dir**, so paths relative to
  `import.meta.url` point into the bundle, not the CWD. Command scripts are
  embedded via `deno compile --include commands` and read back through
  `new URL("./commands", import.meta.url)` in `host/config.ts`, then **seeded**
  to the editable `~/.config/devc-bridge/commands` on first `start` (never
  overwritten thereafter). Tray icons are embedded (base64) in `host/tray.ts`
  for the same reason.
- **That virtual path is also why `start` cannot shell out to the source tree.**
  A compiled binary's `Deno.mainModule` is `file:///tmp/deno-compile-*/main.ts`,
  which it can stat itself but no child process can reach — so the relaunch argv
  keys off `Deno.build.standalone`, never a path probe.
