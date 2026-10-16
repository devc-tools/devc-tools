// The browser ⇄ server WebSocket protocol of `devc web` (`/ws`): JSON text frames, specified in
// `.plans/devc-web.md` § "Browser ⇄ server WebSocket protocol". This module is pure — it
// validates a browser message's shape; whether its container or pane exists is the server's
// check.

/** The only Herdr methods a browser `request` may call. */
export const REQUEST_METHODS: ReadonlySet<string> = new Set([
  'tab.create',
  'tab.rename',
  'tab.close',
  'pane.split',
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
  | { type: 'start_session'; id: string; container: string }
  | { type: 'retry'; container: string };

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

function pane(o: Obj): { container: string; pane_id: string } {
  return { container: str(o, 'container'), pane_id: str(o, 'pane_id') };
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
    case 'start_session':
      return {
        type: 'start_session',
        id: str(m, 'id'),
        container: str(m, 'container'),
      };
    case 'retry':
      return { type: 'retry', container: str(m, 'container') };
    default:
      throw new Invalid(`unknown message type '${String(m.type)}'`);
  }
}
