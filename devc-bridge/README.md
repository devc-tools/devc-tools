# devc-bridge

A tiny bridge that lets a **devcontainer** invoke allowlisted commands on the
**host** — so, for example, Claude Code hooks running inside a container can
`caffeinate` the host Mac while a session is active.

It runs **headless**: `devc-bridge start` backgrounds a plain daemon, and
`devc-bridge status` is how you ask whether anything is currently active (e.g.
the Mac is being kept awake) vs. idle. A macOS menu-bar icon showing the same
thing is available as an opt-in extra when you run it from source — see
[The menu-bar tray](#the-menu-bar-tray-opt-in-from-source).

```
Host (macOS)                                             Devcontainer
──────────────────────────────────────────────           ────────────────────────────
devc-bridge start   (detached background process)
  ├─ TCP 127.0.0.1:48227 ◄── host.docker.internal ────── devc-bridge <name> [args…]
  │      (token-authorized)                           │  reads token from
  ├─ runs ~/.config/devc-bridge/commands/<name>       │  /run/devc-bridge/token
  │      (args as argv, never a shell string)         ▲  (bind mount)
  ├─ writes token → ~/.config/devc-bridge/run/token ──┤  (shared; non-devc mounts)
  ├─ mints token  → ~/.config/devc-bridge/keys/<key>/token ┘  (one per devc workspace)
  ├─ watches ~/.config/devc-bridge/keys/ and state/
  └─ devc-bridge status → idle | active: caffeinate
```

## Commands

Two separate command surfaces share the `devc-bridge` name — one you run on
the **host** to manage the background service, one you run **inside the
container** to invoke an allowlisted host script.

### Host — manage the background service

Run these on the host, outside any container:

| Command                              | Does                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `devc-bridge start`                  | Seed `~/.config/devc-bridge/` on first run, then run the bridge in the background                                                          |
| `devc-bridge status`                 | `running (pid N)` — idle \| active: … — or `stopped`, plus a `client:` line                                                                |
| `devc-bridge stop`                   | Stop the background bridge                                                                                                                 |
| `devc-bridge restart`                | `stop` + `start`                                                                                                                           |
| `devc-bridge run`                    | Run it in the foreground instead (Ctrl-C to quit) — how you watch it work                                                                  |
| `devc-bridge run --tray`             | Ditto, plus the menu-bar icon; needs a `deno desktop` runtime (see below)                                                                  |
| `devc-bridge version`                | Print the version (also `--version` / `-V`) — which host binary is this                                                                    |
| `devc-bridge install-command <name>` | Enable a **recipe** — an unseeded command such as `git-push` — by copying it into `commands/`; never overwrites. No name lists the recipes |

`start` runs **this same program** with the `run` subcommand as a detached child
— no bundle, no build step, and no `deno` on `PATH`. It inherits your shell's
environment, so `DEVC_BRIDGE_*` variables set on the command line reach the
daemon.

### Container — invoke a host command

Run these inside the devcontainer, as `devc-bridge <command> [args...]`. Out
of the box:

| Command                          | Does                                                                                                                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ping [label]`                   | **The normal way to keep the host awake.** Reserved builtin — records activity and starts/stops `caffeinate` for you on an idle timeout. Wire it into hooks per [Wiring into Claude Code hooks](#wiring-into-claude-code-hooks) and forget it exists. |
| `caffeinate start\|stop\|status` | The keepalive's own on/off switch, exposed directly (macOS-only; runs the real `caffeinate(8)`). Manual/advanced use only — see below.                                                                                                                |
| `echo <args...>`                 | Round-trip smoke test — echoes args back                                                                                                                                                                                                              |
| `toggle on\|off`                 | Demo command that flips a state marker (exercises `status`/the tray without needing macOS)                                                                                                                                                            |
| `git-push`                       | **Recipe — absent until installed.** Publish this container's one pinned branch to its pinned remote. Takes no arguments. See [Publishing a branch](#publishing-a-branch-git-push)                                                                    |
| `git-doctor`                     | **Recipe — absent until installed.** Explain why `git-push` would or would not work: ssh agent, the pin, the mirror, worktree pointers. Changes nothing                                                                                               |
| `pr-comments`                    | **Recipe — absent until installed.** The unresolved review threads on this container's PR, as JSON, plus Copilot's latest reviewed commit. Takes no arguments. See [Iterating on PR review](#iterating-on-pr-review-pr-)                              |
| `pr-reply <thread> <body>`       | **Recipe — absent until installed.** Reply to any review thread on that PR, prefixed `🤖`                                                                                                                                                             |
| `pr-resolve <thread>`            | **Recipe — absent until installed.** Resolve a review thread on that PR — only one Copilot started                                                                                                                                                    |
| `version`                        | **Answered by the client itself**, never sent to the host (also `--version` / `-V`) — which client is actually mounted in here, answerable with the bridge down                                                                                       |

**In normal use you never call `caffeinate` yourself** — `ping` drives it
automatically once it's wired into hooks. Reach for `caffeinate start`/`stop`/
`status` directly only to force the Mac awake outside of any hook activity, or
to debug/inspect state by hand. See [Wiring into Claude Code hooks](#wiring-into-claude-code-hooks)
for how the two interact (adoption, manual-stop-wins, etc.).

These are plain executable scripts in `~/.config/devc-bridge/commands/`
(seeded from `host/commands/` on first `start`, yours to edit) — `ping` is the
one exception, a builtin handled by the server itself, not a script. See
[Writing a command](#writing-a-command) to add your own.

**Recipes are the exception to seeding.** `recipes/` holds commands that are
embedded in the binary but **never** seeded, because a seeded file is a capability
every container gets on first start. `devc-bridge install-command <name>` copies
one into `commands/` (mode 755) on purpose, and refuses if a file of that name is
already there. Removing the capability again is `rm` of that copy.

> **Seeding never clobbers.** A script that already exists in
> `~/.config/devc-bridge/commands/` is left alone on every later `start`, so
> changes to `host/commands/` do **not** reach an existing install — edit the
> copy under `~/.config/devc-bridge/commands/`, or delete it and restart to
> re-seed.

### Why `caffeinate -dims`

`-i` is what actually keeps a session alive: no idle system sleep means the CPU
keeps running, Wi-Fi stays associated, and a VPN tunnel survives. `-d` is kept
because a display that never sleeps generally never triggers the display-sleep
screen lock, which some VPN clients drop on. `-s` is documented as valid only on
AC power, so on battery `-i` carries the load; `-m` is near-inert on SSD-only
Macs. Both are harmless.

`-u` is deliberately **not** used. It declares user activity and _wakes the
display if it's off_ — the keepalive arms on a session's first hook ping, so
`-u` would light up a screen you had let sleep. It is also redundant with `-d`,
and with no `-t` its assertion defaults to 5 seconds.

No flag combination survives closing the lid: clamshell sleep needs external
power _and_ an external display to avoid. Verify what is held with
`pmset -g assertions | grep -i caffeinate`.

## Setup (macOS host)

```sh
# 1. Install. Puts the host `devc-bridge` in ~/.local/bin, plus a copy of the Linux
#    *container client* in ~/.config/devc-bridge/client/ (a developer override —
#    containers get their own from the Feature). No Deno, no sudo.
curl -fsSL https://github.com/devc-tools/devc-tools/releases/latest/download/install.sh | sh

# 2. Start it in the background. First run auto-creates ~/.config/devc-bridge/ (run/,
#    keys/, state/, commands/, client/), seeds the example command scripts, and writes the
#    shared token. This is also what creates the run/ dir a non-devc devcontainer.json
#    bind-mounts; devc creates its own per-workspace keys/<key>/ dirs.
devc-bridge start                   # -> started (pid N)
devc-bridge status                  # -> running (pid N) — idle / client override: none

# 3. Add the Feature *and* the token mount to a repo's devcontainer.json, then bring it
#    up. See ../features/devc-bridge/README.md for the two lines.
```

`--version` on either binary reports which one you have — including from inside
a container, which is how you tell which client a container actually got.

The installer places **both** `devc-bridge` binaries, which are two different
programs sharing a name: the host CLI on your `PATH`, and the container client
at `~/.config/devc-bridge/client/devc-bridge`. See
[The container client](#the-container-client) for why that path matters and
[the repo README](../README.md#install) for the installer's env knobs. The host
CLI is **macOS-only** — every command it ships is macOS (`caffeinate`) — so on
Linux the installer places only the client.

(See [Commands](#commands) above for the full `start`/`stop`/`status`/`restart`
lifecycle CLI.)

### From a clone instead

Requires Deno 2.9+. Either build the binary:

```sh
cd devc-bridge/host && deno task build  # → ./devc-bridge (command scripts embedded)
install devc-bridge /usr/local/bin/     # or move it anywhere on your PATH
cd ../client && deno task build:client  # the container client, to the same dir the installer uses
```

…or skip the build entirely and source the repo's shell integration — it defines
a `devc-bridge` function that runs `host/main.ts` from source via Deno:

```sh
source /path/to/devc-tools/scripts/bash_aliases.sh   # add this to ~/.bashrc
```

All three are the same to `start`: it relaunches whichever of them you invoked,
with the `run` subcommand, as a detached background process. There is nothing to
build at start time and no `.app` bundle involved.

Command scripts are seeded to `~/.config/devc-bridge/commands/` on first start
and are **yours to edit** — later starts never overwrite them. To pick up new
example scripts from a rebuilt binary, add them there yourself (or delete the
ones you want re-seeded). To watch the bridge work, run it in the foreground
with `devc-bridge run` instead of `start`.

## The menu-bar tray (opt-in, from source)

A macOS menu-bar icon (Deno 2.9+ `Deno.Tray`) can show the same idle ○ /
active ● state `devc-bridge status` reports. It is **not** how the bridge runs
and it is **not** part of what gets built or installed:

```sh
cd devc-bridge/host && deno task dev    # deno desktop, foreground, with the tray
```

`deno task dev` is `deno desktop … main.ts run --tray`; `--tray` is the only way
to reach it. Everything else — `start`, a compiled binary, a plain
`devc-bridge run` — is headless, and the tray layer degrades to headless
silently when no `Deno.Tray` exists.

Shipping a tray artifact is deliberately out of scope: bundling one pulls in
`deno desktop`, `iconutil` (which cannot cross-build) and code signing, none of
which should gate a headless daemon. Losing the icon by default is an accepted
trade — `devc-bridge status` answers "is it working" without a GUI at all, which
the icon never could from a script.

## The container client

The container half is a **devcontainer Feature**, so there is no per-repo
wiring to copy and nothing devc-specific about it. Any project opts in with one
line:

```jsonc
"features": {
  "ghcr.io/devc-tools/features/devc-bridge:0": {}
}
```

…plus the token mount, which is **yours to declare** and not the Feature's (devc
projects get a per-workspace one contributed instead — see below):

```jsonc
"mounts": [
  "type=bind,source=${localEnv:HOME}/.config/devc-bridge/run,target=/run/devc-bridge,readonly"
]
```

The Feature itself declares no mounts at all. It downloads the Linux client for
the container's architecture from the matching release, verifies it against the
release `checksums.txt`, and symlinks `/usr/local/bin/devc-bridge` at it. No env
vars are needed either — `DEVC_BRIDGE_ADDR` and `DEVC_BRIDGE_TOKEN_FILE` default
to exactly the address and mount target above (see [Commands](#commands)); set
them only to override.

The mount lives in your `devcontainer.json` because a Feature **cannot** express
`readonly` — its schema's `Mount` has no such field — whereas a string mount in
`devcontainer.json` is in the published schema and defers to Docker's own
`--mount` syntax. See [its README](../features/devc-bridge/README.md) for the
full rationale, including the Docker Compose caveat.

[devc](../devc/README.md#devc-bridge-the-opt-in-feature) projects opt in the same way,
with `features` in a devc.json — the bridge is not part of devc's
baseline, so a devc container comes up on a host that never heard of it. One
mechanism, not two. What differs is the mount: devc contributes
`…/devc-bridge/keys/<key>` instead of `…/devc-bridge/run`, one directory per
workspace, so each devc container gets **its own token** — see
[Per-container tokens](#per-container-tokens).

**Install the host bridge before adding the `run/` mount.** Nothing in the
container can create `~/.config/devc-bridge/run`: a Feature has no host-side
hook, and `--mount type=bind` errors on a missing source rather than creating
it. So a project that declares the mount on a host with no
`~/.config/devc-bridge/` fails to build. Run `devc-bridge start` once first.
(devc creates its `keys/<key>/` source itself, so a devc project has no such
prerequisite.)

**The client is downloaded by the Feature, not built on the fly and not taken
from the host.** `devc-bridge start` never compiles one, and what sits in
`~/.config/devc-bridge/client/devc-bridge` no longer reaches any container by
itself — it is a _developer override_, used only when a project bind-mounts that
directory over `/usr/local/share/devc-bridge/client`. Two paths write to it:

| Path         | How                                                                                 |
| ------------ | ----------------------------------------------------------------------------------- |
| Typical user | `install.sh` drops the prebuilt Linux client there (see [Setup](#setup-macos-host)) |
| Developer    | `cd client && deno task build:client` cross-compiles to the same path               |

Both honor `DEVC_BRIDGE_CLIENT_DIR` if you need the destination somewhere else.

Both **overwrite unconditionally** — note the asymmetry with
`~/.config/devc-bridge/commands/`, which is yours to edit and is never
clobbered. The binary is not user-owned: it is a build artifact with a fixed
name, and a stale one is a bug rather than a customization.

The client's target follows the **host** arch (`arm64` →
`aarch64-unknown-linux-gnu`, `x86_64` → `x86_64-unknown-linux-gnu`), since
Docker Desktop runs containers matching the host by default — so an arm64 Mac
gets a Linux **arm64** client, not a darwin one. Both paths above make the same
choice from the same `uname -m`. A container deliberately run under emulation on
the other arch is out of scope — rebuild with `DEVC_BRIDGE_CLIENT_TARGET` set if
you need that (`deno task build:client` only), or fetch the other archive by
hand.

Because the mount is a live _directory_ mount and the symlink is made
unconditionally, installing the client while a container is already running is
enough: the link resolves on the next invocation, with no rebuild and nothing to
re-run inside. Until then, devc's placeholder makes the gap legible — the
container prints `devc-bridge: no client binary …` and exits 127, and
`devc-bridge status` on the host reports `client: not installed (placeholder)`.
(A standalone Feature project never reaches that state: with no placeholder to
mount, it fails at create instead.)

> **Upgrading from per-repo wiring:** if you previously added the run-dir mount
> to a `devc.json` overlay, copied the two bridge mounts into a project's
> `devcontainer.json`, or installed the client from a
> `.devc/devc-post-create.sh`, **remove all of it**. Mounts colliding with the
> Feature's are not deduped and Docker fails the create with
> `Duplicate mount point`.

### Developing the client

Work on `client/devc-bridge.ts` through `deno task build:client` (or run the
host side from source via `source scripts/bash_aliases.sh`). A compiled host
binary has **no connection to the working tree**: once the container's client
comes from the mount, editing the source and restarting silently keeps running
the previously built client. That is the same rule the host binary follows —
`start` never rebuilds anything — and keeps one answer to "where did this binary
come from".

Port and bind host are configurable via `DEVC_BRIDGE_PORT` (default `48227`) and
`DEVC_BRIDGE_HOST` (default `127.0.0.1`); if `host.docker.internal` can't reach
loopback in your setup, set `DEVC_BRIDGE_HOST=0.0.0.0` (the token still guards
access).

Verify the container can reach the bridge: `devc-bridge ping test` should
print `pong` (see [Commands](#commands) for the rest of the container CLI).

## Wiring into Claude Code hooks

The bridge keeps the host awake **activity-driven**: a hook fires on every tool
call and pings the bridge — "Claude is still working" — and the host starts
`caffeinate` on the first ping and stops it after a period of silence. Example
`settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "devc-bridge ping PreToolUse >/dev/null 2>&1 || true"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "devc-bridge ping PostToolUse >/dev/null 2>&1 || true"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "devc-bridge ping UserPromptSubmit >/dev/null 2>&1 || true"
          }
        ]
      }
    ]
  }
}
```

The `|| true` + redirection are load-bearing: a down/unreachable bridge must
never fail the hook or leak noise into Claude's transcript.

The `ping` builtin (see [Commands](#commands)) is intercepted server-side
before script dispatch and returns `pong` immediately, without blocking on the
`caffeinate` dispatch — so hook latency is unaffected. `args[0]`, when
present, is a free-form diagnostic label (e.g. the hook event name); it never
affects the keepalive's behavior.

Keepalive policy — when to start/stop `caffeinate` — is controlled by two env
vars on the **host**:

| Env var                         | Default      | Notes                          |
| ------------------------------- | ------------ | ------------------------------ |
| `DEVC_BRIDGE_KEEPAWAKE_COMMAND` | `caffeinate` | resolved through the allowlist |
| `DEVC_BRIDGE_KEEPAWAKE_IDLE_MS` | `300000`     | non-numeric/≤0 → default       |

**Set these on `devc-bridge start`, and restart to apply:**

```sh
DEVC_BRIDGE_KEEPAWAKE_IDLE_MS=1200000 devc-bridge restart   # 20 min, for long builds
DEVC_BRIDGE_KEEPAWAKE_IDLE_MS= devc-bridge restart          # empty = back to the default
```

The **environment is the only source**: `start` spawns the daemon as a plain child
of your shell, so it inherits whatever you set on that command line. There is no
settings file (a leftover `~/.config/devc-bridge/settings.json` from an older
version is ignored and can be deleted). Config is read once at launch, so changing
a value means `restart`, not `start` — a plain `start` against a running bridge
reports `already running` and leaves it alone. The same applies to
`DEVC_BRIDGE_HOST` and `DEVC_BRIDGE_PORT`.

**Choosing a value.** The timeout never governs typical commands — every tool call
pings, so the timer resets constantly while a session is active. It only matters in
two moments: a _single_ tool call longer than the timeout (Claude Code caps `Bash` at
10 minutes, so the default covers everything short of a long build), and how long the
Mac stays awake after work stops. Raise it on days you run long builds; the cost is
only idle awake time.

Notes on the semantics:

- **Adoption:** a manual `devc-bridge caffeinate start` with no pings is never
  auto-stopped by the keepalive; the _first_ ping arms the keepalive and hands
  it the lifecycle from then on (`start` is idempotent).
- **Manual stop wins until expiry:** if you run `devc-bridge caffeinate stop`
  while the keepalive is armed, it doesn't fight you — it stays armed until the
  timer expires, then issues a redundant (harmless) `stop`. A manual stop is an
  instruction, and its effect lasting up to the idle timeout is the intended
  reading of it.
- **Timeout guidance:** a hook ping cannot cover the duration of a single tool
  call — a long-running tool fires no pings between its start and its end, and
  a permission prompt fires none at all while Claude waits on the human. The
  idle timeout must exceed the longest plausible **gap between pings** (long
  tool runs, prompt think-time), not just "how fast to notice Claude
  finished." The default (5 minutes) is chosen with that in mind; the cost of
  raising it is a few extra minutes of the Mac staying awake, the cost of
  lowering it too far is the Mac suspending mid-build. See "Choosing a value"
  above for how to change it.
- **Why `PreToolUse` too:** it puts a ping at the _start_ of a tool call, so a
  long build gets the full idle timeout measured from when it began rather than
  from the end of the previous tool. `PostToolUse` alone very nearly does this
  (tools run back to back), but `PreToolUse` makes it exact and costs one extra
  process per tool call.
- **Subagents are covered:** hooks also run inside subagents, so a long `Agent`
  or `Workflow` call pings throughout from its own tool calls rather than going
  silent for its whole duration.
- **A stalled session is safe to let sleep.** Waiting on a permission prompt
  fires no pings, so the Mac may suspend — but the session is already stopped,
  and answering after a wake resumes it no differently. The case worth
  protecting is Claude _actively working_, which the tool-call pings cover.
- **Concurrent sessions** share one keepalive: last-ping-wins is a natural
  refcount — `caffeinate` stops only once _all_ sessions go quiet.
- **Crash robustness:** a container stop or killed session never sends
  `SessionEnd`; because the idle timeout is self-healing, nothing needs to
  explicitly stop `caffeinate`.

An explicit `SessionStart → devc-bridge caffeinate start` hook may still be
layered on for instant-on awake at session start; a `SessionEnd → stop` hook
should be **removed** — the idle timeout is the backstop that makes it
unnecessary (and if you have two sessions sharing the host, the first
session's `SessionEnd` would otherwise kill caffeinate out from under the
second).

## How it works

- **Server** (`devc-bridge`, a single binary compiled from `host/main.ts`)
  listens on loopback TCP and watches a state directory. `devc-bridge start`
  re-runs that same program as `devc-bridge run`, detached, with its output
  appended to `~/.config/devc-bridge/devc-bridge.log`; `stop`/`status`/`restart`
  manage it through the pidfile. `host/core.ts` holds all the
  transport/dispatch logic, `host/config.ts` resolves paths + seeds the command
  scripts on first start, and `host/tray.ts` is the opt-in menu-bar front-end on
  the same core (`run --tray`), which runs as a menu-bar-only accessory app —
  no dock icon and no window.
- **Client** (`client/devc-bridge.ts`, compiled to `devc-bridge`) runs in the
  container, reads the token, sends one JSON request, prints the script's
  output, and exits with its exit code.
- **Commands** are executable files in `~/.config/devc-bridge/commands/` (seeded
  from `host/commands/`). **The filename is the allowlist** — the container can
  only invoke names that exist there, and it cannot read or edit the scripts
  (they are not mounted).

Protocol (newline-delimited JSON):

```
→ {"token":"…","command":"caffeinate","args":["start"]}
← {"ok":true,"exitCode":0,"stdout":"started\n","stderr":""}
← {"ok":false,"error":"unknown command: foo"}
← {"ok":false,"error":"unauthorized"}
```

### Why TCP and not a bind-mounted unix socket?

A bind-mounted AF_UNIX socket **does not cross the Docker Desktop VM boundary**:
the container sees the socket inode but `connect()` is refused, because a unix
socket needs both endpoints in the same kernel and the mount only shares the
inode. So the server listens on host loopback TCP, and the container reaches it
via `host.docker.internal`. A **shared token** — written by the server into the
bind-mounted run dir (regular files _do_ cross the mount) and read by the client
— authorizes requests, so the loopback port isn't open to every process on the
box. (On OrbStack, unix-over-mount reportedly works; we target Docker Desktop.)

Testing steps (in-container §A + host §B) live in
[`docs/testing.md`](docs/testing.md).

## Security / trust boundary

⚠️ This is a **deliberate hole in container isolation**. Anything running in the
container can invoke any script in `host/commands/`, which runs on the host with
your user's privileges. Treat those scripts as the security surface: keep them
few, simple, and reviewed. Injection is not a concern for _arguments_ — they are
passed as `argv`, never interpolated into a shell — but a malicious or buggy
script is still a malicious or buggy script running on your host.

The bridge listens on host **loopback** TCP and requires a **token**: the shared
one in `~/.config/devc-bridge/run/token`, or a devc workspace's own in
`keys/<key>/token`, each reaching a container through a bind mount. This keeps
containers that mount neither from invoking commands, but anything that can
read a token file — i.e. anything with access to your home dir — can. It is a
convenience boundary for a single-user machine, not a hardened multi-tenant
control.

**Only one thing is mounted now — the token — and the host no longer assumes it
is read-only.**

The client used to be mounted too, read-only, so that one container could not
rewrite the binary every other container executes. It is now downloaded into each
image instead: there is no shared host artifact left to rewrite, which is a
stronger answer than a mount flag and does not depend on undocumented CLI
behavior.

`run/` still crosses as a mount, because the token is a runtime secret. Declaring
it `readonly` is worth doing and the docs say so — but the bridge does not _rely_
on it, because the consumer owns that mount and Docker Compose drops `readonly`
regardless. Two host-side properties carry the weight instead:

- **The token is regenerated on every `start`, never adopted.** `resetToken`
  replaces whatever is in the file. Adoption was the one way a writable `run/`
  became an escalation — a container could pin a secret of its choosing and have
  the next start take it up, handing access to something never given the mount.
  Costless to drop: the client re-reads the token on every invocation, so running
  containers pick up a new one with nothing restarted.
- **The token is never written through a symlink.** A container that can write
  the directory can replace `token` with a link to any host path, and a plain
  write would follow it and overwrite that file. Every write goes to a temp file
  in the same directory and is renamed into place, which replaces the link
  instead of following it (and is atomic, so no client reads a half-written
  token).

The **pidfile lives in `base/`, not in the mounted `run/`** — `stop` reads it and
`Deno.kill`s whatever positive integer it finds, so a container able to write it
could pick the host process that gets SIGTERM. That placement is now the _only_
thing closing it, rather than a second layer behind `readonly`: never move a file
the host acts on into `run/`.

The residual, accepted: a writable `run/` is a shared directory between the
containers that mount it. The bridge's real boundary is the command allowlist.

> Pre-release change with no migration: the pidfile moved from
> `run/tray.pid` to `tray.pid` (the name is unchanged, and still what a tray
> writes). A bridge started before the move writes the old path, so a post-move
> `stop` reports `not running` and leaves it orphaned — kill it by hand once.

Containers that mount `run/` share its token, so one's bridge access is not
isolated from another's. That is the same single-user convenience boundary as
above, stated at container scope — and the reason devc containers do not mount
`run/` at all.

### Per-container tokens

devc gives every workspace its own directory, `~/.config/devc-bridge/keys/<key>/`,
bind-mounted read-only as that container's `/run/devc-bridge`. devc creates it,
empty; the bridge **mints** a token into every key directory it finds — all of
them on start, and any created later (it watches `keys/`) — with the same
generate-never-adopt, rename-never-follow write as the shared token. A token the
bridge did not mint identifies nobody, and removing a key directory (`devc down`)
revokes its token at once. A symlinked entry in `keys/` is skipped, not minted
into.

Each token **identifies** its caller as that workspace's key. That is what a
publishing verb needs: `~/.config/devc-bridge/policy/<key>.conf`, written by
devc, pins the one repo, remote and branch that container may push —
**one container, one repo, one branch**, and a bind mount is not a grant. The
policy lives outside every mounted directory, because a policy the container
could write is not a policy, and the pidfile rule already says so: never put a
file the host acts on into `run/`. The [`git-push`](#publishing-a-branch-git-push)
recipe is what reads it. The shared token identifies no key, so it is never
allowed a git verb — `caffeinate` and `ping` keep working for it exactly as
today.

This is **bearer** identity, not attestation: a process that obtained another
container's token could act as that container. Each container mounts only its
own key directory, so there is no ambient channel between them, and `keys/` is
never mounted whole — but that is the whole of the guarantee.

Two independent tools share this directory: devc writes `keys/<key>/` and
`policy/<key>.conf` and never invokes the bridge; the bridge writes tokens and
never deletes what devc created. What they share beyond the paths is the policy
line's format (`<repo>\t<remote>\t<branch>`), which is unversioned — a line
either side cannot parse grants nothing.

The arch note is a limitation, not a control: the client is cross-compiled for
the host's architecture. A container run under emulation on the other arch will
find a binary it cannot execute.

## Publishing a branch (`git-push`)

A devcontainer has **no outbound git credential at all** — no SSH agent, no
`gh`, no token. `git-push` trades a narrow, policed slice of that for an
unattended review loop: the agent asks the host to publish its branch, and the
host does, with your credentials, after checking what it is about to send.

> **One container, one repo, one branch.** The token identifies the container;
> the policy names the single repo and branch it may publish. Sibling
> `devc:source` mounts are never pushable — a bind mount you added for
> convenience is not a grant. A container with no policy has exactly the
> capabilities it has today.

### Enabling it

Two deliberate steps, one per tool, and either alone grants nothing:

```sh
devc-bridge install-command git-push     # once per host: the verb exists
devc-bridge install-command git-doctor   # optional: its diagnostics
devc up --bridge-git-push                # per workspace: the pin exists
```

Then, inside that container, `devc-bridge git-push` — no arguments. It prints
`pushed: <branch> at <sha> to <remote> (<repo>)`, or `up to date: …` when the
remote already has that commit.

### What it does

**The host never runs git inside the container's repo.** A `pre-push` hook or
`core.fsmonitor` planted there executes on any `git -C <repo> …` on the host,
and `--no-verify` does not contain repo-local `core.sshCommand` or an `ext::`
`insteadOf` rewrite of the very URL you passed on the command line. So the
script's only contact with the repo is to **fetch from it** — git distrusts the
config of a repo it fetches from — into a host-owned bare mirror at
`~/.local/state/devc-bridge/git/<key>.git`, and every later step runs there:

1. Read `policy/<key>.conf` for the caller's key (from `DEVC_BRIDGE_KEY`, set by
   the bridge from the token). No file, or anything but one line of three fields,
   is exit 2.
2. Check the repo's `.git` as a file: a linked worktree's `gitdir:` pointer must
   point at a `<primary>/.git/worktrees/<name>` that points back, and a primary
   repo must have no `commondir`. Either would otherwise let the fetch read a
   different repo.
3. Create the mirror if absent — from the policy, never cloned from the agent's
   repo — and refuse if its `origin` no longer equals the policy's remote.
4. Ask the remote for its **default branch** (never assumed to be `main`) and
   fetch it fresh.
5. Fetch the pinned branch from the repo into `refs/staging/<branch>` and record
   its SHA.
6. Refuse (exit 3) a SHA whose tree differs from the default branch's under
   `.github/workflows/`, or that adds a Git LFS pointer.
7. Push **that SHA** — not the branch, which the agent can move at any moment —
   to `refs/heads/<branch>`. No tags, no force, no delete: there is no code path
   that emits anything else.

Every git call runs with prompts off, `GIT_ALLOW_PROTOCOL=file:ssh:https`,
hooks disabled, tag- and submodule-following off, and a hard timeout
(`DEVC_BRIDGE_GIT_TIMEOUT`, seconds, default `300`) that kills the whole process
group — the client has no timeout of its own, so a git that stopped to ask
something would otherwise hang the call forever.

| Exit | Meaning                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------- |
| `0`  | pushed, or already up to date                                                                             |
| `2`  | no policy, a malformed one, an argument given, a pin that no longer resolves, or a remote/mirror mismatch |
| `3`  | content-policy refusal: workflows changed, an LFS pointer added, or no default branch to check against    |
| `4`  | transport failure or timeout — including a rejected (non-fast-forward) push                               |

### Limits, stated plainly

- **The mirror holds no unique state.** Deleting it costs a re-fetch on the next
  push and nothing else.
- **Bearer identity.** A process that obtained another container's token could
  push as that container. Each container mounts only its own key directory, so
  there is no ambient channel — but that is the whole of the guarantee.
- **LFS is refused, not supported.** The mirror only ever receives pointer blobs;
  the objects stay in the working repo, so pushing a new pointer would publish a
  commit whose content was never uploaded.
- **A workflow change is refused even when harmless** — including a branch that
  is merely behind a default branch whose workflows moved. Rebase, or push that
  one yourself.
- **SSH needs an agent in the bridge's environment.** The daemon inherits
  `SSH_AUTH_SOCK` from the shell that ran `devc-bridge start`; one started
  without it cannot push over SSH. `git-doctor` says so.

### `git-doctor [key]`

Reports the bridge's `ssh-add -l`, then per policy: the pin, whether the repo
exists and the branch is there (read as files), whether each worktree pointer
of the repo's primary (`<primary>.worktrees/*/.git`) still points where it
should, and the mirror's origin and staging-ref count. Exit 1 when it found
anything. Run on the host it covers every policy, or just `key`; called through
the bridge it covers **only the caller's own** and refuses any other key.

## Iterating on PR review (`pr-*`)

The same trade as `git-push`, for the other half of a review loop: the agent
reads Copilot's review threads on its PR, replies, and resolves Copilot's —
**with no GitHub credential in the container at all**, not even a read-only
one. Each call runs `gh api` on the host with your credentials.

### Enabling it

Each verb is its own recipe, so you grant exactly the ones you want — replies
without resolves is simply not installing `pr-resolve`:

```sh
devc-bridge install-command pr-comments
devc-bridge install-command pr-reply
devc-bridge install-command pr-resolve
devc up --bridge-git-push                # the same pin git-push uses
```

The host needs `gh` on the bridge's `PATH`, authenticated (`gh auth login`, or
`GH_TOKEN` in the environment `devc-bridge start` ran from).

### Which PR

**The pin names a source, and the PR is found from it.** The policy's remote is
the PR's **head** repo — your fork, in a fork workflow — and its branch the head
branch. The recipes ask GitHub for that repo and, if it is a fork, its parent,
and look for open PRs in both whose head is exactly `<head repo>:<branch>`.
Exactly one must match; none or several is exit 2. So:

- a PR from a branch of the repo itself, or from your fork into its upstream,
  is found;
- another fork's PR from a branch of the same name is not — the head repo is
  compared, not just the branch name;
- a PR from your fork into anything but its direct parent (a grandparent, a
  sibling fork) is not found;
- the container never names the target: the parent is whatever GitHub says.

A thread id the container passes is looked up and must belong to that PR (by
node id — PR numbers repeat across repos), or it is exit 2.

### The verbs

| Verb                       | Does                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pr-comments`              | Prints one JSON object: `pr` (`repo`, `number`, `url`, `headSha`), `threads` (unresolved only: `id`, `path`, `line`, `isOutdated`, `copilot`, `comments[]` of `author`/`body`/`createdAt`/`url`), and `copilotReview` (`commit`, `state`, `submittedAt` of Copilot's latest submitted review — `null`s if none — and `pending`, true while Copilot is a requested reviewer) |
| `pr-reply <thread> <body>` | Replies to **any** thread on the PR — a human reviewer's too, resolved or not. Posted under your identity with the fixed prefix `🤖`. The body must be non-empty, at most **4000 bytes**, with no control characters other than newline and tab; anything else is exit 3 with a message saying what to change, and nothing is sent                                          |
| `pr-resolve <thread>`      | Resolves a thread **only if Copilot started it** (its first comment's author is the `copilot-pull-request-reviewer` bot). A human reviewer's thread is exit 3 — resolving hides feedback, which is the one thing a misbehaving agent would want. Already resolved is exit 0                                                                                                 |

**There is no re-review verb.** A push already triggers Copilot's review when
the repo's auto-review ruleset has _review new pushes_ on. `copilotReview` is how
the agent tells that review has landed: after `git-push`, wait until `pending`
is `false` and `commit` equals `pr.headSha`. On a repo without that ruleset the
commit never catches up, and the agent should stop rather than ask.

| Exit | Meaning                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | done, or already resolved                                                                                                                   |
| `2`  | no policy, the shared token, wrong arguments, an unsupported (non-github.com) remote, no single open PR for the pin, a thread not on it     |
| `3`  | refused, and the agent can adjust: a reply body that is empty, too long or has control characters; resolving a thread Copilot did not start |
| `4`  | GitHub or transport failure, `gh` missing or not authenticated, or the timeout (`DEVC_BRIDGE_GH_TIMEOUT`, seconds, default `60`)            |

### How `gh` is driven

The container's repo is never read or run in — everything comes from the
policy and from GitHub. `gh` runs from `/`, only as `gh api` with the repo in
the path or as GraphQL variables, so it never infers a repo from a git config
the agent controls (`gh pr …` would). Container-supplied values — the branch
from the pin, a thread id, a reply body — reach GitHub only as `-f` GraphQL
variables: never interpolated into a query, and never `-F`, which reads a file
for a value starting with `@`. Each call runs under the same process-group
timeout as `git-push`.

### Limits, stated plainly

- **`pr-comments` output is untrusted.** Every body in it was written by someone
  who could comment on the PR. An agent should treat it as data to act on, not
  instructions.
- **Replies are you.** They post under your GitHub identity; the prefix is the
  only marker, and the 4000-byte cap the only volume limit.
- **Thread comments are capped at 100 per thread**; beyond that a thread is
  truncated, not refused. Top-level PR comments and review summary bodies are
  not included — threads only.
- **`copilotReview` looks at the last 100 reviews.** A PR with more reviews than
  that since Copilot's last reports `null`s.

## Writing a command

Drop an executable script in `host/commands/`. Its filename becomes the command
name. For anything long-running that `status` (and the tray) should reflect,
create a marker file in `$DEVC_BRIDGE_STATE` while active and remove it when
done — see
`host/commands/caffeinate` and `host/commands/toggle` for the pattern.

**`ping` is a reserved name.** When the server is configured with keepalive
options (see [Wiring into Claude Code hooks](#wiring-into-claude-code-hooks)),
the `ping` command is a builtin handled by the server itself and shadows any
same-named script in `commands/` — don't put a `ping` script there expecting
it to run.

### Backgrounding a long-running process

A command should **return promptly** — the client blocks until it does. If you
start a long-running process, **detach its stdio** or the call hangs: the bridge
reads the script's output until EOF, and a backgrounded child inherits (and
holds open) those pipes for its entire life, so `output()` never sees EOF until
the child exits.

```bash
caffeinate -dims </dev/null >/dev/null 2>&1 &   # detached — script returns now
caffeinate -dims &                              # WRONG — client hangs until caffeinate dies
```

Record its PID (e.g. in a `$DEVC_BRIDGE_STATE` marker) so a later `stop` can
kill it.

### The script's contract

The bridge guarantees a command script exactly two things:

1. **Args arrive as separate `argv` elements** — properly delimited, never
   re-parsed by a shell. No injection, no word-splitting surprises.
2. **The program that ran is one the host put in `commands/`** — the container
   cannot substitute a different binary.

And three environment variables it can trust, because the bridge sets them and
never passes the daemon's own values through: `DEVC_BRIDGE_STATE` (the marker
dir), `DEVC_BRIDGE_KEY` (the workspace key the caller's token identifies —
**empty** for the shared token, and set on every dispatched call, so a script
can tell one from a run by hand), and `DEVC_BRIDGE_POLICY_DIR` (the host-only
`policy/`).

Everything past that is the script's responsibility. From the script's point of
view, `"$@"` is **untrusted and arbitrary**: any count, any values, any order,
values that may look like flags. Escaping is handled _for_ the script; **meaning
is not**. The script is the only layer that understands its command's semantics,
so it is the only layer that can reject a dangerous-but-well-formed request.

### Safe arg handling — opt in, don't forward

Treat args as a small, explicit vocabulary and _construct_ the real command line
yourself. Never relay `"$@"` to a powerful binary — that exposes the binary's
own destructive flags (`--delete`, `-f`, `--exec`, …) to the container.

```bash
# BEST — fixed verb enum; args select behavior, never supply flags
case "${1:-status}" in
  start) caffeinate -dims & ... ;;
  stop|status) ... ;;
  *) echo "usage: caffeinate {start|stop|status}" >&2; exit 2 ;;
esac

# OK — a free-form value is genuinely needed: validate its SHAPE, pin its position, use --
timeout="$1"
[[ "$timeout" =~ ^[0-9]+$ ]] || { echo "timeout must be an integer" >&2; exit 2; }
caffeinate -t "$timeout"          # container controls a number, not a flag

# BAD — forwards arbitrary flags to a powerful binary
caffeinate "$@"
# BAD — re-introduces a shell interpreter
eval "$1"; bash -c "$1"
# BAD — arg misread as an option (flag injection); guard operands with --
grep "$1" file      →      grep -- "$1" file
```

Rules of thumb:

- **Quote every expansion** (`"$1"`, `"$@"`); never pass args to `eval` /
  `sh -c` / backticks.
- **Prefer a `case` verb enum**; it sidesteps both destructive flags and flag
  injection.
- **If a value must pass through, validate its shape** and place it in a fixed
  argument position; use `--` to stop option parsing for operands that could
  start with `-`.
- **Validate/confine paths** — argv-safety stops shell injection, not path
  traversal.

The bridge deliberately does not filter args (e.g. no global "reject `-…`"
rule): it can't know any command's semantics, and a false sense of safety is
worse than none. Per-command validation is the honest boundary.

### Three nested allowlists

The request picks the **command** (host-defined — the filenames in the commands
dir); the script picks the **behavior** (its verb enum); any free value is
**shape-validated data**, never a flag. And the backdrop for all of it:
everything runs as your host user, so keep the scripts few and simple.

## Layout

Paths are relative to `devc-bridge/` unless noted.

| Path                       | Role                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `host/main.ts`             | `devc-bridge` entrypoint — CLI dispatch, the detached `start`, and the headless `run`                                 |
| `host/config.ts`           | Path resolution + `ensureConfig`/`seedCommands` (zero-setup on first start)                                           |
| `host/core.ts`             | Headless TCP server + dispatch + state and `keys/` watchers — what `run` runs                                         |
| `host/tray.ts`             | Opt-in tray layer (`run --tray`) — same core + a menu-bar icon; headless if no GUI                                    |
| `host/tests/`              | `deno task test` — relaunch argv, `start`'s detach-and-wait contract, token and per-key minting, `install-command`    |
| `host/token.ts`            | Generate the shared token; mint and track one per `keys/<key>/` (`TokenRegistry`)                                     |
| `host/version.ts`          | The host CLI's `VERSION` — one of the three the release workflow's version guard pins to the tag                      |
| `host/commands/`           | Allowlisted host scripts, **embedded** in the binary + seeded to `~/.config/devc-bridge/commands`                     |
| `recipes/`                 | Embedded but **never seeded** — `git-push`, `git-doctor`; enabled one at a time by `install-command`                  |
| `tests/git_push_test.sh`   | Offline harness for the recipes — a local bare repo stands in for the remote                                          |
| `client/devc-bridge.ts`    | Container client CLI                                                                                                  |
| `client/version.ts`        | The client's own `VERSION` — separate compile unit, pinned to the same tag                                            |
| `client/build-client.sh`   | `deno task build:client` — cross-compile the client into `~/.config/devc-bridge/client/` (dev install)                |
| `../features/devc-bridge/` | The container half as a devcontainer Feature: the two read-only mounts and the PATH symlink                           |
| `../devc-core/default/`    | devc's side: the Feature reference in `devcontainer.json` and the mount-source placeholder in `initialize-command.sh` |
| `icons/`                   | Source PNGs for the app icon + the tray icons (embedded in `tray.ts`)                                                 |
