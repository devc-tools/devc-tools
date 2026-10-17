// Devcontainer discovery for `devc web`: an initial `docker ps`, then a `docker events` stream
// for the server's lifetime (push, never polled), plus the per-container facts every Herdr
// process needs — the user to exec as and the absolute path of `herdr`.
//
// A devcontainer is any container labelled `devcontainer.local_folder`, which the devcontainer
// CLI sets on every container it creates — the same label `@devc-tools/core/container.ts` finds
// a project's container by.

import { type LineProc, runText, spawnLines } from './proc.ts';

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

/**
 * The user a container's tools run as: `remoteUser` from the `devcontainer.metadata` label (the
 * **last** entry that has a string one — later entries are the more specific config, as the
 * devcontainer CLI merges them), else the image's `Config.User`, else `root`.
 *
 * `labelsJson` is `docker inspect --format '{{json .Config.Labels}}'` output. The metadata label
 * may hold an array or a single object. Anything malformed falls through to the fallbacks.
 * Nothing else in devc reads this label — `startContainer` learns `remoteUser` from
 * `devcontainer up` — so this is its only parser.
 */
export function resolveRemoteUser(
  labelsJson: string,
  configUser: string,
): string {
  const fallback = configUser.trim() || 'root';
  let labels: unknown;
  try {
    labels = JSON.parse(labelsJson);
  } catch {
    return fallback;
  }
  if (typeof labels !== 'object' || labels === null) return fallback;
  const raw = (labels as Record<string, unknown>)['devcontainer.metadata'];
  if (typeof raw !== 'string') return fallback;
  let meta: unknown;
  try {
    meta = JSON.parse(raw);
  } catch {
    return fallback;
  }
  const entries = Array.isArray(meta) ? meta : [meta];
  let user: string | undefined;
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const r = (entry as Record<string, unknown>).remoteUser;
    if (typeof r === 'string' && r !== '') user = r;
  }
  return user ?? fallback;
}

/** `resolveRemoteUser` for a live container, via one `docker inspect`. */
export async function inspectRemoteUser(id: string): Promise<string> {
  // Labels JSON escapes any newline, so the first line is the labels and the rest is the user.
  const { code, stdout, stderr } = await runText('docker', [
    'inspect',
    '--format',
    '{{json .Config.Labels}}\n{{.Config.User}}',
    id,
  ]);
  if (code !== 0) {
    throw new Error(stderr.trim() || `docker inspect ${id} failed`);
  }
  const nl = stdout.indexOf('\n');
  const labels = nl === -1 ? stdout : stdout.slice(0, nl);
  const user = nl === -1 ? '' : stdout.slice(nl + 1).trim();
  return resolveRemoteUser(labels, user);
}

/**
 * The absolute path of `herdr` in the container, or `''` when it has none. A login shell,
 * because the Agents Feature installs into `~/.local/bin`, which a plain `docker exec` PATH may
 * not include. This is the only Herdr-related exec that goes through a shell: every later one
 * runs the returned path directly.
 */
export async function resolveHerdrPath(
  id: string,
  user: string,
): Promise<string> {
  const { stdout } = await runText('docker', [
    'exec',
    '-u',
    user,
    id,
    'sh',
    '-lc',
    'command -v herdr',
  ]);
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

export interface DiscoveryHooks {
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

  constructor(private hooks: DiscoveryHooks) {}

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
    let current: ListedContainer[];
    try {
      current = await listDevcontainers(true);
    } catch (e) {
      this.hooks.onError(e instanceof Error ? e.message : String(e));
      return;
    }
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
