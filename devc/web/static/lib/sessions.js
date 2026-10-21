// The Sessions node's pure helpers: a container's recent agent sessions as `list_sessions`
// answers them (see `devc/web/sessions.ts`), their age text and tooltip. No DOM.

/**
 * @typedef {{agent: 'claude' | 'copilot' | 'pi', session: string, title: string, cwd: string,
 *   root: string, updatedAt: string, pane_id?: string}} AgentSession  `pane_id`: the Herdr pane
 *   a live agent process has it open in
 */

const AGENTS = new Set(['claude', 'copilot', 'pi']);

/**
 * `list_sessions`' result as sessions, in its order; anything malformed is dropped, and a
 * `pane_id` that is no string.
 *
 * @param {unknown} result
 * @returns {AgentSession[]}
 */
export function parseSessions(result) {
  const list = /** @type {{sessions?: unknown} | null} */ (result)?.sessions;
  if (!Array.isArray(list)) return [];
  return list.filter((s) =>
    typeof s === 'object' && s !== null && AGENTS.has(s.agent) &&
    ['session', 'title', 'cwd', 'root', 'updatedAt'].every((k) =>
      typeof s[k] === 'string'
    )
  ).map((s) => {
    if (s.pane_id === undefined || typeof s.pane_id === 'string') return s;
    const { pane_id: _, ...rest } = s;
    return rest;
  });
}

/**
 * How long ago `updatedAt` was: `now` under a minute, else minutes, hours (under a day) or days.
 *
 * @param {string} updatedAt ISO
 * @param {number} now epoch ms
 */
export function sessionAge(updatedAt, now) {
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return '';
  const minutes = Math.floor(Math.max(0, now - t) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * A session row's tooltip.
 *
 * @param {AgentSession} s
 * @param {string} agentLabel
 */
export function sessionTooltip(s, agentLabel) {
  const when = new Date(s.updatedAt);
  const updatedAt = Number.isNaN(when.getTime())
    ? s.updatedAt
    : when.toLocaleString();
  return [
    s.title,
    '',
    `${agentLabel} · ${updatedAt}`,
    s.cwd,
    s.session,
    'Click to resume',
  ].join('\n');
}
