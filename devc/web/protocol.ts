// The browser ⇄ server WebSocket protocol of `devc web` (`/ws`): JSON text frames, specified in
// `.plans/devc-web.md` § "Browser ⇄ server WebSocket protocol". This module is pure — it
// validates a browser message's shape; whether its container or pane exists is the server's
// check.

import {
  type AgentId,
  isAgentId,
  isSessionAgentId,
  isSessionId,
  isTaskAction,
  type SessionAgentId,
  type TaskAction,
} from './agents.ts';
import { MAX_TASK_TEXT, taskText } from './tasks.ts';
import type { PrMessage } from './pr_review.ts';

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
  /** The page's focused terminal pane, or none: devc-desktop's host terminal `cd`s to its folder; the server focuses it in Herdr. */
  | { type: 'active_pane'; container: string; pane_id: string }
  | { type: 'active_pane' }
  /** Whether the page is visible and its window focused (activity tracking: `activity.ts`). */
  | { type: 'page_state'; visible: boolean; focused: boolean }
  | {
    type:
      | 'start_project'
      | 'stop_project'
      | 'down_project'
      | 'forget_project'
      | 'add_project';
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
  /** Lists the devcontainers (`docker ps`) and reads devc's projects list again. */
  | { type: 'refresh_containers'; id: string }
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
  | {
    type: 'write_file';
    id: string;
    container: string;
    /** A repo folder `path` is relative to; without one, `path` is a container path. */
    root?: string;
    /** An existing file, saved in place. */
    path: string;
    text: string;
    /** The `hash` its last read returned: refused with `conflict` if the file changed since. */
    base?: string;
  }
  | { type: 'locate_file'; id: string; container: string; path: string }
  /**
   * Starts or reuses the language server for a file in an editable tile and attaches this
   * connection to its session: addressed as `write_file` addresses its file.
   */
  | {
    type: 'lsp_attach' | 'lsp_settings_get';
    id: string;
    container: string;
    /** A repo folder `path` is relative to; without one, `path` is a container path. */
    root?: string;
    path: string;
  }
  /** One LSP message for an attached session's server: a plain object, never answered here. */
  | { type: 'lsp_send'; session: string; message: Record<string, unknown> }
  | { type: 'lsp_detach'; session: string }
  | { type: 'lsp_restart'; id: string; session: string }
  /**
   * Sets (or with `entry: null`, removes) the per-project language server settings that apply to
   * a repo file: `entry.root` is checkout-relative and must contain the file.
   */
  | {
    type: 'lsp_settings_set';
    id: string;
    container: string;
    root: string;
    path: string;
    entry: { root: string; options: Record<string, unknown> } | null;
  }
  | {
    type: 'open_in_code';
    id: string;
    localFolder: string;
    /** One of the project's repo folders; `path` is relative to it ('' is the folder). */
    root: string;
    path: string;
  }
  | {
    type: 'open_in_code';
    id: string;
    container: string;
    /** An absolute container path, in one of the project's repos as mounted. */
    path: string;
  }
  | {
    type: 'reveal_path';
    id: string;
    localFolder: string;
    /** One of the project's repo folders; `path` is relative to it ('' is the folder). */
    root: string;
    path: string;
  }
  | {
    type: 'reveal_path';
    id: string;
    container: string;
    /** An absolute container path, in one of the project's repos as mounted. */
    path: string;
  }
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
  /** Makes a repo file the dashboard; `file: null` clears it. */
  | {
    type: 'set_dashboard';
    id: string;
    file: { localFolder: string; root: string; path: string } | null;
  }
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
    type: 'queue_tasks';
    id: string;
    /** Task ids, in the order they are queued. */
    tasks: string[];
    agent: SessionAgentId;
    action: TaskAction;
  }
  | { type: 'unqueue_task'; id: string; task: string }
  | {
    type: 'send_task';
    id: string;
    task: string;
    localFolder: string;
    root: string;
    agent: SessionAgentId;
    action: TaskAction;
  }
  | { type: 'list_sessions'; id: string; container: string }
  | {
    type: 'resume_session';
    id: string;
    container: string;
    agent: SessionAgentId;
    /** The agent's session id: a uuid. */
    session: string;
  }
  | {
    /**
     * A question about a file of repo `root` (one of the container's project's repos), for an
     * agent: the one running in pane `pane_id`, listed session `session` of `agent` (resumed
     * unless running), or, with `agent` alone, a new session of it at the repo.
     */
    type: 'ask_agent';
    id: string;
    container: string;
    root: string;
    /** Trimmed, non-empty, at most `MAX_TASK_TEXT` characters. */
    text: string;
    pane_id?: string;
    agent?: SessionAgentId;
    /** The agent's session id: a uuid. Only with `agent`. */
    session?: string;
  }
  /** A repo's pull request, through its container's devc-bridge (see `pr_review.ts`). */
  | PrMessage & { id: string }
  | { type: 'retry'; container: string }
  | { type: 'client_ready'; generation: string }
  /** Joins a view as its sidebar or its tiling area (`/sidebar`, `/main`): see `views.ts`. */
  | { type: 'view_join'; view: string; role: ViewRole }
  /** The tiling area's `ViewState`, relayed verbatim to the view's sidebars. */
  | { type: 'view_state'; view: string; state: Record<string, unknown> }
  /** A `ViewIntents` call, relayed verbatim to the view's tiling areas. */
  | { type: 'view_intent'; view: string; name: ViewIntentName; args: unknown[] }
  /** A `SidebarIntents` call, relayed verbatim to the view's sidebars. */
  | {
    type: 'sidebar_intent';
    view: string;
    name: SidebarIntentName;
    args: unknown[];
  };

/** A view id: the URL hash's `view`, pairing a `/sidebar` page with a `/main` page. */
export const VIEW_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** What a page joins a view as: `/sidebar` is `sidebar`, `/main` is `tiles`. */
export type ViewRole = 'sidebar' | 'tiles';
/** The `ViewIntents` methods (`static/lib/view.js`) a `view_intent` may name. */
export const VIEW_INTENT_NAMES = [
  'openPane',
  'openFile',
  'openDiff',
  'reveal',
  'close',
  'keepOpen',
  'save',
  'reload',
  'prViewed',
  'askAgent',
  'restartLanguage',
  'languageSettings',
] as const;
export type ViewIntentName = typeof VIEW_INTENT_NAMES[number];
/** The `SidebarIntents` methods (`static/lib/view.js`) a `sidebar_intent` may name. */
export const SIDEBAR_INTENT_NAMES = [
  'revealInContainers',
  'prViewed',
] as const;
export type SidebarIntentName = typeof SIDEBAR_INTENT_NAMES[number];
/** The most arguments a relayed intent carries. */
export const MAX_INTENT_ARGS = 4;
/** The most tiles a relayed `view_state` carries. */
export const MAX_VIEW_TILES = 500;
/** The longest `view_*` / `sidebar_intent` frame, in UTF-16 code units of its text. */
export const MAX_VIEW_MESSAGE = 256 * 1024;
/** The longest `lsp_send` frame, in UTF-16 code units of its text. */
export const MAX_LSP_MESSAGE = 8 * 1024 * 1024;

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

function bool(o: Obj, k: string): boolean {
  const v = o[k];
  if (typeof v !== 'boolean') throw new Invalid(`'${k}' must be a boolean`);
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

function viewId(o: Obj): string {
  const v = o.view;
  if (typeof v !== 'string' || !VIEW_ID.test(v)) {
    throw new Invalid(`'view' must match ${VIEW_ID.source}`);
  }
  return v;
}

function intentArgs(o: Obj): unknown[] {
  const v = o.args;
  if (!Array.isArray(v) || v.length > MAX_INTENT_ARGS) {
    throw new Invalid(`'args' must be an array of at most ${MAX_INTENT_ARGS}`);
  }
  return v;
}

/** A `ViewState`'s shape, as far as the server looks: `tiles` an array, `tree` an object or null. */
function viewState(o: Obj): Record<string, unknown> {
  const v = o.state;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Invalid(`'state' must be an object`);
  }
  const s = v as Obj;
  if (!Array.isArray(s.tiles) || s.tiles.length > MAX_VIEW_TILES) {
    throw new Invalid(
      `'state.tiles' must be an array of at most ${MAX_VIEW_TILES}`,
    );
  }
  if (
    s.tree !== null && (typeof s.tree !== 'object' || Array.isArray(s.tree))
  ) {
    throw new Invalid(`'state.tree' must be an object or null`);
  }
  return s;
}

/** A plain JSON object (not an array, not null). */
function plainObject(o: Obj, k: string): Record<string, unknown> {
  const v = o[k];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Invalid(`'${k}' must be an object`);
  }
  return v as Record<string, unknown>;
}

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

/** The most tasks one `queue_tasks` may name. */
export const MAX_QUEUE_TASKS = 500;

/** `queue_tasks`'s ids: 1 to {@link MAX_QUEUE_TASKS} non-empty strings. */
function taskIds(o: Obj): string[] {
  const v = o.tasks;
  if (
    !Array.isArray(v) || v.length === 0 || v.length > MAX_QUEUE_TASKS ||
    !v.every((t) => typeof t === 'string' && t !== '')
  ) {
    throw new Invalid(
      `'tasks' must be 1 to ${MAX_QUEUE_TASKS} non-empty strings`,
    );
  }
  return v;
}

function pane(o: Obj): { container: string; pane_id: string } {
  return { container: str(o, 'container'), pane_id: str(o, 'pane_id') };
}

/** The longest `container` / `pane_id` an `active_pane` may carry. */
const MAX_ACTIVE_ID = 256;

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
  if (
    (m.type === 'view_join' || m.type === 'view_state' ||
      m.type === 'view_intent' || m.type === 'sidebar_intent') &&
    raw.length > MAX_VIEW_MESSAGE
  ) {
    return {
      ok: false,
      rejection: { code: 'bad_request', message: 'message too large' },
    };
  }
  if (m.type === 'lsp_send' && raw.length > MAX_LSP_MESSAGE) {
    return {
      ok: false,
      rejection: { code: 'bad_request', message: 'message too large' },
    };
  }
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

/**
 * `open_in_code`'s and `reveal_path`'s fields: a repo path (`root` + relative `path`, '' is the
 * root itself) or an absolute container path.
 */
function hostPathFields(
  m: Obj,
):
  | { id: string; localFolder: string; root: string; path: string }
  | { id: string; container: string; path: string } {
  return m.container === undefined
    ? {
      id: str(m, 'id'),
      localFolder: folder(m),
      root: absolute(m, 'root'),
      path: text(m, 'path'),
    }
    : {
      id: str(m, 'id'),
      container: str(m, 'container'),
      path: containerPath(m),
    };
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
    case 'active_pane': {
      if (m.container === undefined && m.pane_id === undefined) {
        return { type: 'active_pane' };
      }
      const p = pane(m);
      if (
        p.container.length > MAX_ACTIVE_ID || p.pane_id.length > MAX_ACTIVE_ID
      ) {
        throw new Invalid(
          `'container' and 'pane_id' must be at most ${MAX_ACTIVE_ID} characters`,
        );
      }
      return { type: 'active_pane', ...p };
    }
    case 'page_state':
      return {
        type: 'page_state',
        visible: bool(m, 'visible'),
        focused: bool(m, 'focused'),
      };
    case 'start_session':
      return {
        type: 'start_session',
        id: str(m, 'id'),
        container: str(m, 'container'),
      };
    case 'start_project':
    case 'stop_project':
    case 'down_project':
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
    case 'refresh_containers':
      return { type: 'refresh_containers', id: str(m, 'id') };
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
    case 'write_file':
      if (
        m.base !== undefined &&
        (typeof m.base !== 'string' || !/^[0-9a-f]{64}$/.test(m.base))
      ) {
        throw new Invalid(`'base' must be a SHA-256 hash in lowercase hex`);
      }
      return {
        type: 'write_file',
        id: str(m, 'id'),
        container: str(m, 'container'),
        ...(m.root === undefined
          ? { path: newEntryPath(m, false) }
          : { root: absolute(m, 'root'), path: newEntryPath(m, true) }),
        text: text(m, 'text'),
        ...(m.base !== undefined ? { base: m.base as string } : {}),
      };
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
    case 'lsp_attach':
    case 'lsp_settings_get':
      return {
        type: m.type,
        id: str(m, 'id'),
        container: str(m, 'container'),
        ...(m.root === undefined
          ? { path: newEntryPath(m, false) }
          : { root: absolute(m, 'root'), path: newEntryPath(m, true) }),
      };
    case 'lsp_send':
      return {
        type: 'lsp_send',
        session: str(m, 'session'),
        message: plainObject(m, 'message'),
      };
    case 'lsp_detach':
      return { type: 'lsp_detach', session: str(m, 'session') };
    case 'lsp_restart':
      return {
        type: 'lsp_restart',
        id: str(m, 'id'),
        session: str(m, 'session'),
      };
    case 'lsp_settings_set': {
      let entry: { root: string; options: Record<string, unknown> } | null =
        null;
      if (m.entry !== null) {
        const e = plainObject(m, 'entry');
        entry = { root: text(e, 'root'), options: plainObject(e, 'options') };
      }
      return {
        type: 'lsp_settings_set',
        id: str(m, 'id'),
        container: str(m, 'container'),
        root: absolute(m, 'root'),
        path: newEntryPath(m, true),
        entry,
      };
    }
    case 'open_in_code':
      return { type: 'open_in_code', ...hostPathFields(m) };
    case 'reveal_path':
      return { type: 'reveal_path', ...hostPathFields(m) };
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
    case 'set_dashboard': {
      if (m.file === null) {
        return { type: 'set_dashboard', id: str(m, 'id'), file: null };
      }
      if (typeof m.file !== 'object' || m.file === undefined) {
        throw new Invalid(`'file' must be an object or null`);
      }
      const f = m.file as Obj;
      return {
        type: 'set_dashboard',
        id: str(m, 'id'),
        file: {
          localFolder: folder(f),
          root: absolute(f, 'root'),
          path: repoPath(f),
        },
      };
    }
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
    case 'unqueue_task':
      return {
        type: m.type,
        id: str(m, 'id'),
        task: str(m, 'task'),
      } as ClientMessage;
    case 'queue_tasks':
      if (!isSessionAgentId(m.agent)) {
        throw new Invalid(`agent '${String(m.agent)}' can't be sent a task`);
      }
      if (!isTaskAction(m.action)) {
        throw new Invalid(`'action' must be one of plan, implement`);
      }
      return {
        type: 'queue_tasks',
        id: str(m, 'id'),
        tasks: taskIds(m),
        agent: m.agent,
        action: m.action,
      };
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
    case 'list_sessions':
      return {
        type: 'list_sessions',
        id: str(m, 'id'),
        container: str(m, 'container'),
      };
    case 'resume_session':
      if (!isSessionAgentId(m.agent)) {
        throw new Invalid(`agent '${String(m.agent)}' can't resume a session`);
      }
      if (!isSessionId(m.session)) {
        throw new Invalid(`'session' must be a uuid`);
      }
      return {
        type: 'resume_session',
        id: str(m, 'id'),
        container: str(m, 'container'),
        agent: m.agent,
        session: m.session,
      };
    case 'ask_agent': {
      if ((m.pane_id === undefined) === (m.agent === undefined)) {
        throw new Invalid(`exactly one of 'pane_id' and 'agent' is required`);
      }
      if (m.agent !== undefined && !isSessionAgentId(m.agent)) {
        throw new Invalid(`agent '${String(m.agent)}' can't be asked`);
      }
      if (m.session !== undefined) {
        if (m.agent === undefined) {
          throw new Invalid(`'session' needs 'agent'`);
        }
        if (!isSessionId(m.session)) {
          throw new Invalid(`'session' must be a uuid`);
        }
      }
      return {
        type: 'ask_agent',
        id: str(m, 'id'),
        container: str(m, 'container'),
        root: absolute(m, 'root'),
        text: taskBody(m),
        ...(m.pane_id !== undefined ? { pane_id: str(m, 'pane_id') } : {}),
        ...(m.agent !== undefined ? { agent: m.agent } : {}),
        ...(m.session !== undefined ? { session: m.session } : {}),
      };
    }
    case 'pr_files':
      return {
        type: 'pr_files',
        id: str(m, 'id'),
        localFolder: folder(m),
        root: absolute(m, 'root'),
      };
    case 'pr_diff':
    case 'pr_threads':
      return {
        type: m.type,
        id: str(m, 'id'),
        localFolder: folder(m),
        root: absolute(m, 'root'),
        path: str(m, 'path'),
      };
    case 'pr_viewed':
      if (typeof m.viewed !== 'boolean') {
        throw new Invalid(`'viewed' must be a boolean`);
      }
      return {
        type: 'pr_viewed',
        id: str(m, 'id'),
        localFolder: folder(m),
        root: absolute(m, 'root'),
        path: str(m, 'path'),
        viewed: m.viewed,
      };
    case 'pr_reply':
      return {
        type: 'pr_reply',
        id: str(m, 'id'),
        localFolder: folder(m),
        root: absolute(m, 'root'),
        path: str(m, 'path'),
        thread: str(m, 'thread'),
        body: text(m, 'body'),
      };
    case 'pr_resolve':
      return {
        type: 'pr_resolve',
        id: str(m, 'id'),
        localFolder: folder(m),
        root: absolute(m, 'root'),
        path: str(m, 'path'),
        thread: str(m, 'thread'),
      };
    case 'pr_file_at':
      if (typeof m.sha !== 'string' || !/^[0-9a-f]{40}$/.test(m.sha)) {
        throw new Invalid(`'sha' must be a commit id (40 lowercase hex)`);
      }
      return {
        type: 'pr_file_at',
        id: str(m, 'id'),
        localFolder: folder(m),
        root: absolute(m, 'root'),
        path: str(m, 'path'),
        sha: m.sha,
      };
    case 'pr_pending_show':
    case 'pr_pending_discard':
      return {
        type: m.type,
        id: str(m, 'id'),
        localFolder: folder(m),
        root: absolute(m, 'root'),
      };
    case 'pr_pending_comment': {
      const line = int(m, 'line', 1);
      if (
        m.startLine !== null &&
        (typeof m.startLine !== 'number' || !Number.isInteger(m.startLine) ||
          m.startLine < 1 || m.startLine >= line)
      ) {
        throw new Invalid(
          `'startLine' must be null or an integer in [1, line)`,
        );
      }
      return {
        type: 'pr_pending_comment',
        id: str(m, 'id'),
        localFolder: folder(m),
        root: absolute(m, 'root'),
        path: str(m, 'path'),
        line,
        side: oneOf(m, 'side', ['LEFT', 'RIGHT']),
        startLine: m.startLine,
        body: text(m, 'body'),
      };
    }
    case 'pr_pending_reply':
      return {
        type: 'pr_pending_reply',
        id: str(m, 'id'),
        localFolder: folder(m),
        root: absolute(m, 'root'),
        thread: str(m, 'thread'),
        body: text(m, 'body'),
      };
    case 'pr_pending_edit':
      return {
        type: 'pr_pending_edit',
        id: str(m, 'id'),
        localFolder: folder(m),
        root: absolute(m, 'root'),
        comment: str(m, 'comment'),
        body: text(m, 'body'),
      };
    case 'pr_pending_delete':
      return {
        type: 'pr_pending_delete',
        id: str(m, 'id'),
        localFolder: folder(m),
        root: absolute(m, 'root'),
        comment: str(m, 'comment'),
      };
    case 'pr_pending_submit':
      return {
        type: 'pr_pending_submit',
        id: str(m, 'id'),
        localFolder: folder(m),
        root: absolute(m, 'root'),
        body: text(m, 'body'),
      };
    case 'retry':
      return { type: 'retry', container: str(m, 'container') };
    case 'client_ready':
      return { type: 'client_ready', generation: str(m, 'generation') };
    case 'view_join':
      return {
        type: 'view_join',
        view: viewId(m),
        role: oneOf(m, 'role', ['sidebar', 'tiles']),
      };
    case 'view_state':
      return { type: 'view_state', view: viewId(m), state: viewState(m) };
    case 'view_intent':
      return {
        type: 'view_intent',
        view: viewId(m),
        name: oneOf(m, 'name', [...VIEW_INTENT_NAMES]),
        args: intentArgs(m),
      };
    case 'sidebar_intent':
      return {
        type: 'sidebar_intent',
        view: viewId(m),
        name: oneOf(m, 'name', [...SIDEBAR_INTENT_NAMES]),
        args: intentArgs(m),
      };
    default:
      throw new Invalid(`unknown message type '${String(m.type)}'`);
  }
}
