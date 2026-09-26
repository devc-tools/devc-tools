// Shared configuration: where the bridge keeps its runtime files, and how the
// self-contained binary seeds its editable command scripts on first start.
//
// Everything lives under a single base dir (default ~/.config/devc-bridge). The
// per-dir env overrides that predate this file are still honored so existing
// setups keep working; DEVC_BRIDGE_BASE relocates the whole tree at once.
//
// Seeding is what makes a shared binary "just work": the command scripts are
// embedded at build time (`deno compile --include commands`) and are readable at
// runtime via a URL relative to this module. On start we copy any that are missing
// into the editable commands dir — we never overwrite, since those scripts are the
// host's to edit. Run from source (uncompiled) the same URL resolves to the repo's
// host/commands, so seeding still works without a build.
//
// Built-ins (`../builtin`, embedded the same way) are the opposite: the capability scripts
// (`git-push`, `pr-comments`, …), never seeded and never user-owned. Embedded files cannot be
// exec'd, so every start materializes them into a host-only dir the bridge rewrites whole — an
// upgrade applies on restart. Whether a caller may run one is its policy's grant, checked per
// request in core.ts.

import { dirname, join } from '@std/path';

export interface Config {
  /** Root of the config tree (default ~/.config/devc-bridge). */
  base: string;
  /**
   * Bind-mounted run dir: the shared legacy token lives here, and nothing else. Mounted whole by
   * containers that predate per-workspace tokens and by non-devc consumers, so it is readable by
   * all of them — which is why per-workspace tokens are *not* under it.
   */
  run: string;
  /**
   * Per-workspace token dirs, `keys/<key>/`, each created by devc and bind-mounted read-only into
   * that one container. Never mounted whole. The bridge mints into every subdirectory.
   */
  keys: string;
  /**
   * Per-workspace publish pins, `policy/<key>.conf`, written by devc. Host-only — no container
   * mounts it — because a policy the container could write is not a policy.
   */
  policy: string;
  /** Active-marker dir watched by the tray. */
  state: string;
  /** Editable, allowlisted command scripts (seeded on first start). */
  commands: string;
  /**
   * The materialized built-in capability scripts, `~/.local/state/devc-bridge/builtin/`: rewritten
   * whole on every start, never edited, never mounted, and outside both `commands/` and `run/`.
   */
  builtin: string;
  /**
   * Dev-override client dir: a Linux `devc-bridge` a container can be pointed at.
   *
   * No longer how containers get their client — the devc-bridge Feature downloads that
   * from the matching release into the image. What is written here only matters if a
   * project bind-mounts this directory over /usr/local/share/devc-bridge/client, which
   * is the developer path for testing a local build.
   *
   * Nothing here is built on the fly — this is a *destination* that the release
   * installer or `deno task build:client` writes to. Unlike `commands`, the binary is
   * never user-owned: both paths overwrite it.
   */
  client: string;
  /** The client binary itself, inside `client`. */
  clientBin: string;
  /** Shared-secret token file (inside run/, read by the container client). */
  token: string;
  /**
   * Pidfile for the background daemon (still named `tray.pid`, for the trays
   * that already wrote it).
   *
   * In `base/`, deliberately *not* in the bind-mounted `run/`. `stop` `Deno.kill`s
   * whatever PID it reads here, so a container that can write the file can pick the
   * host process that gets SIGTERM.
   *
   * This is now the *only* thing closing that, so it is load-bearing rather than
   * belt-and-braces. `readonly` on the run mount is no longer a guarantee the bridge
   * makes: the mount is declared by the consumer's devcontainer.json (a Feature cannot
   * express `readonly`), and a Docker Compose devcontainer cannot have it at all — the
   * CLI drops it when generating the compose file. Never move a file the host acts on
   * into `run/`.
   */
  pidfile: string;
  /** Log file the detached daemon's stdout/stderr is appended to. */
  logfile: string;
  /** TCP bind host (reachable from the container via host.docker.internal). */
  hostname: string;
  /** TCP bind port. */
  port: number;
  /** Keepalive policy: which allowlisted script to drive, and the idle timeout. */
  keepawake: { command: string; idleMs: number };
}

/** Default idle timeout: must exceed the longest plausible ping gap (long tool
 * runs, permission-prompt think time), not merely "how fast to notice Claude
 * finished." See .plans/archived/devc-bridge-keepawake.md. */
const DEFAULT_KEEPAWAKE_IDLE_MS = 300_000;

/** Parse `DEVC_BRIDGE_KEEPAWAKE_IDLE_MS`-style values: non-numeric/≤0 → default. */
export function parseIdleMs(
  raw: string | undefined,
  fallback = DEFAULT_KEEPAWAKE_IDLE_MS,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve the config from the environment (or built-in defaults).
 *
 * The environment is the *only* source. `start` spawns the daemon as a plain
 * detached child of this process, so it inherits these variables directly —
 * which is why the settings file that used to bridge the `open -g`/launchd gap
 * is gone. A leftover `~/.config/devc-bridge/settings.json` is ignored.
 */
export function loadConfig(): Config {
  const home = Deno.env.get('HOME') ?? '.';
  const base = Deno.env.get('DEVC_BRIDGE_BASE') ??
    join(home, '.config', 'devc-bridge');
  const run = join(base, 'run');
  const client = join(base, 'client');
  return {
    base,
    run,
    keys: join(base, 'keys'),
    policy: join(base, 'policy'),
    state: Deno.env.get('DEVC_BRIDGE_STATE') ?? join(base, 'state'),
    commands: Deno.env.get('DEVC_BRIDGE_COMMANDS') ?? join(base, 'commands'),
    builtin: join(home, '.local', 'state', 'devc-bridge', 'builtin'),
    client,
    clientBin: join(client, 'devc-bridge'),
    token: Deno.env.get('DEVC_BRIDGE_TOKEN_FILE') ?? join(run, 'token'),
    pidfile: join(base, 'tray.pid'),
    logfile: join(base, 'devc-bridge.log'),
    hostname: Deno.env.get('DEVC_BRIDGE_HOST') || '127.0.0.1',
    port: Number(Deno.env.get('DEVC_BRIDGE_PORT') || 48227),
    keepawake: {
      command: Deno.env.get('DEVC_BRIDGE_KEEPAWAKE_COMMAND') || 'caffeinate',
      idleMs: parseIdleMs(Deno.env.get('DEVC_BRIDGE_KEEPAWAKE_IDLE_MS')),
    },
  };
}

/** Create the runtime dirs and seed missing command scripts. Idempotent. */
export async function ensureConfig(cfg: Config): Promise<void> {
  await ensureDir(cfg.run);
  await ensureDir(cfg.keys);
  await ensureDir(cfg.state);
  await ensureDir(cfg.commands);
  // The dev-override destination. Created (never filled) so `build:client` and the release
  // installer have somewhere to land; `start` deliberately builds no client — see
  // `Config.client`.
  await ensureDir(cfg.client);
  await seedCommands(cfg.commands);
  await materializeBuiltins(cfg.builtin);
}

/**
 * `mkdir -p`, but with a legible failure. A recursive mkdir still throws `AlreadyExists`
 * when the path exists yet doesn't *resolve* to a directory — a dangling symlink (e.g. one
 * left over from an older layout) or a plain file — so name that case instead of surfacing
 * a bare os error 17.
 */
async function ensureDir(path: string): Promise<void> {
  try {
    await Deno.mkdir(path, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
    let kind = 'not a directory';
    try {
      if ((await Deno.stat(path)).isDirectory) return; // symlink to a real dir — fine
    } catch {
      const link = await Deno.readLink(path).catch(() => null);
      kind = link === null
        ? 'not a directory'
        : `a broken symlink → ${link} (retarget or remove it)`;
    }
    throw new Error(`devc-bridge: ${path} is ${kind}`);
  }
}

/**
 * Copy the embedded command scripts into `commandsDir`, skipping any that already
 * exist (they are host-editable — never clobber). Returns the names written.
 */
export async function seedCommands(commandsDir: string): Promise<string[]> {
  const embedded = new URL('./commands', import.meta.url);
  const written: string[] = [];
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(embedded);
  } catch (e) {
    // No embedded commands (shouldn't happen in a proper build) — nothing to seed.
    console.error(`devc-bridge: cannot read embedded commands: ${errMsg(e)}`);
    return written;
  }
  for await (const entry of entries) {
    if (!entry.isFile) continue;
    const target = join(commandsDir, entry.name);
    try {
      await Deno.lstat(target);
      continue; // already present — leave the host's copy alone
    } catch {
      // not present — seed it
    }
    const content = await Deno.readFile(
      new URL(`./commands/${entry.name}`, import.meta.url),
    );
    await Deno.writeFile(target, content);
    await Deno.chmod(target, 0o755);
    written.push(entry.name);
  }
  return written;
}

/** The embedded built-in scripts, sorted. Empty when none are readable (a build without them). */
export async function listBuiltins(): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (
      const entry of Deno.readDir(new URL('../builtin', import.meta.url))
    ) {
      if (entry.isFile) names.push(entry.name);
    }
  } catch { /* none embedded */ }
  return names.sort();
}

/**
 * Write every embedded built-in into `dir` (`0700`, scripts `0755`), replacing whatever is there.
 * Built in a fresh sibling and swapped in by rename, so a crash never leaves a half-written set and
 * a stale script from an older build never survives. Returns the names written.
 */
export async function materializeBuiltins(dir: string): Promise<string[]> {
  const names = await listBuiltins();
  const parent = dirname(dir);
  await Deno.mkdir(parent, { recursive: true, mode: 0o700 });
  const fresh = await Deno.makeTempDir({ dir: parent, prefix: 'builtin.tmp-' });
  try {
    for (const name of names) {
      const target = join(fresh, name);
      await Deno.writeFile(
        target,
        await Deno.readFile(new URL(`../builtin/${name}`, import.meta.url)),
      );
      await Deno.chmod(target, 0o755);
    }
    await Deno.chmod(fresh, 0o700);
    const old = `${fresh}.old`;
    let hadOld = true;
    try {
      await Deno.rename(dir, old);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      hadOld = false;
    }
    await Deno.rename(fresh, dir);
    if (hadOld) await Deno.remove(old, { recursive: true });
  } catch (e) {
    await Deno.remove(fresh, { recursive: true }).catch(() => {});
    throw e;
  }
  return names;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Append a line to the log file (best-effort). A backgrounded bridge has no console
 * anyone is watching — `start` redirects the detached child's stdout/stderr here, and
 * this is how code that bypasses them (the tray, which `open` gives no stdio at all)
 * reaches the same place. It is what `devc-bridge start` tails to explain a failure.
 */
export async function appendLog(logfile: string, msg: string): Promise<void> {
  try {
    await Deno.writeTextFile(logfile, msg.endsWith('\n') ? msg : `${msg}\n`, {
      append: true,
    });
  } catch { /* diagnostics only — never fail the caller */ }
}
