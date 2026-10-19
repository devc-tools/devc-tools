// `devc web`'s task list: to-dos written down on the page and later sent to an agent in their
// project (`send_task`), in `~/.config/devc/tasks.json`. Server-side, as pinned files are, so
// every devc web window shows the same tasks.
//
// Sending is one-way: the host writes the task into the container and starts the agent, and
// nothing in a container writes here. A sent task moves to `sent`, which keeps the agent's
// session id and where it ran, so its session can be found again.

import { dirname } from 'jsr:@std/path';
import { CONFIG_DIR } from '@devc-tools/core/default_config.ts';
import {
  isSessionAgentId,
  isTaskAction,
  type SessionAgentId,
  type TaskAction,
} from './agents.ts';

export const TASKS_PATH = `${CONFIG_DIR}/tasks.json`;

/** How many sent tasks are kept: the newest. */
export const MAX_SENT = 50;

/** The longest a task's text may be, in UTF-16 code units, once trimmed. */
export const MAX_TASK_TEXT = 20_000;

/** How long a task's title (its first line) may be before it is cut. */
const MAX_TITLE = 80;

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
      ? { localFolder: t.localFolder, root: t.root }
      : {}),
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
    data = JSON.parse(await Deno.readTextFile(path));
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
  const dir = dirname(path);
  await Deno.mkdir(dir, { recursive: true });
  const tmp = await Deno.makeTempFile({ dir, prefix: '.tasks-' });
  try {
    const file: TasksFile = {
      version: 1,
      tasks: state.tasks,
      sent: trimSent(state.sent),
    };
    await Deno.writeTextFile(tmp, JSON.stringify(file, null, 2) + '\n');
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
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

/** Replaces task `id`'s text and route (none: not routed). Null when there is no such task. Pure. */
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

/** What the page is sent: everything but a sent task's `last`, which only the server checks. */
export function tasksMessage(state: TaskState) {
  return {
    type: 'tasks',
    tasks: state.tasks,
    sent: state.sent.map(({ last: _, ...t }) => t),
  };
}
