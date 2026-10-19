// Makes a `devc attach` running in a Herdr (https://herdr.dev) pane show the agent that is
// actually running *inside* the container, with Herdr's own idle/working/blocked status, and
// show no agent when the container shell is sitting at a prompt.
//
// Herdr answers two separate questions about a pane's foreground process group: identity
// (name-matched against agent kinds compiled into the Herdr binary — a container agent is
// invisible, the host only sees `docker`) and state (its own detection manifests, evaluated
// against the pane's terminal output, which crosses `docker exec` unchanged). This module only
// ever asserts identity, via `HERDR_AGENT` on a disposable child of the pane's process group —
// state keeps coming from Herdr's own manifests. See `.plans/herdr-agent-sidecar.md` for the
// measurements this design is built on (registering `devc` as a Herdr agent kind and
// `pane report-agent` were both tried and rejected there).
//
// Two children, both spawned by `devc attach`, both ordinary members of the pane's foreground
// process group, both silent:
//
//   docker exec … sh -c '<watcher script>'   reports the container's foreground command
//   devc __herdr-sidecar                     env HERDR_AGENT=<kind>, killed and respawned
//
// The watcher prints a line whenever the container's foreground command changes; devc maps that
// line to a Herdr agent kind ({@link herdrAgentKindFor}) and rotates the sidecar
// ({@link startHerdrSidecar}). Prompt → no kind → no sidecar → the pane honestly shows no agent.
//
// Undocumented, opt-in diagnostics: `DEVC_HERDR_WATCH_DEBUG=<path>` appends a timestamped trail
// of watcher lines and spawn/kill events to that file — see {@link debugLog}'s doc comment for
// why it's a file rather than stderr. No-op, and untouched by every test, when unset.

import { fromFileUrl } from 'jsr:@std/path';
import {
  type ContainerInfo,
  dockerExecArgv,
} from '@devc-tools/core/container.ts';
import type { SelfExecRuntime } from './devcontainer_selfexec.ts';

/**
 * Hidden subcommand that turns a devc process into the sidecar's disposable child — mirrors
 * `__devcontainer` exactly. Dispatched in `main.ts` ahead of `--version`/`--help` and
 * deliberately absent from `COMMANDS`: nobody types this.
 */
export const HERDR_SIDECAR_SUBCOMMAND = '__herdr-sidecar';

/**
 * The env var the attach's `docker exec` carries and the watcher script greps every process's
 * `/proc/<pid>/environ` for — how the watcher finds *this* attach's shell among every process in
 * the container.
 */
export const DEVC_HERDR_WATCH_ENV = 'DEVC_HERDR_WATCH';

// ---------------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------------

/**
 * The three ways `devc attach`/`devc claude` can relate to Herdr, decided from environment
 * alone (no CLI flag — see the plan's "Enablement" section):
 *
 * - `off` — not in a Herdr pane (`HERDR_ENV` unset), the user already asserted a kind themselves
 *   (`HERDR_AGENT` set — two assertions in one process group is undefined behavior, so devc
 *   defers), or the explicit opt-out (`DEVC_HERDR_AGENT=off`). No watcher, no sidecar.
 * - `pinned` — `DEVC_HERDR_AGENT=<kind>` pins that kind for the whole attach: the sidecar is
 *   spawned once with it and no watcher runs. The escape hatch for a kind the mapping table
 *   below doesn't know.
 * - `watch` — the normal case: a watcher tracks the container's foreground command and rotates
 *   the sidecar to match.
 */
export type HerdrMode =
  | { mode: 'off' }
  | { mode: 'watch' }
  | { mode: 'pinned'; kind: string };

/**
 * Decides {@link HerdrMode} from environment, via an injectable reader so the gate is testable
 * without touching `Deno.env` — the caller (`main.ts`) passes `(k) => Deno.env.get(k)`.
 */
export function herdrMode(
  getEnv: (key: string) => string | undefined,
): HerdrMode {
  if (getEnv('HERDR_ENV') !== '1') return { mode: 'off' };
  if (getEnv('HERDR_AGENT') !== undefined) return { mode: 'off' };
  const pin = getEnv('DEVC_HERDR_AGENT');
  if (pin === undefined || pin === '') return { mode: 'watch' };
  if (pin === 'off') return { mode: 'off' };
  return { mode: 'pinned', kind: pin };
}

// ---------------------------------------------------------------------------------------------
// Mapping a container command line to a Herdr agent kind
// ---------------------------------------------------------------------------------------------

/** Interpreters whose own basename tells us nothing — re-take the basename of their script. */
const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3']);

/**
 * Command basename → Herdr manifest id. The value is passed to `HERDR_AGENT` verbatim, so it
 * must be a real manifest id (the basenames under
 * `~/.local/state/herdr/agent-detection/remote/*.toml`) — most agree with their own command
 * name, but `qoder` → `qodercli` and `antigravity` → `agy` do not.
 */
const KIND_TABLE: Record<string, string> = {
  claude: 'claude',
  'claude-code': 'claude',
  codex: 'codex',
  copilot: 'copilot',
  'github-copilot': 'copilot',
  'cursor-agent': 'cursor',
  gemini: 'gemini',
  droid: 'droid',
  opencode: 'opencode',
  amp: 'amp',
  grok: 'grok',
  pi: 'pi',
  kimi: 'kimi',
  'kimi-code': 'kimi',
  kilo: 'kilo',
  'kilo-code': 'kilo',
  devin: 'devin',
  hermes: 'hermes',
  qoder: 'qodercli',
  kiro: 'kiro',
  maki: 'maki',
  antigravity: 'agy',
};

function basenameOf(token: string): string {
  const idx = token.lastIndexOf('/');
  return idx < 0 ? token : token.slice(idx + 1);
}

/**
 * Maps a `/proc/<tpgid>/cmdline`-shaped command line (NUL-separated argv joined with spaces —
 * see the watcher script below) to a Herdr agent kind, or `null` for a shell, an interpreter
 * with nothing recognizable following it, or anything unlisted. Pure — the unit under test.
 *
 * Matches on `cmdline`, never `comm`: a Node-based agent reports `comm=node-MainThread`, so
 * `comm` alone can't tell an agent from its own runtime.
 */
export function herdrAgentKindFor(cmdline: string): string | null {
  const tokens = cmdline.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let base = basenameOf(tokens[0]);

  if (INTERPRETERS.has(base)) {
    const next = tokens.slice(1).find((t) => !t.startsWith('-'));
    if (next === undefined) return null;
    base = basenameOf(next);
  } else if (base === 'gh' && tokens[1] === 'copilot') {
    base = 'copilot';
  }

  return KIND_TABLE[base] ?? null;
}

// ---------------------------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------------------------

/**
 * Builds the watcher's `sh -c` script body, with `id` baked directly into the `grep` pattern
 * rather than passed as a positional argument: `docker exec … sh -c '<script>' <id>` hands `sh`
 * exactly one extra token, which becomes `$0`, not `$1` (measured — a single trailing operand
 * after the command string is the script's *name*, not its first positional parameter). Baking
 * the id in at build time sidesteps that off-by-one entirely; it is a `crypto.randomUUID()`, so
 * it is always shell-safe to splice into a double-quoted pattern with no further quoting.
 *
 * The parsing past that point is the load-bearing part, verified against Herdr 0.8.0 — do not
 * "simplify" it back:
 * - **`tpgid` is the terminal's foreground process group**, field 8 of `/proc/<pid>/stat` —
 *   field 6 *after* `cut -d')' -f2-`, which is how you skip a `comm` that may itself contain
 *   spaces and parens. `tpgid == pid` means the shell itself is in the foreground: no agent.
 * - **Read `/proc/<tpgid>/cmdline`, never `ps -g <tpgid>`.** procps' `-g` selects by *session*,
 *   not process group, and returns nothing for a real foreground job.
 * - **The script self-terminates** on either the watched shell disappearing or 30 failed
 *   attempts to find it — killing the host-side `docker exec` client does not kill this process
 *   inside the container, so without these two `exit 0` arms it would leak one polling `sh` per
 *   attach.
 */
export function herdrWatcherScript(id: string): string {
  return `prev=; pid=; tries=0
while :; do
  if [ -z "$pid" ] || [ ! -r "/proc/$pid/stat" ]; then
    [ -n "$pid" ] && exit 0                       # the shell we watched is gone
    pid=$(grep -l "${DEVC_HERDR_WATCH_ENV}=${id}" /proc/*/environ 2>/dev/null \\
            | head -1 | cut -d/ -f3)
    tries=$((tries + 1))
    [ -z "$pid" ] && [ "$tries" -gt 30 ] && exit 0
  fi
  cur=
  if [ -n "$pid" ] && [ -r "/proc/$pid/stat" ]; then
    set -- $(cut -d')' -f2- "/proc/$pid/stat")    # $1 state $2 ppid $3 pgrp $4 sid $5 tty $6 tpgid
    tpgid=$6
    if [ "$tpgid" -gt 0 ] 2>/dev/null && [ "$tpgid" != "$pid" ] \\
       && [ -r "/proc/$tpgid/cmdline" ]; then
      cur=$(tr '\\0' ' ' < "/proc/$tpgid/cmdline")
    fi
  fi
  [ "$cur" != "$prev" ] && { printf '%s\\n' "$cur"; prev=$cur; }
  sleep 1
done`;
}

/** Full `docker exec` argv for the watcher: no `-i`, no `-t` — see the call site. */
function herdrWatcherArgs(info: ContainerInfo, watchId: string): string[] {
  return dockerExecArgv(info, {
    cmd: ['sh', '-c', herdrWatcherScript(watchId)],
  });
}

// ---------------------------------------------------------------------------------------------
// The sidecar
// ---------------------------------------------------------------------------------------------

/** Permissions the from-source sidecar child needs — see {@link sidecarArgv}'s doc comment. */
const SIDECAR_PERMISSIONS = ['--allow-env'];

/**
 * Full argv for the self-exec that becomes the sidecar, mirroring `devcontainerArgv` in
 * `devcontainer_selfexec.ts` — same reasoning, same branch shape.
 *
 * The sidecar body itself (`runHerdrSidecarBody`) needs no permission at all; `--allow-env`
 * alone is required only because reaching its dispatch in `main.ts` means importing the whole
 * module graph from source, and a module-level env read somewhere in it (`Deno.mainModule`
 * resolution among others) throws `NotCapable` without it. Measured: nothing else is needed.
 */
export function sidecarArgv(runtime: SelfExecRuntime): string[] {
  const self = runtime.standalone ? [] : [
    'run',
    ...SIDECAR_PERMISSIONS,
    fromFileUrl(runtime.mainModule),
  ];
  return [...self, HERDR_SIDECAR_SUBCOMMAND];
}

function currentSelfExecRuntime(): SelfExecRuntime {
  return {
    execPath: Deno.execPath(),
    standalone: Deno.build.standalone,
    mainModule: Deno.mainModule,
  };
}

/**
 * Spawns one sidecar child: `env HERDR_AGENT=<kind>`, stdin piped (the EOF watchdog — see
 * `runHerdrSidecarBody`), stdout/stderr discarded so nothing it could ever print corrupts the
 * agent TUI sharing the pane. Never `detached`: the sidecar is only seen by Herdr because it
 * inherits devc's process group.
 */
function spawnSidecar(
  kind: string,
  runtime: SelfExecRuntime,
): Deno.ChildProcess {
  return new Deno.Command(runtime.execPath, {
    args: sidecarArgv(runtime),
    env: { HERDR_AGENT: kind },
    stdin: 'piped',
    stdout: 'null',
    stderr: 'null',
  }).spawn();
}

async function killChild(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill('SIGTERM');
  } catch {
    // already exited
  }
  await child.status.catch(() => {});
}

/**
 * Serializes sidecar identity transitions: the previous child is always fully dead — `SIGTERM`
 * sent *and its exit awaited* — before the next one is spawned. Never the two overlapping, even
 * briefly: Herdr resolves two simultaneous `HERDR_AGENT` assertions in the same process group as
 * undefined behavior (measured — see the plan's "Two assertions in one group" finding), so
 * spawning the new child before the old one is confirmed gone isn't a shortcut, it's a bug — it
 * can leave a stale kind briefly winning, or flicker, depending on which one Herdr's poll lands
 * on mid-transition. Generic over the child type so it's testable without a real process.
 */
export function createSidecarRotator<T>(
  spawn: (kind: string) => T,
  kill: (child: T) => Promise<void>,
): {
  setKind(kind: string | null): void;
  current(): T | null;
  stop(): Promise<void>;
} {
  let currentKind: string | null = null;
  let currentChild: T | null = null;
  let stopped = false;
  // Every transition is chained onto this, so a burst of `setKind` calls (a rapid seed-then-first-
  // watcher-line, say) still resolves in order — never a mid-flight kill and a later spawn racing.
  let pending: Promise<void> = Promise.resolve();

  function setKind(kind: string | null): void {
    if (stopped || kind === currentKind) return;
    currentKind = kind;
    pending = pending.then(async () => {
      const prev = currentChild;
      currentChild = null;
      if (prev) await kill(prev);
      if (!stopped && kind !== null) currentChild = spawn(kind);
    });
  }

  return {
    setKind,
    current: () => currentChild,
    async stop() {
      if (stopped) return;
      stopped = true;
      await pending.catch(() => {});
      const c = currentChild;
      currentChild = null;
      if (c) await kill(c);
    },
  };
}

/**
 * The child half of `__herdr-sidecar`: read stdin to EOF, then exit 0. That is the whole
 * program — devc holds the write end as a watchdog, so if devc dies for any reason (including
 * `SIGKILL`, which no `finally` here could ever catch) the pipe closes, this reads EOF, and the
 * pane stops claiming an agent. No polling, no orphan.
 */
export async function runHerdrSidecarBody(): Promise<never> {
  for await (const _chunk of Deno.stdin.readable) {
    // discard — the pipe closing (EOF) is the only signal this program cares about
  }
  Deno.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Rotation and teardown
// ---------------------------------------------------------------------------------------------

/**
 * Timestamped diagnostic trail for the rotation lifecycle — watcher lines, kind decisions,
 * spawn/kill starts and completions — appended to `DEVC_HERDR_WATCH_DEBUG`'s value when set, a
 * no-op otherwise (the default, and the only mode in every offline test). A **file**, never
 * `console.error`/stderr: during `devc claude` the attach's `docker exec -it` inherits devc's own
 * stdio, so anything devc itself writes to stderr lands in the *same* live terminal a full-screen
 * agent may be drawing to — exactly the corruption the plan's "pane stays clean" validation item
 * guards against. Best-effort: a write failure (bad path, full disk) never breaks the feature.
 */
export function debugLog(msg: string): void {
  const path = Deno.env.get('DEVC_HERDR_WATCH_DEBUG');
  if (!path) return;
  try {
    Deno.writeTextFileSync(path, `${new Date().toISOString()} ${msg}\n`, {
      append: true,
      create: true,
    });
  } catch {
    // best-effort — diagnostics must never break the feature they're diagnosing
  }
}

async function readLines(
  readable: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** {@link herdrMode}'s `watch`/`pinned` variants, carrying what `startHerdrSidecar` needs from each. */
export type HerdrAttachSpec =
  | { mode: 'watch'; watchId: string }
  | { mode: 'pinned'; kind: string };

/** Returned by {@link startHerdrSidecar}: tears down the watcher and the current sidecar. */
export interface HerdrController {
  /** Kills the watcher (if any) and the current sidecar (if any), and awaits both. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Starts Herdr integration for one attach and keeps at most one sidecar alive for its
 * lifetime — the whole rotation/teardown mechanism from the plan's "Design" section.
 *
 * `spec.mode === 'pinned'`: spawns exactly one sidecar for `spec.kind` and starts no watcher.
 * `spec.mode === 'watch'`: seeds the sidecar from `seedCommand` (so `devc claude` shows the
 * right agent immediately, before the watcher's first tick) via the same
 * {@link herdrAgentKindFor} the watcher's own lines go through, then starts the long-lived
 * watcher `docker exec` and rotates the sidecar on each *distinct* kind it reports — via
 * {@link createSidecarRotator}, which kills the current child and *awaits its exit* before
 * spawning the new one (or spawns nothing, on `null`). Never the two overlapping — see that
 * function's doc comment for why.
 *
 * `info` is the attach's own `ContainerInfo`: the watcher execs the way every devc exec does
 * ({@link dockerExecArgv}), and its `-u` is required, not cosmetic: reading `/proc/<pid>/environ`
 * needs the same uid as the attach shell.
 */
export function startHerdrSidecar(
  info: ContainerInfo,
  spec: HerdrAttachSpec,
  seedCommand: string | undefined,
  runtime: SelfExecRuntime = currentSelfExecRuntime(),
): HerdrController {
  let watcherChild: Deno.ChildProcess | null = null;
  let stopped = false;

  const rotator = createSidecarRotator<Deno.ChildProcess>(
    (kind) => {
      const child = spawnSidecar(kind, runtime);
      debugLog(`sidecar spawn kind=${kind} pid=${child.pid}`);
      return child;
    },
    async (child) => {
      debugLog(`sidecar kill pid=${child.pid} start`);
      await killChild(child);
      debugLog(`sidecar kill pid=${child.pid} done`);
    },
  );

  if (spec.mode === 'pinned') {
    rotator.setKind(spec.kind);
  } else {
    if (seedCommand !== undefined) {
      rotator.setKind(herdrAgentKindFor(seedCommand));
    }
    // No `-i`, no `-t` — this must never touch the pane's terminal.
    watcherChild = new Deno.Command('docker', {
      args: herdrWatcherArgs(info, spec.watchId),
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
    }).spawn();
    debugLog(`watcher spawned pid=${watcherChild.pid} watchId=${spec.watchId}`);
    readLines(
      watcherChild.stdout,
      (line) => {
        const kind = herdrAgentKindFor(line);
        debugLog(`watcher line=${JSON.stringify(line)} kind=${kind ?? 'null'}`);
        rotator.setKind(kind);
      },
    )
      .catch((e) => debugLog(`watcher read error: ${e}`));
  }

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      debugLog('stop() called');
      if (watcherChild) await killChild(watcherChild);
      await rotator.stop();
      debugLog('stop() done');
    },
  };
}
