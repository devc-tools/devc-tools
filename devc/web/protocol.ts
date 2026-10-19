// The browser ⇄ server WebSocket protocol of `devc web` (`/ws`): JSON text frames, specified in
// `.plans/devc-web.md` § "Browser ⇄ server WebSocket protocol". This module is pure — it
// validates a browser message's shape; whether its container or pane exists is the server's
// check.

import {
  type AgentId,
  isAgentId,
  isSessionAgentId,
  isTaskAction,
  type SessionAgentId,
  type TaskAction,
} from './agents.ts';
import { MAX_TASK_TEXT, taskText } from './tasks.ts';

/** The only Herdr methods a browser `request` may call. */
export const REQUEST_METHODS: ReadonlySet<string> = new Set([
  'pane.rename',
  'pane.close',
]);

export type ClientMessage =
  | {
    type: 'open';
    id: string;
    container: string;
    pane_id: string;
    cols: number;
    rows: number;
  }
  | { type: 'close'; container: string; pane_id: string }
  | { type: 'input'; container: string; pane_id: string; bytes: string }
  | {
    type: 'resize';
    container: string;
    pane_id: string;
    cols: number;
    rows: number;
  }
  | {
    type: 'scroll';
    container: string;
    pane_id: string;
    direction: 'up' | 'down';
    lines: number;
  }
  | {
    type: 'mouse';
    container: string;
    pane_id: string;
    action: 'down' | 'up' | 'drag' | 'move';
    button?: 'left' | 'right' | 'middle';
    column: number;
    row: number;
  }
  | {
    type: 'request';
    id: string;
    container: string;
    method: string;
    params: Record<string, unknown>;
  }
  | {
    type: 'new_shell';
    id: string;
    container: string;
    workspace_id?: string;
    cwd?: string;
  }
  | {
    type: 'read_selection';
    id: string;
    container: string;
    pane_id: string;
    anchor: Cell;
    cursor: Cell;
  }
  | { type: 'start_session'; id: string; container: string }
  | {
    type: 'start_project' | 'stop_project' | 'forget_project' | 'add_project';
    id: string;
    localFolder: string;
  }
  | { type: 'pin_project'; id: string; localFolder: string; pinned: boolean }
  | {
    type: 'list_dir';
    id: string;
    localFolder: string;
    root: string;
    path: string;
  }
  | { type: 'list_host_dir'; id: string; path: string }
  | {
    type: 'read_file';
    id: string;
    localFolder: string;
    root: string;
    path: string;
  }
  | {
    type: 'preview_file';
    id: string;
    localFolder: string;
    root: string;
    path: string;
  }
  | {
    type: 'open_file';
    id: string;
    container: string;
    /** A repo folder `path` is relative to; without one, `path` is a container path. */
    root?: string;
    path: string;
  }
  | {
    type: 'create_file';
    id: string;
    container: string;
    /** A repo folder `path` is relative to; without one, `path` is a container path. */
    root?: string;
    /** The new entry's path. Its parent must exist. */
    path: string;
    kind: 'file' | 'dir';
  }
  | {
    type: 'rename_file';
    id: string;
    container: string;
    /** A repo folder `path` is relative to; without one, `path` is a container path. */
    root?: string;
    /** The entry to rename: a file, a link or a folder, never the root itself. */
    path: string;
    /** Its new name, in the same folder: one path segment. */
    to: string;
  }
  | {
    type: 'delete_file';
    id: string;
    container: string;
    /** A repo folder `path` is relative to; without one, `path` is a container path. */
    root?: string;
    /** The entry to delete (a folder with everything in it), never the root itself. */
    path: string;
  }
  | { type: 'locate_file'; id: string; container: string; path: string }
  | {
    type: 'pin_file';
    id: string;
    localFolder: string;
    /** One of the project's repo folders; `path` is relative to it. */
    root: string;
    path: string;
    label?: string;
  }
  | { type: 'unpin_file'; id: string; pin: string }
  | { type: 'open_pinned'; id: string; pin: string }
  | { type: 'rename_pin'; id: string; pin: string; label: string }
  | {
    type:
      | 'list_container_dir'
      | 'read_container_file'
      | 'preview_container_file';
    id: string;
    container: string;
    /** An absolute path inside the container. */
    path: string;
  }
  | {
    type: 'open_tab';
    id: string;
    container: string;
    root: string;
    path: string;
    reuse: boolean;
    /** Start this agent in the new tab (never with `reuse`). */
    agent?: AgentId;
  }
  | {
    type: 'add_task';
    id: string;
    /** Trimmed, non-empty. */
    text: string;
    /** The route: both or neither. */
    localFolder?: string;
    root?: string;
  }
  | {
    type: 'update_task';
    id: string;
    task: string;
    text: string;
    localFolder?: string;
    root?: string;
  }
  | { type: 'delete_task'; id: string; task: string }
  | { type: 'restore_task'; id: string; task: string }
  | { type: 'open_sent'; id: string; task: string }
  | {
    type: 'send_task';
    id: string;
    task: string;
    localFolder: string;
    root: string;
    agent: SessionAgentId;
    action: TaskAction;
  }
  | { type: 'retry'; container: string }
  | { type: 'client_ready'; generation: string };

/** A viewport cell, zero-based: the same space as `mouse`. */
export type Cell = { column: number; row: number };

/** A rejected message. `id` is set when the message carried one, so it can be answered. */
export interface Rejection {
  id?: string;
  code: 'bad_request' | 'method_not_allowed';
  message: string;
}

export type ParseResult =
  | { ok: true; msg: ClientMessage }
  | { ok: false; rejection: Rejection };

/** The `result` reply to a rejection. */
export function rejectionReply(
  r: Rejection & { id: string },
): Record<string, unknown> {
  return {
    type: 'result',
    id: r.id,
    ok: false,
    error: { code: r.code, message: r.message },
  };
}

class Invalid extends Error {}
class NotAllowed extends Invalid {}

type Obj = Record<string, unknown>;

function str(o: Obj, k: string): string {
  const v = o[k];
  if (typeof v !== 'string' || v === '') {
    throw new Invalid(`'${k}' must be a non-empty string`);
  }
  return v;
}

/** A string that may be empty: a path where '' means the root. */
function text(o: Obj, k: string): string {
  const v = o[k];
  if (typeof v !== 'string') throw new Invalid(`'${k}' must be a string`);
  return v;
}

function int(o: Obj, k: string, min: number): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    throw new Invalid(`'${k}' must be an integer >= ${min}`);
  }
  return v;
}

function oneOf<T extends string>(o: Obj, k: string, values: T[]): T {
  const v = o[k];
  if (typeof v !== 'string' || !values.includes(v as T)) {
    throw new Invalid(`'${k}' must be one of ${values.join(', ')}`);
  }
  return v as T;
}

const MAX_CELLS = 10_000;

/** A host folder: an absolute path. */
function absolute(o: Obj, k: string): string {
  const v = str(o, k);
  if (!v.startsWith('/')) throw new Invalid(`'${k}' must be absolute`);
  return v;
}

/** A project's host folder: an absolute path. */
function folder(o: Obj): string {
  return absolute(o, 'localFolder');
}

/** A path inside a container: absolute, with no `..` segment and no NUL (it goes in argv). */
function containerPath(o: Obj): string {
  const v = absolute(o, 'path');
  if (v.split('/').includes('..')) {
    throw new Invalid(`'path' must not contain '..'`);
  }
  if (v.includes('\0')) throw new Invalid(`'path' must not contain NUL`);
  return v;
}

/**
 * A `create_file`, `rename_file` or `delete_file` path: its last segment is a name (not empty, `.` or `..`), and nothing in it is
 * NUL. With a `root`, relative with no `..` segment; without, a {@link containerPath}.
 */
function newEntryPath(o: Obj, rooted: boolean): string {
  const v = rooted ? str(o, 'path') : containerPath(o);
  if (rooted) {
    if (v.startsWith('/')) throw new Invalid(`'path' must be relative`);
    if (v.split('/').includes('..')) {
      throw new Invalid(`'path' must not contain '..'`);
    }
    if (v.includes('\0')) throw new Invalid(`'path' must not contain NUL`);
  }
  const name = v.slice(v.lastIndexOf('/') + 1);
  if (name === '' || name === '.' || name === '..') {
    throw new Invalid(`'path' must end in a name`);
  }
  return v;
}

/** A new name for `rename_file`: one path segment, not `.` or `..`, with no NUL. */
function entryName(o: Obj, key: string): string {
  const v = str(o, key);
  if (v === '' || v === '.' || v === '..' || v.includes('/')) {
    throw new Invalid(`'${key}' must be a name`);
  }
  if (v.includes('\0')) throw new Invalid(`'${key}' must not contain NUL`);
  return v;
}

/** A repo file's path for a file pin: relative, with no `..` segment and no NUL. */
function repoPath(o: Obj): string {
  const v = str(o, 'path');
  if (v.startsWith('/')) throw new Invalid(`'path' must be relative`);
  if (v.split('/').includes('..')) {
    throw new Invalid(`'path' must not contain '..'`);
  }
  if (v.includes('\0')) throw new Invalid(`'path' must not contain NUL`);
  return v;
}

/** A task's text, trimmed: not empty, at most {@link MAX_TASK_TEXT}. */
function taskBody(o: Obj): string {
  const t = taskText(text(o, 'text'));
  if (t === null) {
    throw new Invalid(
      `'text' must be 1 to ${MAX_TASK_TEXT} characters, once trimmed`,
    );
  }
  return t;
}

/** A task's route: `localFolder` and `root` together, or neither. */
function taskRoute(o: Obj): { localFolder?: string; root?: string } {
  if (o.localFolder === undefined && o.root === undefined) return {};
  if (o.localFolder === undefined || o.root === undefined) {
    throw new Invalid(`'localFolder' and 'root' go together`);
  }
  return { localFolder: folder(o), root: absolute(o, 'root') };
}

function pane(o: Obj): { container: string; pane_id: string } {
  return { container: str(o, 'container'), pane_id: str(o, 'pane_id') };
}

/** Herdr's `pane.selection.read` takes a `u16` column. */
const MAX_COLUMN = 65535;

function cell(o: Obj, k: string): Cell {
  const v = o[k];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Invalid(`'${k}' must be an object`);
  }
  const c = {
    column: int(v as Obj, 'column', 0),
    row: int(v as Obj, 'row', 0),
  };
  if (c.column > MAX_COLUMN || c.row > MAX_CELLS) {
    throw new Invalid(`'${k}' out of range`);
  }
  return c;
}

function size(o: Obj): { cols: number; rows: number } {
  const cols = int(o, 'cols', 1);
  const rows = int(o, 'rows', 1);
  if (cols > MAX_CELLS || rows > MAX_CELLS) {
    throw new Invalid('cols/rows out of range');
  }
  return { cols, rows };
}

/** Validates one browser message (the raw text frame). Never throws. */
export function parseClientMessage(raw: string): ParseResult {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      rejection: { code: 'bad_request', message: 'not valid JSON' },
    };
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) {
    return {
      ok: false,
      rejection: { code: 'bad_request', message: 'not a JSON object' },
    };
  }
  const m = o as Obj;
  const id = typeof m.id === 'string' && m.id !== '' ? m.id : undefined;
  try {
    return { ok: true, msg: parseFields(m) };
  } catch (e) {
    if (!(e instanceof Invalid)) throw e;
    return {
      ok: false,
      rejection: {
        ...(id !== undefined ? { id } : {}),
        code: e instanceof NotAllowed ? 'method_not_allowed' : 'bad_request',
        message: e.message,
      },
    };
  }
}

function parseFields(m: Obj): ClientMessage {
  switch (m.type) {
    case 'open':
      return { type: 'open', id: str(m, 'id'), ...pane(m), ...size(m) };
    case 'close':
      return { type: 'close', ...pane(m) };
    case 'input':
      return { type: 'input', ...pane(m), bytes: str(m, 'bytes') };
    case 'resize':
      return { type: 'resize', ...pane(m), ...size(m) };
    case 'scroll':
      return {
        type: 'scroll',
        ...pane(m),
        direction: oneOf(m, 'direction', ['up', 'down']),
        lines: int(m, 'lines', 1),
      };
    case 'mouse': {
      const action = oneOf(m, 'action', ['down', 'up', 'drag', 'move']);
      const button = m.button === undefined
        ? undefined
        : oneOf(m, 'button', ['left', 'right', 'middle']);
      if (button === undefined && action !== 'move') {
        throw new Invalid(`'button' is required for '${action}'`);
      }
      return {
        type: 'mouse',
        ...pane(m),
        action,
        ...(button !== undefined ? { button } : {}),
        column: int(m, 'column', 0),
        row: int(m, 'row', 0),
      };
    }
    case 'request': {
      const id = str(m, 'id');
      const container = str(m, 'container');
      const method = str(m, 'method');
      if (!REQUEST_METHODS.has(method)) {
        throw new NotAllowed(`method '${method}' is not allowed`);
      }
      const params = m.params ?? {};
      if (
        typeof params !== 'object' || params === null || Array.isArray(params)
      ) {
        throw new Invalid(`'params' must be an object`);
      }
      return { type: 'request', id, container, method, params: params as Obj };
    }
    case 'new_shell':
      return {
        type: 'new_shell',
        id: str(m, 'id'),
        container: str(m, 'container'),
        ...(m.workspace_id !== undefined
          ? { workspace_id: str(m, 'workspace_id') }
          : {}),
        ...(m.cwd !== undefined ? { cwd: str(m, 'cwd') } : {}),
      };
    case 'read_selection':
      return {
        type: 'read_selection',
        id: str(m, 'id'),
        ...pane(m),
        anchor: cell(m, 'anchor'),
        cursor: cell(m, 'cursor'),
      };
    case 'start_session':
      return {
        type: 'start_session',
        id: str(m, 'id'),
        container: str(m, 'container'),
      };
    case 'start_project':
    case 'stop_project':
    case 'forget_project':
    case 'add_project':
      return { type: m.type, id: str(m, 'id'), localFolder: folder(m) };
    case 'pin_project':
      if (typeof m.pinned !== 'boolean') {
        throw new Invalid(`'pinned' must be a boolean`);
      }
      return {
        type: 'pin_project',
        id: str(m, 'id'),
        localFolder: folder(m),
        pinned: m.pinned,
      };
    case 'list_dir':
      return {
        type: 'list_dir',
        id: str(m, 'id'),
        localFolder: folder(m),
        root: absolute(m, 'root'),
        path: text(m, 'path'),
      };
    case 'list_host_dir':
      return { type: 'list_host_dir', id: str(m, 'id'), path: text(m, 'path') };
    case 'read_file':
    case 'preview_file':
      return {
        type: m.type,
        id: str(m, 'id'),
        localFolder: folder(m),
        root: absolute(m, 'root'),
        path: str(m, 'path'),
      };
    case 'open_file':
      return {
        type: 'open_file',
        id: str(m, 'id'),
        container: str(m, 'container'),
        ...(m.root === undefined
          ? { path: containerPath(m) }
          : { root: absolute(m, 'root'), path: str(m, 'path') }),
      };
    case 'create_file':
      return {
        type: 'create_file',
        id: str(m, 'id'),
        container: str(m, 'container'),
        ...(m.root === undefined
          ? { path: newEntryPath(m, false) }
          : { root: absolute(m, 'root'), path: newEntryPath(m, true) }),
        kind: oneOf(m, 'kind', ['file', 'dir']),
      };
    case 'rename_file':
    case 'delete_file':
      return {
        type: m.type,
        id: str(m, 'id'),
        container: str(m, 'container'),
        ...(m.root === undefined
          ? { path: newEntryPath(m, false) }
          : { root: absolute(m, 'root'), path: newEntryPath(m, true) }),
        ...(m.type === 'rename_file' ? { to: entryName(m, 'to') } : {}),
      } as ClientMessage;
    case 'locate_file': {
      const path = absolute(m, 'path');
      if (path.split('/').includes('..')) {
        throw new Invalid(`'path' must not contain '..'`);
      }
      return {
        type: 'locate_file',
        id: str(m, 'id'),
        container: str(m, 'container'),
        path,
      };
    }
    case 'pin_file':
      return {
        type: 'pin_file',
        id: str(m, 'id'),
        localFolder: folder(m),
        root: absolute(m, 'root'),
        path: repoPath(m),
        ...(m.label !== undefined && m.label !== ''
          ? { label: text(m, 'label') }
          : {}),
      };
    case 'unpin_file':
    case 'open_pinned':
      return { type: m.type, id: str(m, 'id'), pin: str(m, 'pin') };
    case 'rename_pin':
      return {
        type: 'rename_pin',
        id: str(m, 'id'),
        pin: str(m, 'pin'),
        label: text(m, 'label'),
      };
    case 'list_container_dir':
    case 'read_container_file':
    case 'preview_container_file':
      return {
        type: m.type,
        id: str(m, 'id'),
        container: str(m, 'container'),
        path: containerPath(m),
      };
    case 'open_tab':
      if (typeof m.reuse !== 'boolean') {
        throw new Invalid(`'reuse' must be a boolean`);
      }
      if (m.agent !== undefined && !isAgentId(m.agent)) {
        throw new Invalid(`unknown agent '${String(m.agent)}'`);
      }
      if (m.agent !== undefined && m.reuse) {
        throw new Invalid(`'agent' needs 'reuse: false'`);
      }
      return {
        type: 'open_tab',
        id: str(m, 'id'),
        container: str(m, 'container'),
        root: absolute(m, 'root'),
        path: text(m, 'path'),
        reuse: m.reuse,
        ...(m.agent !== undefined ? { agent: m.agent } : {}),
      };
    case 'add_task':
      return {
        type: 'add_task',
        id: str(m, 'id'),
        text: taskBody(m),
        ...taskRoute(m),
      };
    case 'update_task':
      return {
        type: 'update_task',
        id: str(m, 'id'),
        task: str(m, 'task'),
        text: taskBody(m),
        ...taskRoute(m),
      };
    case 'delete_task':
    case 'restore_task':
    case 'open_sent':
      return {
        type: m.type,
        id: str(m, 'id'),
        task: str(m, 'task'),
      } as ClientMessage;
    case 'send_task':
      if (!isSessionAgentId(m.agent)) {
        throw new Invalid(`agent '${String(m.agent)}' can't be sent a task`);
      }
      if (!isTaskAction(m.action)) {
        throw new Invalid(`'action' must be one of plan, implement`);
      }
      return {
        type: 'send_task',
        id: str(m, 'id'),
        task: str(m, 'task'),
        localFolder: folder(m),
        root: absolute(m, 'root'),
        agent: m.agent,
        action: m.action,
      };
    case 'retry':
      return { type: 'retry', container: str(m, 'container') };
    case 'client_ready':
      return { type: 'client_ready', generation: str(m, 'generation') };
    default:
      throw new Invalid(`unknown message type '${String(m.type)}'`);
  }
}
