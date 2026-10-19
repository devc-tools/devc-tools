// Pure helpers for the page's Tasks section (the `tasks` message), tested from
// `devc/tests/web_tasks_page_test.ts`. A *task* is a to-do on the list; a *sent task* is one
// already handed to an agent, kept with that agent's session.

/**
 * A task as the page knows it. A route is both `localFolder` and `root`, or neither.
 *
 * @typedef {{id: string, text: string, createdAt: string, localFolder?: string,
 *   root?: string}} Task
 */

/**
 * A sent task: where it went and the session it started.
 *
 * @typedef {{id: string, text: string, createdAt: string, action: 'plan' | 'implement',
 *   agent: TaskAgentId, sentAt: string, localFolder: string, root: string, cwd: string,
 *   sessionId: string}} SentTask
 */

/** @typedef {'claude' | 'copilot' | 'pi'} TaskAgentId */

/** The agents a task can be sent to: those the server can start with a session id of its own. */
export const TASK_AGENT_IDS =
  /** @type {const} */ (['claude', 'copilot', 'pi']);

/** The longest title, as the server cuts it for the pane's name. */
const MAX_TITLE = 80;

/** @param {unknown} v */
const nonEmpty = (v) => typeof v === 'string' && v !== '';

/**
 * The tasks and sent tasks of a `tasks` message, in their order. Malformed entries are dropped.
 *
 * @param {unknown} msg
 * @returns {{tasks: Task[], sent: SentTask[]}}
 */
export function parseTasks(msg) {
  const m = /** @type {{tasks?: unknown, sent?: unknown} | null} */ (msg);
  /** @type {Task[]} */
  const tasks = [];
  for (const t of Array.isArray(m?.tasks) ? m.tasks : []) {
    if (typeof t !== 'object' || t === null) continue;
    const { id, text, createdAt, localFolder, root } = t;
    if (!nonEmpty(id) || !nonEmpty(text) || !nonEmpty(createdAt)) continue;
    const routed = nonEmpty(localFolder) && nonEmpty(root);
    tasks.push({
      id,
      text,
      createdAt,
      ...(routed ? { localFolder, root } : {}),
    });
  }
  /** @type {SentTask[]} */
  const sent = [];
  for (const t of Array.isArray(m?.sent) ? m.sent : []) {
    if (typeof t !== 'object' || t === null) continue;
    const {
      id,
      text,
      createdAt,
      action,
      agent,
      sentAt,
      localFolder,
      root,
      cwd,
      sessionId,
    } = t;
    if (
      !nonEmpty(id) || !nonEmpty(text) || !nonEmpty(createdAt) ||
      (action !== 'plan' && action !== 'implement') ||
      !TASK_AGENT_IDS.includes(agent) || !nonEmpty(sentAt) ||
      !nonEmpty(localFolder) || !nonEmpty(root) || !nonEmpty(cwd) ||
      !nonEmpty(sessionId)
    ) continue;
    sent.push({
      id,
      text,
      createdAt,
      action,
      agent,
      sentAt,
      localFolder,
      root,
      cwd,
      sessionId,
    });
  }
  return { tasks, sent };
}

/**
 * A task's first non-empty line, cut with `…`: what its row and its agent's pane are named.
 *
 * @param {string} text
 */
export function taskTitle(text) {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ??
    '';
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
}

/**
 * Tasks grouped by route, for the Tasks section's nodes: one group per project and repo, in the
 * order of each route's first task, then the unrouted ones (key `''`). Each group keeps the
 * tasks' order; no group is empty.
 *
 * @param {Task[]} tasks in creation order
 * @returns {{key: string, localFolder?: string, root?: string, tasks: Task[]}[]}
 */
export function groupTasks(tasks) {
  /** @type {Map<string, {key: string, localFolder?: string, root?: string, tasks: Task[]}>} */
  const groups = new Map();
  /** @type {Task[]} */
  const unrouted = [];
  for (const task of tasks) {
    const { localFolder, root } = task;
    if (localFolder === undefined || root === undefined) {
      unrouted.push(task);
      continue;
    }
    // Paths never hold a newline, so no two routes share a key.
    const key = `${localFolder}\n${root}`;
    let group = groups.get(key);
    if (!group) groups.set(key, group = { key, localFolder, root, tasks: [] });
    group.tasks.push(task);
  }
  const out = [...groups.values()];
  if (unrouted.length) out.push({ key: '', tasks: unrouted });
  return out;
}

/**
 * The agent the task dialog starts on: the one saved from the last send, else Claude.
 *
 * @param {string | null} saved
 * @returns {TaskAgentId}
 */
export function savedTaskAgent(saved) {
  return TASK_AGENT_IDS.includes(/** @type {any} */ (saved))
    ? /** @type {TaskAgentId} */ (saved)
    : 'claude';
}

/**
 * The default for new tasks, pinned in the task dialog: a route (both `localFolder` and `root`,
 * or neither) and an agent. `null` for anything else, including an unknown agent.
 *
 * @typedef {{localFolder?: string, root?: string, agent: TaskAgentId}} TaskDefault
 * @param {string | null} text
 * @returns {TaskDefault | null}
 */
export function parseTaskDefault(text) {
  let v;
  try {
    v = JSON.parse(text ?? '');
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  if (!TASK_AGENT_IDS.includes(v.agent)) return null;
  return nonEmpty(v.localFolder) && nonEmpty(v.root)
    ? { localFolder: v.localFolder, root: v.root, agent: v.agent }
    : { agent: v.agent };
}

/**
 * A sent task's tooltip: what it was sent as, when, and where the agent started.
 *
 * @param {SentTask} s
 * @param {string} agentLabel
 */
export function sentTaskTooltip(s, agentLabel) {
  const when = new Date(s.sentAt);
  const sentAt = Number.isNaN(when.getTime())
    ? s.sentAt
    : when.toLocaleString();
  return [
    s.text,
    '',
    `${s.action === 'plan' ? 'Plan' : 'Implement'} · ${agentLabel} · ${sentAt}`,
    s.cwd,
    'Click to open its session',
  ].join('\n');
}
