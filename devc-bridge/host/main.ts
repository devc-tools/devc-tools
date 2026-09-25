// devc-bridge — host-side control CLI for the devcontainer command bridge.
//
//   devc-bridge start       seed config (first run) + run the bridge in the background
//   devc-bridge stop        stop the background bridge
//   devc-bridge status      report whether the bridge is running
//   devc-bridge restart     stop then start
//   devc-bridge run         run the bridge in the foreground (headless)
//   devc-bridge run --tray  ditto, plus the macOS menu-bar tray (`deno desktop` only)
//   devc-bridge version     print the version (also --version / -V)
//   devc-bridge install-command <name>
//                           enable an unseeded recipe (e.g. git-push) by copying it into commands/
//
// main.ts plays two roles from one file:
//   • As the CLI (start/stop/status/restart) it's the *controller* — it spawns, signals
//     and inspects; it never serves. `start` relaunches *this same program* with the
//     `run` subcommand as a plain detached child, so there is no build step, no bundle
//     and no `deno` needed on PATH: a compiled binary can start itself.
//   • As `run` it's the bridge itself — the TCP server, dispatch, state watcher and
//     keepalive from core.ts, headless by default.
//
// The tray (tray.ts) is an opt-in front-end on the same core, not the way the bridge
// runs. See .plans/archived/devc-bridge-tray-decouple.md.

import { fromFileUrl } from '@std/path';
import {
  appendLog,
  type Config,
  ensureConfig,
  errMsg,
  installCommand,
  listRecipes,
  loadConfig,
} from './config.ts';
import { startServer } from './core.ts';
import { resetToken } from './token.ts';
import { runTray } from './tray.ts';
import { VERSION } from './version.ts';

const USAGE =
  'usage: devc-bridge {start|stop|status|restart|run [--tray]|install-command <name>|version}';

async function main(): Promise<void> {
  const sub = Deno.args[0];
  // Before `loadConfig()`: `--version` is the one question a binary must be able to
  // answer with nothing else resolved, and it is what the release workflow's smoke test
  // runs against a freshly built artifact on a runner with no `~/.config/devc-bridge`.
  if (sub === 'version' || sub === '--version' || sub === '-V') {
    console.log(`devc-bridge ${VERSION}`);
    return;
  }
  const cfg = loadConfig();
  switch (sub) {
    case 'start':
      await start(cfg);
      break;
    case 'stop':
      await stop(cfg);
      break;
    case 'status':
      await status(cfg);
      break;
    case 'restart':
      await stop(cfg);
      await start(cfg);
      break;
    case 'run':
      await run(cfg, Deno.args.slice(1)); // never returns
      break;
    case 'install-command':
      await install(cfg, Deno.args.slice(1));
      break;
    default:
      if (sub !== undefined) {
        console.error(`devc-bridge: unknown command ${JSON.stringify(sub)}`);
      }
      console.error(USAGE);
      Deno.exit(2);
  }
}

async function start(cfg: Config): Promise<void> {
  await ensureConfig(cfg);

  const existing = await readPid(cfg);
  if (existing !== null && await pidAlive(existing)) {
    console.log(`already running (pid ${existing})`);
    return;
  }
  // No usable pidfile — but that is not proof nothing is running. Deleting the config
  // dir takes the pidfile with it and orphans the daemon, whose port stays bound: the
  // spawn below would then fail inside the detached child, where nobody sees it, and
  // the wait would time out blaming the launch. A listening port is the handle the
  // pidfile no longer is.
  if (await portInUse(cfg.hostname, cfg.port)) {
    console.error(
      `devc-bridge: ${cfg.hostname}:${cfg.port} is already in use, but no devc-bridge pidfile exists`,
    );
    console.error(
      `devc-bridge: (an orphaned bridge — deleted config dir? — or another program. Find it with: lsof -i :${cfg.port})`,
    );
    Deno.exit(1);
  }

  // Drop any stale pidfile so the fresh one the daemon writes is our success signal.
  await removePidfile(cfg);

  spawnDetached(relaunchArgv(['run']), cfg.logfile);

  // The daemon writes its pidfile once it's listening — our proof it came up.
  const ok = await waitFor(async () => {
    const pid = await readPid(cfg);
    return pid !== null && await pidAlive(pid);
  }, 30_000);

  if (!ok) {
    console.error(
      `devc-bridge: started but never reported ready — see ${cfg.logfile}`,
    );
    await printLogTail(cfg.logfile);
    console.error(
      'devc-bridge: (to see its errors directly, run: devc-bridge run)',
    );
    Deno.exit(1);
  }

  console.log(`started (pid ${await readPid(cfg)})`);
}

/**
 * The bridge itself: server + pidfile + signal handlers, parked until terminated.
 *
 * This is what `start` backgrounds, and the only entrypoint that serves. `--tray`
 * hands off to tray.ts, which runs the same core with a menu-bar icon on top — an
 * extra for a `deno desktop` runtime, never a requirement.
 */
async function run(cfg: Config, args: string[]): Promise<void> {
  const tray = args.includes('--tray');
  const unknown = args.filter((a) => a !== '--tray');
  if (unknown.length > 0) {
    console.error(
      `devc-bridge: unknown run option ${JSON.stringify(unknown[0])}`,
    );
    console.error(USAGE);
    Deno.exit(2);
  }
  // Self-sufficient: `run` is reachable directly (foreground debugging, `deno task
  // dev`), not only through `start`, and it must not depend on a prior seeding.
  await ensureConfig(cfg);
  if (tray) {
    await runTray(cfg); // never returns
    return;
  }

  const token = await resetToken(cfg.token);
  const server = await startServer({
    hostname: cfg.hostname,
    port: cfg.port,
    token,
    keysDir: cfg.keys,
    commandsDir: cfg.commands,
    stateDir: cfg.state,
    policyDir: cfg.policy,
    onActiveChange: (active) =>
      console.log(`active: ${JSON.stringify(active)}`),
    keepawake: cfg.keepawake,
  });

  // How `stop`/`status` find us, however we were launched.
  try {
    await Deno.writeTextFile(cfg.pidfile, `${Deno.pid}\n`);
  } catch (e) {
    await appendLog(
      cfg.logfile,
      `could not write pidfile ${cfg.pidfile}: ${errMsg(e)}`,
    );
  }

  // Backgrounded by `start`, stdout is the log file — this line is what a failed
  // launch would be missing, and it is `start`'s own readiness message in reverse.
  console.log(`listening on ${server.address} (commands: ${cfg.commands})`);
  console.log(
    `keepawake: ${cfg.keepawake.command} (idleMs: ${cfg.keepawake.idleMs})`,
  );

  const shutdown = async () => {
    await server.close();
    try {
      Deno.removeSync(cfg.pidfile);
    } catch { /* already gone */ }
    Deno.exit(0);
  };
  // `devc-bridge stop` sends SIGTERM; also handle Ctrl-C in the foreground.
  Deno.addSignalListener('SIGINT', shutdown);
  Deno.addSignalListener('SIGTERM', shutdown);
  // Closing the terminal that ran `start` SIGHUPs the whole process group, which
  // the detached child is still in. `nohup` alone does not save it: Deno installs
  // its own SIGHUP handler at startup (`SigCgt` in /proc has the bit), replacing
  // the inherited SIG_IGN, and with no listener that handler exits. An empty
  // listener is what actually makes this a daemon; nohup only covers the moments
  // before this line runs.
  Deno.addSignalListener('SIGHUP', () => {});

  // Park forever; the signal handlers drive shutdown.
  await new Promise<void>(() => {});
}

/**
 * Enable one recipe. Recipes are never seeded — a seeded script is a capability every container
 * gets on first start — so this is the deliberate step. No restart needed: dispatch reads
 * `commands/` on every request.
 */
async function install(cfg: Config, args: string[]): Promise<void> {
  if (args.length !== 1) {
    console.error('usage: devc-bridge install-command <name>');
    console.error(`recipes: ${(await listRecipes()).join(', ') || 'none'}`);
    Deno.exit(2);
  }
  const path = await installCommand(cfg.commands, args[0]);
  console.log(`installed ${path}`);
}

async function stop(cfg: Config): Promise<void> {
  const pid = await readPid(cfg);
  if (pid === null) {
    console.log('not running');
    return;
  }
  try {
    Deno.kill(pid, 'SIGTERM');
  } catch {
    // Process already gone — fall through to clear the stale pidfile.
    console.log('not running');
    await removePidfile(cfg);
    return;
  }
  // Wait for it to actually exit before returning, so `restart` doesn't race the old
  // process for the TCP port (the daemon's SIGTERM handler also removes the pidfile).
  await waitFor(async () => !await pidAlive(pid), 3000);
  await removePidfile(cfg);
  console.log('stopped');
}

async function status(cfg: Config): Promise<void> {
  // Report the dev-override client too. It no longer answers "can a container reach the
  // bridge" — the Feature ships its own client now — but a local build sitting here does
  // change what a container runs when it is mounted, so it should not be invisible. With
  // no menu-bar icon by default, the idle/active suffix below is also *the* way to answer
  // "is it doing anything".
  const client = await clientStatus(cfg);
  const pid = await readPid(cfg);
  if (pid !== null && await pidAlive(pid)) {
    const active = await scanActive(cfg.state);
    const suffix = active.length > 0
      ? ` — active: ${active.join(', ')}`
      : ' — idle';
    console.log(`running (pid ${pid})${suffix}`);
    console.log(client);
    return;
  }
  if (pid !== null) await removePidfile(cfg); // stale
  console.log('stopped');
  console.log(client);
  Deno.exit(1);
}

// --- relaunching ourselves -----------------------------------------------------

/**
 * Permissions the backgrounded bridge needs, for the from-source relaunch only.
 *
 * A compiled binary carries its own (baked in by `deno task build`); this list is
 * the same one, and `deno.json`'s `build`/`dev` tasks and `scripts/bash_aliases.sh`
 * must agree with it — a flag missing here fails the child at runtime, in the log,
 * rather than at the prompt.
 */
const RUN_PERMISSIONS = [
  '--allow-read',
  '--allow-write',
  '--allow-run',
  '--allow-env',
  '--allow-net',
];

/**
 * The argv that re-runs *this program* with `args`.
 *
 * The two ways it can be running need different command lines, and `start` is the
 * one place that cares:
 *   • **Compiled** — `Deno.execPath()` is the bridge itself, so the argv is it plus
 *     the args.
 *   • **From source** — `execPath()` is the `deno` binary, so the whole invocation
 *     has to be rebuilt: `deno run <permissions> <main.ts> <args>`.
 *
 * `Deno.build.standalone` is the discriminator. Path-based probes do not work: a
 * compiled binary reports a *virtual* `file:///tmp/deno-compile-<name>/main.ts` for
 * `Deno.mainModule` which its own process can stat (the embedded VFS answers) but
 * which does not exist for anything it spawns.
 *
 * Parameterized so both branches are testable from either mode.
 */
export function relaunchArgv(
  args: string[],
  opts: {
    standalone?: boolean;
    execPath?: string;
    mainModule?: string;
  } = {},
): string[] {
  const standalone = opts.standalone ?? Deno.build.standalone;
  const execPath = opts.execPath ?? Deno.execPath();
  if (standalone) return [execPath, ...args];

  const mainModule = opts.mainModule ?? Deno.mainModule;
  if (!mainModule.startsWith('file:')) {
    // `deno run https://…/main.ts` — nothing local to hand the child.
    throw new Error(
      `devc-bridge: cannot relaunch from a non-file main module (${mainModule})`,
    );
  }
  return [
    execPath,
    'run',
    ...RUN_PERMISSIONS,
    fromFileUrl(mainModule),
    ...args,
  ];
}

/**
 * Start `argv` as a background process that outlives this one, with its output
 * appended to `logfile`.
 *
 * Via `/bin/sh` for two things `Deno.Command` cannot express:
 *   • **Redirection to a file.** `stdout`/`stderr` only take piped/inherit/null, and
 *     a pipe dies with this process. `start` tails that log to explain a failed
 *     launch, so the child's own output has to land in it.
 *   • **`nohup`.** An orphaned child stays in the terminal's process group, so
 *     closing the terminal SIGHUPs it. `nohup` sets SIGHUP to ignore across the
 *     exec — which covers the child's first milliseconds only: Deno replaces that
 *     disposition with a handler of its own, so `run` also ignores SIGHUP from JS.
 *
 * Both `exec`s preserve the pid, so the child *is* the bridge — though `start`
 * proves the launch by the pidfile the bridge writes, not by this pid.
 */
export function spawnDetached(argv: string[], logfile: string): void {
  const [command, ...args] = argv;
  const child = new Deno.Command('/bin/sh', {
    args: [
      '-c',
      'log="$1"; shift; exec nohup "$@" >>"$log" 2>&1',
      'devc-bridge',
      logfile,
      command,
      ...args,
    ],
    stdin: 'null',
    stdout: 'null',
    stderr: 'null',
  }).spawn();
  // Nothing here waits for it: this process must be free to exit immediately.
  child.unref();
}

// --- helpers -------------------------------------------------------------------

/** Text from the placeholder older devc versions wrote here; recognized so a leftover
 * one is not reported as a real client. Nothing writes it any more. */
const PLACEHOLDER_MARKER = 'devc-bridge: no client binary';

/**
 * A line describing the *dev override* client, which is all this directory is now.
 *
 * Containers no longer get their client from here: the devc-bridge Feature downloads it
 * from the matching release at image build time, so the host has no say in what a
 * container runs. What remains is the developer path — `deno task build:client` writes
 * here, and bind-mounting this directory over /usr/local/share/devc-bridge/client in a
 * container shadows the downloaded copy with a local build.
 *
 * Reported anyway because "which client is in play" is still a host-answerable question,
 * and an override that is silently in effect is worse than one that is named.
 *
 * Detected by content, not size or mtime: a leftover placeholder is a tiny `#!/bin/sh`
 * script and a real client is a compiled binary, so the shebang plus its own message is
 * the one signal that stays true however either was produced.
 */
async function clientStatus(cfg: Config): Promise<string> {
  let head: Uint8Array;
  try {
    using file = await Deno.open(cfg.clientBin, { read: true });
    const buf = new Uint8Array(512);
    const n = await file.read(buf) ?? 0;
    head = buf.subarray(0, n);
  } catch {
    return "client override: none (containers use the Feature's client)";
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(head);
  if (text.startsWith('#!') && text.includes(PLACEHOLDER_MARKER)) {
    return 'client override: none (leftover placeholder — safe to delete)';
  }
  return "client override: present (shadows the Feature's client where mounted)";
}

async function readPid(cfg: Config): Promise<number | null> {
  try {
    const raw = (await Deno.readTextFile(cfg.pidfile)).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Is anything accepting connections on this address? Used to catch a running tray
 * that the pidfile no longer accounts for. A connect (rather than a trial bind)
 * keeps this read-only — it can't transiently steal the port from the tray we are
 * about to launch — and a lingering TIME_WAIT socket refuses connections, so a
 * just-stopped tray doesn't register as still running.
 */
async function portInUse(hostname: string, port: number): Promise<boolean> {
  try {
    const conn = await Deno.connect({ hostname, port });
    conn.close();
    return true;
  } catch {
    return false; // refused/unreachable — nothing listening
  }
}

/** Liveness probe: SIGCONT is benign to a running process; ESRCH ⇒ dead. */
async function pidAlive(pid: number): Promise<boolean> {
  await Promise.resolve();
  try {
    Deno.kill(pid, 'SIGCONT');
    return true;
  } catch {
    return false;
  }
}

async function removePidfile(cfg: Config): Promise<void> {
  try {
    await Deno.remove(cfg.pidfile);
  } catch { /* already gone */ }
}

async function scanActive(stateDir: string): Promise<string[]> {
  const active: string[] = [];
  try {
    for await (const entry of Deno.readDir(stateDir)) {
      if (entry.isFile) active.push(entry.name);
    }
  } catch { /* no state dir yet */ }
  return active.sort();
}

/** Poll `check` until it returns true or `ms` elapses. */
async function waitFor(
  check: () => Promise<boolean>,
  ms: number,
): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return await check();
}

async function printLogTail(logfile: string, lines = 20): Promise<void> {
  try {
    const text = await Deno.readTextFile(logfile);
    const tail = text.split('\n').slice(-lines).join('\n');
    if (tail.trim().length > 0) console.error(tail);
  } catch (e) {
    console.error(`devc-bridge: (no log at ${logfile}: ${errMsg(e)})`);
  }
}

// Guarded so the tests can import the helpers above without the CLI running on
// import (it would see the test runner's argv and exit 2). `import.meta.main` is
// true for `deno run` and for a compiled binary; `standalone` is the belt-and-braces
// half, since a `deno desktop` bundle is compiled too and its entry semantics are
// not something this repo can assert from Linux.
if (import.meta.main || Deno.build.standalone) {
  try {
    await main();
  } catch (e) {
    // Our own failures carry a "devc-bridge: …" message and are worth reading on
    // their own; anything else is a bug, so keep its stack.
    if (e instanceof Error && e.message.startsWith('devc-bridge:')) {
      console.error(e.message);
    } else {
      console.error('devc-bridge: unexpected failure');
      console.error(e);
    }
    Deno.exit(1);
  }
}
