// Devcontainers for `devc web`, the `container` kind of environment (`environment.ts`): discovery
// (an initial `docker ps`, then a `docker events` stream for the server's lifetime — push, never
// polled) behind {@link ContainerSource}, and each container as a {@link ContainerEnvironment}
// that runs every command through `docker exec` — reached the way the CLI's own `connectionFor`
// says, so web execs exactly as `devc attach` does. This module and `project_control.ts` are the
// only ones that run `docker`.
//
// A devcontainer is any container labelled `devcontainer.local_folder`, which the devcontainer
// CLI sets on every container it creates — the same label `@devc-tools/core/container.ts` finds
// a project's container by.

import {
  type ContainerInfo,
  type ContainerMount,
  dockerExecArgv,
  loginShellArgv,
  parseMounts,
} from '@devc-tools/core/container.ts';
import { projectKey } from '@devc-tools/core/merged_config.ts';
import { resolveGlobalConfigPath } from '@devc-tools/core/config.ts';
import { readPolicy } from '../bridge.ts';
import { connectionFor } from '../container.ts';
import {
  downProject,
  startProject,
  stopProject,
  streamingRunner,
} from './project_control.ts';
import {
  type ByteProc,
  type LineProc,
  runCapped,
  runText,
  spawnBytes,
  spawnLines,
} from './proc.ts';
import type {
  BridgeRun,
  DiscoveryHooks,
  EnvExec,
  EnvFiles,
  Environment,
  EnvironmentSource,
  ExecOutput,
  PrBackend,
  RunLimits,
  RunningSession,
} from './environment.ts';
import { containerHome, execFiles } from './container_files.ts';
import { parseRunningOutput, RUNNING_SCRIPT } from './sessions.ts';
import { isHerdrLaunch } from './herdr_bridge.ts';
import { noGrantMessage } from './pr_review.ts';

export const LOCAL_FOLDER_LABEL = 'devcontainer.local_folder';

/** A devcontainer. `id` is the full Docker id. */
export interface ContainerRecord {
  id: string;
  localFolder: string;
}

/** A `docker ps -a` row: a devcontainer and whether it is running. */
export interface ListedContainer extends ContainerRecord {
  running: boolean;
}

/**
 * Parses one `docker ps --format '{{.ID}}\t{{.State}}\t{{.Label …}}'` line; `null` for a blank
 * or malformed one. Only the `running` state counts as running (`paused` does not: its Herdr
 * can't answer).
 */
export function parsePsLine(line: string): ListedContainer | null {
  const first = line.indexOf('\t');
  const second = first <= 0 ? -1 : line.indexOf('\t', first + 1);
  if (second === -1) return null;
  return {
    id: line.slice(0, first).trim(),
    running: line.slice(first + 1, second).trim() === 'running',
    localFolder: line.slice(second + 1),
  };
}

/**
 * One `docker events --format '{{json .}}'` line, reduced to what discovery needs. `exec` is an
 * `exec_start`, with `command` the exec's entrypoint and args as Docker space-joins them.
 */
export type ContainerEvent =
  | { action: 'start' | 'die' | 'destroy'; id: string; localFolder: string }
  | { action: 'exec'; id: string; localFolder: string; command: string };

/** Parses one `docker events` JSON line; `null` for anything not a start, die, destroy or exec_start. */
export function parseEventLine(line: string): ContainerEvent | null {
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof ev !== 'object' || ev === null) return null;
  const { Action, Actor } = ev as {
    Action?: unknown;
    Actor?: { ID?: unknown; Attributes?: Record<string, unknown> };
  };
  if (typeof Action !== 'string' || typeof Actor?.ID !== 'string') return null;
  const folder = Actor.Attributes?.[LOCAL_FOLDER_LABEL];
  const base = {
    id: Actor.ID,
    localFolder: typeof folder === 'string' ? folder : '',
  };
  if (Action === 'start' || Action === 'die' || Action === 'destroy') {
    return { action: Action, ...base };
  }
  // Docker reports an exec as `exec_start: <entrypoint> <args…>`.
  const EXEC = 'exec_start:';
  if (Action.startsWith(EXEC)) {
    return {
      action: 'exec',
      ...base,
      command: Action.slice(EXEC.length).trim(),
    };
  }
  return null;
}

/** A container's mount table, via one `docker inspect`; `[]` on failure. */
export async function inspectMounts(
  id: string,
  run: typeof runText = runText,
): Promise<ContainerMount[]> {
  const { code, stdout } = await run('docker', [
    'inspect',
    '--format',
    '{{json .Mounts}}',
    id,
  ]);
  if (code !== 0) return [];
  return parseMounts(stdout.trim());
}

/** How many trailing CLI output lines a failed {@link resolveConnection} carries. */
const RESOLVE_ERROR_TAIL_LINES = 5;

/**
 * How to reach a discovered container: the CLI's own {@link connectionFor}, so every exec from
 * `devc web` carries the same user, `remoteEnv` and working directory `devc attach` would. The
 * devcontainer CLI's progress log is captured rather than printed to `devc web`'s terminal, and a
 * failure's message carries its last few lines.
 */
export async function resolveConnection(
  record: ContainerRecord,
): Promise<ContainerInfo> {
  const lines: string[] = [];
  try {
    return await connectionFor(
      record.localFolder,
      record.id,
      streamingRunner((line) => {
        if (line.trim() !== '') lines.push(line);
      }),
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      [message, ...lines.slice(-RESOLVE_ERROR_TAIL_LINES)].join('\n'),
    );
  }
}

/**
 * The absolute path of `herdr` in the container, or `''` when it has none. A login shell, because
 * the Agents Feature installs into `~/.local/bin`, which a plain `docker exec` PATH may not
 * include, and the same `bash -l` a pane's shell and `devc claude` get, so the `herdr` found is
 * the one on their `PATH`. This is the only Herdr-related exec that goes through a shell: every
 * later one runs the returned path directly.
 */
export async function resolveHerdrPath(
  info: ContainerInfo,
  run: typeof runText = runText,
): Promise<string> {
  const { stdout } = await run(
    'docker',
    dockerExecArgv(info, { cmd: loginShellArgv('command -v herdr') }),
  );
  const path = stdout.trim().split('\n').pop()?.trim() ?? '';
  return path.startsWith('/') ? path : '';
}

/** Lists devcontainers: the running ones, or with `all` the stopped ones too. */
export async function listDevcontainers(
  all = false,
): Promise<ListedContainer[]> {
  const { code, stdout, stderr } = await runText('docker', [
    'ps',
    ...(all ? ['-a'] : []),
    '--no-trunc',
    '--filter',
    `label=${LOCAL_FOLDER_LABEL}`,
    '--format',
    `{{.ID}}\t{{.State}}\t{{.Label "${LOCAL_FOLDER_LABEL}"}}`,
  ]);
  if (code !== 0) throw new Error(stderr.trim() || 'docker ps failed');
  return stdout.split('\n').map(parsePsLine).filter((r) =>
    r !== null
  ) as ListedContainer[];
}

export interface ContainerHooks {
  /** A container is running. */
  onAdd(record: ContainerRecord): void;
  /** A running container stopped or went away. */
  onRemove(id: string): void;
  /** The set of stopped containers changed: see {@link Discovery.stopped}. */
  onStoppedChange(): void;
  /** A `docker exec` started in a known devcontainer. */
  onExec(id: string, command: string): void;
  onError(message: string): void;
}

const EVENTS_RESTART_MS = 2000;

/**
 * Tracks the set of running devcontainers, and the stopped ones beside them. `docker events` is
 * started *before* each `docker ps` so nothing that happens between the two is missed; the
 * reconcile makes the overlap harmless. When the events stream ends it is restarted after 2 s
 * and the list reconciled again.
 */
export class Discovery {
  #known = new Map<string, ContainerRecord>();
  #stoppedContainers = new Map<string, ContainerRecord>();
  #events: LineProc | null = null;
  #stopped = false;
  #restartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private hooks: ContainerHooks) {}

  start(): void {
    this.#runEvents();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#restartTimer);
    this.#events?.kill();
  }

  #add(record: ContainerRecord): void {
    if (this.#known.has(record.id)) return;
    this.#known.set(record.id, record);
    this.hooks.onAdd(record);
  }

  #remove(id: string): void {
    if (!this.#known.delete(id)) return;
    this.hooks.onRemove(id);
  }

  /** Stopped devcontainers (created or exited), by id. */
  get stopped(): ReadonlyMap<string, ContainerRecord> {
    return this.#stoppedContainers;
  }

  #setStopped(record: ContainerRecord, stopped: boolean): void {
    const had = this.#stoppedContainers.has(record.id);
    if (stopped === had) return;
    if (stopped) this.#stoppedContainers.set(record.id, record);
    else this.#stoppedContainers.delete(record.id);
    this.hooks.onStoppedChange();
  }

  async #reconcile(): Promise<void> {
    try {
      await this.refresh();
    } catch (e) {
      this.hooks.onError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Lists the devcontainers again and brings the running and stopped sets in line with it, for
   * whatever `docker events` missed. Throws when `docker ps` fails.
   */
  async refresh(): Promise<void> {
    const current = await listDevcontainers(true);
    const running = new Set(current.filter((r) => r.running).map((r) => r.id));
    for (const id of [...this.#known.keys()]) {
      if (!running.has(id)) this.#remove(id);
    }
    const stopped = new Map(
      current.filter((r) => !r.running).map((r) => [r.id, r]),
    );
    let changed = false;
    for (const id of [...this.#stoppedContainers.keys()]) {
      if (!stopped.has(id)) {
        changed = this.#stoppedContainers.delete(id) || changed;
      }
    }
    for (const [id, r] of stopped) {
      if (this.#stoppedContainers.has(id)) continue;
      this.#stoppedContainers.set(id, { id, localFolder: r.localFolder });
      changed = true;
    }
    if (changed) this.hooks.onStoppedChange();
    for (const r of current) {
      if (r.running) this.#add({ id: r.id, localFolder: r.localFolder });
    }
  }

  async #runEvents(): Promise<void> {
    if (this.#stopped) return;
    const proc = spawnLines('docker', [
      'events',
      '--filter',
      'type=container',
      '--filter',
      `label=${LOCAL_FOLDER_LABEL}`,
      '--filter',
      'event=start',
      '--filter',
      'event=die',
      '--filter',
      'event=destroy',
      // Execs too: how a Herdr server started after discovery is noticed (see
      // `ContainerSession.herdrLaunched`).
      '--filter',
      'event=exec_start',
      '--format',
      '{{json .}}',
    ]);
    this.#events = proc;
    // Nothing is ever written: `docker events` reads no stdin.
    void proc.closeStdin();
    void this.#reconcile();
    for await (const line of proc.lines) {
      const ev = parseEventLine(line);
      if (ev === null) continue;
      if (ev.action === 'exec') {
        if (this.#known.has(ev.id)) this.hooks.onExec(ev.id, ev.command);
      } else {
        const record = { id: ev.id, localFolder: ev.localFolder };
        if (ev.action === 'start') {
          this.#setStopped(record, false);
          this.#add(record);
        } else {
          this.#remove(ev.id);
          this.#setStopped(record, ev.action === 'die');
        }
      }
    }
    await proc.status;
    if (this.#stopped) return;
    this.#restartTimer = setTimeout(
      () => void this.#runEvents(),
      EVENTS_RESTART_MS,
    );
  }
}

/** Throws `Deno.errors.NotFound` when `docker` is not on PATH. */
export async function probeDocker(): Promise<void> {
  await runText('docker', ['--version']);
}

// ---------------------------------------------------------------------------------------------
// A container as an Environment
// ---------------------------------------------------------------------------------------------

/** Runs `docker args…`, stdout as bytes. */
export type DockerRun = (args: string[]) => Promise<ExecOutput>;

/** Runs `docker args…` with `input` as its stdin. */
export type DockerRunInput = (
  args: string[],
  input: Uint8Array,
) => Promise<ExecOutput>;

/** How long one one-shot exec (a listing, a read, a write) may take before it is given up on. */
const EXEC_TIMEOUT_MS = 15_000;

/** `docker args…` to completion, killed after {@link EXEC_TIMEOUT_MS}. */
export const runDocker: DockerRun = async (args) => {
  const out = await new Deno.Command('docker', {
    args,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
    signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
  }).output();
  return {
    code: out.code,
    stdout: out.stdout,
    stderr: new TextDecoder().decode(out.stderr),
  };
};

/** `docker args…` to completion with `input` piped to stdin, killed after the same timeout. */
export const runDockerInput: DockerRunInput = async (args, input) => {
  const child = new Deno.Command('docker', {
    args,
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
    signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
  }).spawn();
  const writer = child.stdin.getWriter();
  try {
    await writer.write(input);
    await writer.close();
  } catch { /* the child exited first: its status says why */ }
  const out = await child.output();
  return {
    code: out.code,
    stdout: out.stdout,
    stderr: new TextDecoder().decode(out.stderr),
  };
};

/** `docker exec …` argv for `x` in the container `info` reaches. */
export function containerExecArgv(
  info: ContainerInfo,
  x: EnvExec,
  detach = false,
): string[] {
  return dockerExecArgv(info, {
    cmd: x.cmd,
    ...(x.cwd !== undefined ? { cwd: x.cwd } : {}),
    ...(x.env !== undefined ? { env: x.env } : {}),
    ...(x.interactive ? { interactive: true } : {}),
    ...(detach ? { detach: true } : {}),
  });
}

/** Whether container `id` is still running. */
async function dockerRunning(id: string): Promise<boolean> {
  try {
    const out = await new Deno.Command('docker', {
      args: ['inspect', '-f', '{{.State.Running}}', id],
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
    }).output();
    return out.code === 0 &&
      new TextDecoder().decode(out.stdout).trim() === 'true';
  } catch {
    return false;
  }
}

/** What a {@link ContainerEnvironment} runs commands with; tests replace them. */
export interface ContainerEnvDeps {
  /** How to reach the container: see {@link resolveConnection}. */
  resolve: (record: ContainerRecord) => Promise<ContainerInfo>;
  /** `docker args…` as text: `herdr` lookups, a detached server start, `docker inspect`. */
  runText: typeof runText;
  run: DockerRun;
  runInput: DockerRunInput;
  spawn: (args: string[]) => LineProc;
  spawnBytes: (args: string[]) => ByteProc;
  /** The `docker` command the PR review's bridge commands run (tests stub it). */
  docker: string;
  /** Where `~/.config/devc-bridge/` (the policy) and `~/.config/devc/` are found. */
  home: string;
  running: (id: string) => Promise<boolean>;
}

/**
 * A running devcontainer: every command a `docker exec` as its remote user, with its
 * `remoteEnv`. How to reach it is resolved on first use and again on {@link prepare}; a failed
 * resolution is not kept.
 */
export class ContainerEnvironment implements Environment {
  readonly kind = 'container' as const;
  readonly id: string;
  readonly localFolder: string;
  readonly caps = { stop: true, down: true, containerPaths: true };
  readonly files: EnvFiles;
  readonly pr: PrBackend;
  readonly #deps: ContainerEnvDeps;
  #info: Promise<ContainerInfo> | null = null;
  /** The last resolution, for the long-lived spawns (which only follow a resolved one). */
  #resolved: ContainerInfo | null = null;
  #mounts: ContainerMount[] | null = null;
  #home: Promise<string | null> | null = null;

  constructor(
    record: ContainerRecord,
    readonly herdrSession: string,
    deps: Partial<ContainerEnvDeps> = {},
  ) {
    this.id = record.id;
    this.localFolder = record.localFolder;
    this.#deps = {
      resolve: resolveConnection,
      runText,
      run: runDocker,
      runInput: runDockerInput,
      spawn: (args) => spawnLines('docker', args),
      spawnBytes: (args) => spawnBytes('docker', args),
      docker: 'docker',
      home: Deno.env.get('HOME') ?? '.',
      running: dockerRunning,
      ...deps,
    };
    this.files = execFiles(this);
    this.pr = containerPrBackend({
      info: () => this.info(),
      localFolder: this.localFolder,
      home: this.#deps.home,
      docker: this.#deps.docker,
    });
  }

  /** How to reach the container: the cached resolution, else a new one. */
  info(): Promise<ContainerInfo> {
    if (this.#info === null) this.#resolve();
    return this.#info!;
  }

  #resolve(): Promise<ContainerInfo> {
    const info = this.#deps.resolve({
      id: this.id,
      localFolder: this.localFolder,
    });
    this.#info = info;
    info.then((i) => {
      if (this.#info === info) this.#resolved = i;
    }, () => {
      if (this.#info === info) this.#info = null;
    });
    return info;
  }

  async prepare(): Promise<void> {
    this.#resolved = await this.#resolve();
  }

  #now(): ContainerInfo {
    if (this.#resolved === null) {
      throw new Error('the container connection has not been resolved');
    }
    return this.#resolved;
  }

  spawn(x: EnvExec): LineProc {
    return this.#deps.spawn(containerExecArgv(this.#now(), x));
  }

  spawnBytes(x: EnvExec): ByteProc {
    return this.#deps.spawnBytes(containerExecArgv(this.#now(), x));
  }

  async run(x: EnvExec, input?: Uint8Array): Promise<ExecOutput> {
    const info = await this.info();
    return input === undefined
      ? await this.#deps.run(containerExecArgv(info, x))
      : await this.#deps.runInput(
        containerExecArgv(info, { ...x, interactive: true }),
        input,
      );
  }

  async runDetached(x: EnvExec): Promise<ExecOutput> {
    const out = await this.#deps.runText(
      'docker',
      containerExecArgv(await this.info(), x, true),
    );
    return {
      code: out.code,
      stdout: new TextEncoder().encode(out.stdout),
      stderr: out.stderr,
    };
  }

  async runLimited(x: EnvExec, limits: RunLimits): Promise<BridgeRun> {
    return runCapped(
      this.#deps.docker,
      containerExecArgv(await this.info(), x),
      limits,
    );
  }

  loginShell(script: string, ...args: string[]): string[] {
    return loginShellArgv(script, ...args);
  }

  async herdrPath(): Promise<string> {
    return resolveHerdrPath(await this.info(), this.#deps.runText);
  }

  /** Read once; not retried. */
  home(): Promise<string | null> {
    this.#home ??= containerHome(this);
    return this.#home;
  }

  /** Read once: fixed when the container is created. A failed read (an empty table) is not kept. */
  async mounts(): Promise<ContainerMount[]> {
    if (this.#mounts !== null) return this.#mounts;
    const mounts = await inspectMounts(this.id, this.#deps.runText);
    if (mounts.length) this.#mounts = mounts;
    return mounts;
  }

  async repoSources(): Promise<string[]> {
    return (await this.mounts()).filter((m) => m.type === 'bind')
      .map((m) => m.source);
  }

  async runningAgents(): Promise<RunningSession[]> {
    try {
      const out = await this.run({
        cwd: '/',
        cmd: ['sh', '-c', RUNNING_SCRIPT],
      });
      if (out.code !== 0) return [];
      return parseRunningOutput(new TextDecoder().decode(out.stdout));
    } catch {
      return [];
    }
  }

  running(): Promise<boolean> {
    return this.#deps.running(this.id);
  }
}

/**
 * A container's PR backend: grants from the host-only policy (`readPolicy`, keyed by
 * `projectKey(localFolder)`), read on every call, and `devc-bridge <command>` run in the
 * container.
 */
export function containerPrBackend(opts: {
  info: () => Promise<ContainerInfo>;
  localFolder: string;
  home: string;
  docker?: string;
}): PrBackend {
  const dropSlash = (p: string) => p.length > 1 ? p.replace(/\/+$/, '') : p;
  return {
    async pin(root) {
      const problem = async () => ({
        problem: noGrantMessage(
          await resolveGlobalConfigPath(`${opts.home}/.config/devc`),
        ),
      });
      let policy;
      try {
        policy = await readPolicy(await projectKey(opts.localFolder), {
          home: opts.home,
        });
      } catch {
        return await problem();
      }
      if (policy.kind !== 'present') return await problem();
      // Grants are per line: the line pinning `root` decides, never another repo's.
      const pinned = policy.record.repos.find((r) =>
        dropSlash(r.repo) === root
      );
      if (pinned === undefined || !pinned.grants.includes('gh-pr-read')) {
        return await problem();
      }
      return { target: pinned.target, grants: pinned.grants };
    },
    async run(command, target, args, limits) {
      return runCapped(
        opts.docker ?? 'docker',
        containerExecArgv(await opts.info(), {
          cwd: '/',
          cmd: ['devc-bridge', command, '--repo', target, ...args],
        }),
        limits,
      );
    },
  };
}

/**
 * The devcontainers as an {@link EnvironmentSource}: {@link Discovery}'s running containers as
 * {@link ContainerEnvironment}s on Herdr session `session`, its stopped ones, and the CLI's own
 * start, stop and down.
 */
export class ContainerSource implements EnvironmentSource {
  readonly kind = 'container' as const;
  #discovery: Discovery | null = null;

  constructor(
    readonly session: string,
    private deps: Partial<ContainerEnvDeps> = {},
  ) {}

  start(hooks: DiscoveryHooks): void {
    this.#discovery = new Discovery({
      onAdd: (record) =>
        hooks.onAdd(
          new ContainerEnvironment(record, this.session, this.deps),
        ),
      onRemove: hooks.onRemove,
      onStoppedChange: hooks.onStoppedChange,
      onExec: (id, command) => {
        if (isHerdrLaunch(command)) hooks.onLaunch(id);
      },
      onError: hooks.onError,
    });
    this.#discovery.start();
  }

  stop(): void {
    this.#discovery?.stop();
  }

  async refresh(): Promise<void> {
    await this.#discovery?.refresh();
  }

  stopped(): ReadonlyMap<string, ContainerRecord> {
    return this.#discovery?.stopped ?? new Map();
  }

  environment(record: ContainerRecord): ContainerEnvironment {
    return new ContainerEnvironment(record, this.session, this.deps);
  }

  startProject(
    localFolder: string,
    onLine: (line: string) => void,
  ): Promise<void> {
    return startProject(localFolder, onLine);
  }

  stopProject(localFolder: string): Promise<boolean> {
    return stopProject(localFolder);
  }

  downProject(localFolder: string): Promise<boolean> {
    return downProject(localFolder);
  }
}
