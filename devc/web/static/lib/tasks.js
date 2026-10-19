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
