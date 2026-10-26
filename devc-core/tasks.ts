// `devc web`'s task list: to-dos written down on the page and later sent to an agent in their
// project (`send_task`), in `~/.config/devc/tasks/tasks.json`. Server-side, as pinned files are, so
// every devc web window shows the same tasks.
//
// Sending is one-way: the host writes the task into the container and starts the agent. The one
// thing a container can do here is *add* a task, through devc-bridge's granted `task-add`
// ({@link appendAgentTask}); it can never queue or send one. A sent task moves to `sent`, which
// keeps the agent's session id and where it ran, so its session can be found again.
//
// A routed task can also be *queued* with an action and agent: the server sends the queued tasks
// of one repo one at a time, each once the agent before it in that repo has finished, while
// repos' queues run side by side (see `queueHeads`).
//
// Two processes write the file: devc web and the devc-bridge host. Both take {@link withTasksLock}
// around a read → change → write.

import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import process from 'node:process';
import { CONFIG_DIR } from './default_config.ts';
import { isAlreadyExists, isNotFound } from './errors.ts';
import { dirnamePosix } from './posix.ts';

/** The agents a task can be sent to: those whose CLI takes a session id chosen at launch. */
export type SessionAgentId = 'claude' | 'copilot' | 'pi';

export type TaskAction = 'plan' | 'implement';

const SESSION_AGENTS: readonly SessionAgentId[] = ['claude', 'copilot', 'pi'];

export function isSessionAgentId(v: unknown): v is SessionAgentId {
  return SESSION_AGENTS.includes(v as SessionAgentId);
}

export function isTaskAction(v: unknown): v is TaskAction {
  return v === 'plan' || v === 'implement';
}

/**
 * In a folder of its own, so the task list can be bind-mounted read-only into a container (a
 * planning repo's agent reads it) without exposing the rest of `~/.config/devc`. A folder, not the
 * file: writes replace the file by rename, which a single-file bind mount wouldn't follow.
 */
export const TASKS_PATH = `${CONFIG_DIR}/tasks/tasks.json`;

/** How many sent tasks are kept: the newest. */
export const MAX_SENT = 50;

/** The longest a task's text may be, in UTF-16 code units, once trimmed. */
export const MAX_TASK_TEXT = 20_000;

/** How long a task's title (its first line) may be before it is cut. */
const MAX_TITLE = 80;

/** How many unsent tasks one container's agents may have added. */
export const MAX_AGENT_TASKS = 20;

/** Where a task is meant to go: a project and one of its repo folders (host paths). */
export interface TaskRoute {
  localFolder: string;
  root: string;
}

export interface Task {
  /** Stable id, generated when the task is added (crypto.randomUUID()). */
  id: string;
  /** Markdown; its first line is the title. Stored trimmed. */
  text: string;
  /** ISO time it was added. */
  createdAt: string;
  /** The route, when set: both fields or neither. */
  localFolder?: string;
  root?: string;
  /** Set while it waits in its repo's queue: routed tasks only. */
  queued?: TaskQueued;
  /** Where it came from, when not the page: an agent in the container of project `key`. */
  source?: TaskSource;
}

/** A task added by an agent through devc-bridge's `task-add`; `key` is its project's key. */
export interface TaskSource {
  kind: 'agent';
  key: string;
}

/** How a queued task is to be sent, and since when it waits. */
export interface TaskQueued {
  action: TaskAction;
  agent: SessionAgentId;
  /** ISO time it was queued: its place in its repo's queue. */
  queuedAt: string;
  /** Why sending it failed; the repo's queue halts on it until it is queued again or removed. */
  error?: string;
}

export interface SentTask {
  /** The task's own id. */
  id: string;
  text: string;
  createdAt: string;
  action: TaskAction;
  agent: SessionAgentId;
  /** ISO time it was sent. */
  sentAt: string;
  localFolder: string;
  root: string;
  /** The container path the agent started in. Shown; a resume works it out again. */
  cwd: string;
  /** The session id the agent was started with. */
  sessionId: string;
  /** The agent's pane: a hint, checked before use, never sent to the page. */
  last?: { containerId: string; paneId: string };
}

export interface TaskState {
  tasks: Task[];
  sent: SentTask[];
}

export interface TasksFile extends TaskState {
  version: 1;
}

type Obj = Record<string, unknown>;

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';
const absolute = (v: unknown): v is string =>
  typeof v === 'string' && v.startsWith('/');

function isQueued(v: unknown): v is TaskQueued {
  if (typeof v !== 'object' || v === null) return false;
  const q = v as Obj;
  return isTaskAction(q.action) && isSessionAgentId(q.agent) &&
    nonEmpty(q.queuedAt) && (q.error === undefined || nonEmpty(q.error));
}

function isSource(v: unknown): v is TaskSource {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Obj;
  return s.kind === 'agent' && nonEmpty(s.key);
}

function isTask(v: unknown): v is Task {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Obj;
  const routed = t.localFolder !== undefined || t.root !== undefined;
  return nonEmpty(t.id) && nonEmpty(t.text) && nonEmpty(t.createdAt) &&
    (!routed || (absolute(t.localFolder) && absolute(t.root)));
}

function isLast(v: unknown): v is SentTask['last'] {
  if (typeof v !== 'object' || v === null) return false;
  const l = v as Obj;
  return nonEmpty(l.containerId) && nonEmpty(l.paneId);
}

function isSentTask(v: unknown): v is SentTask {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Obj;
  return nonEmpty(t.id) && nonEmpty(t.text) && nonEmpty(t.createdAt) &&
    isTaskAction(t.action) && isSessionAgentId(t.agent) &&
    nonEmpty(t.sentAt) && absolute(t.localFolder) && absolute(t.root) &&
    absolute(t.cwd) && nonEmpty(t.sessionId) &&
    (t.last === undefined || isLast(t.last));
}

function cleanTask(t: Task): Task {
  return {
    id: t.id,
    text: t.text,
    createdAt: t.createdAt,
    ...(t.localFolder !== undefined && t.root !== undefined
      ? {
        localFolder: t.localFolder,
        root: t.root,
        // A malformed queue entry unqueues the task rather than dropping it.
        ...(isQueued(t.queued) ? { queued: cleanQueued(t.queued) } : {}),
      }
      : {}),
    // A malformed source is dropped, the task kept.
    ...(isSource(t.source)
      ? { source: { kind: t.source.kind, key: t.source.key } }
      : {}),
  };
}

function cleanQueued(q: TaskQueued): TaskQueued {
  return {
    action: q.action,
    agent: q.agent,
    queuedAt: q.queuedAt,
    ...(q.error !== undefined ? { error: q.error } : {}),
  };
}

function cleanSent(t: SentTask): SentTask {
  return {
    id: t.id,
    text: t.text,
    createdAt: t.createdAt,
    action: t.action,
    agent: t.agent,
    sentAt: t.sentAt,
    localFolder: t.localFolder,
    root: t.root,
    cwd: t.cwd,
    sessionId: t.sessionId,
    ...(t.last
      ? { last: { containerId: t.last.containerId, paneId: t.last.paneId } }
      : {}),
  };
}

/** Newest first, at most {@link MAX_SENT}. */
function trimSent(sent: SentTask[]): SentTask[] {
  return [...sent].sort((a, b) => b.sentAt.localeCompare(a.sentAt)).slice(
    0,
    MAX_SENT,
  );
}

/**
 * Missing or unreadable file → nothing. Drops malformed entries and any id seen before (in either
 * list); never throws.
 */
export async function readTasks(path = TASKS_PATH): Promise<TaskState> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { tasks: [], sent: [] };
  }
  const o = (typeof data === 'object' && data !== null ? data : {}) as Obj;
  const ids = new Set<string>();
  const fresh = (id: string) => {
    if (ids.has(id)) return false;
    ids.add(id);
    return true;
  };
  const tasks = (Array.isArray(o.tasks) ? o.tasks : [])
    .filter((t): t is Task => isTask(t) && fresh(t.id))
    .map(cleanTask);
  const sent = (Array.isArray(o.sent) ? o.sent : [])
    .filter((t): t is SentTask => isSentTask(t) && fresh(t.id))
    .map(cleanSent);
  return { tasks, sent: trimSent(sent) };
}

/**
 * Writes the list atomically (a temp file renamed over the old one in the same directory), with
 * `sent` cut to the {@link MAX_SENT} newest.
 */
export async function writeTasks(
  state: TaskState,
  path = TASKS_PATH,
): Promise<void> {
  const file: TasksFile = {
    version: 1,
    tasks: state.tasks,
    sent: trimSent(state.sent),
  };
  await writeAtomic(path, JSON.stringify(file, null, 2) + '\n');
}

/** `text` to `path` at mode 0600, through a temp file in its directory renamed over it. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const dir = dirnamePosix(path);
  await mkdir(dir, { recursive: true });
  const tmp = `${dir}/.tasks-${process.pid}-${
    Math.random().toString(36).slice(2, 10)
  }`;
  try {
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** A lock older than this is taken to be left by a writer that died holding it. */
const STALE_LOCK_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `fn` holding `${path}.lock`, the lock every writer of the tasks file takes around its
 * read → change → write: devc web and the devc-bridge host. A lock over 10 s old is taken over;
 * throws `tasks file is locked (<lock>)` after waiting 5 s.
 */
export async function withTasksLock<T>(
  fn: () => Promise<T>,
  path = TASKS_PATH,
): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(dirnamePosix(path), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await (await open(lock, 'wx')).close();
      break;
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
    }
    const mtime = await stat(lock).then((s) => s.mtimeMs, () => null);
    if (mtime !== null && Date.now() - mtime > STALE_LOCK_MS) {
      await rm(lock, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`tasks file is locked (${lock})`);
    }
    await sleep(LOCK_RETRY_MS);
  }
  try {
    return await fn();
  } finally {
    await rm(lock).catch((e) => {
      if (!isNotFound(e)) throw e;
    });
  }
}

/** Why {@link appendAgentTask} refused: the agent's to fix, not the host's. */
export class AgentTaskCapError extends Error {}

/**
 * Appends a task an agent added (devc-bridge `task-add`), routed to `localFolder` / `root` and
 * marked with `source: {kind: 'agent', key}`; returns its id. `text` must already be
 * {@link taskText}'s.
 *
 * Works on the raw parsed JSON, not {@link readTasks} → {@link writeTasks}, so a bridge built from
 * an older core keeps every field and entry a newer devc wrote. Never overwrites a file it can't
 * read: throws when it is not JSON or its `tasks` is not an array. Throws
 * {@link AgentTaskCapError} when `key` already has {@link MAX_AGENT_TASKS} unsent tasks.
 */
export function appendAgentTask(
  task: { text: string; localFolder: string; root: string; key: string },
  path = TASKS_PATH,
): Promise<string> {
  return withTasksLock(async () => {
    let raw: string | null = null;
    try {
      raw = await readFile(path, 'utf8');
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    const data: unknown = raw === null
      ? { version: 1, tasks: [], sent: [] }
      : JSON.parse(raw);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error(`${path} does not hold a task list`);
    }
    const o = data as Obj;
    if (o.tasks === undefined) o.tasks = [];
    if (!Array.isArray(o.tasks)) {
      throw new Error(`${path}: tasks is not a list`);
    }
    const mine = o.tasks.filter((t) => {
      if (typeof t !== 'object' || t === null) return false;
      const s = (t as Obj).source as Obj | undefined;
      return typeof s === 'object' && s !== null && s.kind === 'agent' &&
        s.key === task.key;
    }).length;
    if (mine >= MAX_AGENT_TASKS) {
      throw new AgentTaskCapError(
        `${MAX_AGENT_TASKS} tasks from this container are waiting; ask the user to send or delete some`,
      );
    }
    const id = crypto.randomUUID();
    o.tasks.push({
      id,
      text: task.text,
      createdAt: new Date().toISOString(),
      localFolder: task.localFolder,
      root: task.root,
      source: { kind: 'agent', key: task.key },
    });
    await writeAtomic(path, JSON.stringify(o, null, 2) + '\n');
    return id;
  }, path);
}

/** A task's text as stored (trimmed), or null when it is empty or too long. */
export function taskText(text: string): string | null {
  const t = text.trim();
  return t === '' || t.length > MAX_TASK_TEXT ? null : t;
}

/** A task's first non-empty line, cut to {@link MAX_TITLE} with `…`. */
export function taskTitle(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ??
    '';
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
}

/** Adds a task at the end. `text` must already be {@link taskText}'s. Pure. */
export function addTask(
  state: TaskState,
  task: { text: string; route?: TaskRoute },
  now: Date,
  newId: () => string = () => crypto.randomUUID(),
): { state: TaskState; id: string } {
  const id = newId();
  return {
    state: {
      ...state,
      tasks: [...state.tasks, {
        id,
        text: task.text,
        createdAt: now.toISOString(),
        ...(task.route ?? {}),
      }],
    },
    id,
  };
}

/**
 * Replaces task `id`'s text and route (none: not routed). A queued task stays queued, in its new
 * route's queue, unless it is no longer routed. Null when there is no such task. Pure.
 */
export function updateTask(
  state: TaskState,
  id: string,
  task: { text: string; route?: TaskRoute },
): TaskState | null {
  if (!state.tasks.some((t) => t.id === id)) return null;
  return {
    ...state,
    tasks: state.tasks.map((t) =>
      t.id === id
        ? {
          id: t.id,
          text: task.text,
          createdAt: t.createdAt,
          ...(task.route ?? {}),
          ...(task.route && t.queued ? { queued: t.queued } : {}),
          ...(t.source ? { source: t.source } : {}),
        }
        : t
    ),
  };
}

/** Removes `id` from either list. Null when it is in neither. Pure. */
export function deleteTask(state: TaskState, id: string): TaskState | null {
  const tasks = state.tasks.filter((t) => t.id !== id);
  const sent = state.sent.filter((t) => t.id !== id);
  if (
    tasks.length === state.tasks.length && sent.length === state.sent.length
  ) return null;
  return { tasks, sent };
}

/** Moves sent task `id` back to the end of the list, routed where it was sent. Null when unknown. Pure. */
export function restoreTask(state: TaskState, id: string): TaskState | null {
  const s = state.sent.find((t) => t.id === id);
  if (!s) return null;
  return {
    tasks: [...state.tasks, {
      id: s.id,
      text: s.text,
      createdAt: s.createdAt,
      localFolder: s.localFolder,
      root: s.root,
    }],
    sent: state.sent.filter((t) => t.id !== id),
  };
}

/**
 * Moves task `id` to `sent`, first, with what it was sent as. Null when it is no longer in the
 * list (another window sent or deleted it). Pure.
 */
export function markSent(
  state: TaskState,
  id: string,
  sent: Omit<SentTask, 'id' | 'text' | 'createdAt'>,
): TaskState | null {
  const t = state.tasks.find((t) => t.id === id);
  if (!t) return null;
  return {
    tasks: state.tasks.filter((x) => x.id !== id),
    sent: [
      { id: t.id, text: t.text, createdAt: t.createdAt, ...sent },
      ...state.sent,
    ],
  };
}

/** Sets sent task `id`'s pane. Null when unknown. Pure. */
export function withSentPane(
  state: TaskState,
  id: string,
  last: { containerId: string; paneId: string },
): TaskState | null {
  if (!state.sent.some((t) => t.id === id)) return null;
  return {
    ...state,
    sent: state.sent.map((t) => t.id === id ? { ...t, last } : t),
  };
}

/** A route's key: no path holds a newline, so no two routes share one. */
export function routeKey(r: TaskRoute): string {
  return `${r.localFolder}\n${r.root}`;
}

/**
 * Queues the routed tasks among `ids` to be sent as `action` to `agent`, each at the end of its
 * repo's queue in `ids`' order. One already queued without an error keeps its place and how it
 * is sent; a failed one is queued again at the end. Unrouted and unknown ids are skipped. Null
 * when no task was queued. Pure.
 */
export function queueTasks(
  state: TaskState,
  ids: string[],
  how: { action: TaskAction; agent: SessionAgentId },
  now: Date,
): TaskState | null {
  const order = new Map<string, number>();
  for (const id of ids) if (!order.has(id)) order.set(id, order.size);
  const base = now.getTime();
  let changed = false;
  const tasks = state.tasks.map((t) => {
    const i = order.get(t.id);
    if (i === undefined || t.localFolder === undefined) return t;
    if (t.queued && t.queued.error === undefined) return t;
    changed = true;
    // A millisecond apart, so the queue keeps `ids`' order however the list is sorted.
    const queuedAt = new Date(base + i).toISOString();
    return { ...t, queued: { ...how, queuedAt } };
  });
  return changed ? { ...state, tasks } : null;
}

/** Takes task `id` out of its queue. Null when it is not queued. Pure. */
export function unqueueTask(state: TaskState, id: string): TaskState | null {
  if (!state.tasks.some((t) => t.id === id && t.queued)) return null;
  return {
    ...state,
    tasks: state.tasks.map((t) => {
      if (t.id !== id) return t;
      const { queued: _, ...rest } = t;
      return rest;
    }),
  };
}

/** Marks queued task `id` failed with `error`, halting its queue. Null when not queued. Pure. */
export function queueFailed(
  state: TaskState,
  id: string,
  error: string,
): TaskState | null {
  if (!state.tasks.some((t) => t.id === id && t.queued)) return null;
  return {
    ...state,
    tasks: state.tasks.map((t) =>
      t.id === id && t.queued ? { ...t, queued: { ...t.queued, error } } : t
    ),
  };
}

/**
 * Each repo's queue, in order: queued tasks by `queuedAt`, ties in list order. Keyed by
 * {@link routeKey}, in the order each queue's first task is on the list.
 */
export function taskQueues(state: TaskState): Map<string, Task[]> {
  const queues = new Map<string, Task[]>();
  for (const t of state.tasks) {
    if (!t.queued || t.localFolder === undefined || t.root === undefined) {
      continue;
    }
    const key = routeKey({ localFolder: t.localFolder, root: t.root });
    const q = queues.get(key);
    if (q) q.push(t);
    else queues.set(key, [t]);
  }
  for (const q of queues.values()) {
    // Stable: ties keep list order.
    q.sort((a, b) => a.queued!.queuedAt.localeCompare(b.queued!.queuedAt));
  }
  return queues;
}

/**
 * The task each repo's queue would send next: its first, unless that one failed (the queue
 * halts on it).
 */
export function queueHeads(state: TaskState): Task[] {
  return [...taskQueues(state).values()].map((q) => q[0]).filter((t) =>
    t.queued!.error === undefined
  );
}

/** What the page is sent: everything but a sent task's `last`, which only the server checks. */
export function tasksMessage(state: TaskState) {
  return {
    type: 'tasks',
    tasks: state.tasks,
    sent: state.sent.map(({ last: _, ...t }) => t),
  };
}
