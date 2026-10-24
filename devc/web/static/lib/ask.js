// Asking an agent about the file in a file or diff tile (`ask_agent`): the text sent, which names
// the file, the lines and the selected code after the question, and the agents it can go to — one
// running in a terminal at the file's repo, a past session of the repo, or a new one. Pure, no
// DOM: `ask.js` builds the dialog from these.

/** The longest text `ask_agent` takes: the server's `MAX_TASK_TEXT`. */
export const MAX_ASK_TEXT = 20_000;

/** How much of a selection goes into the text; the rest is cut, and says so. */
export const MAX_ASK_SELECTION = 12_000;

/** The agents a new session can be started as: those `ask_agent` takes with `agent`. */
export const ASK_AGENT_IDS = /** @type {const} */ (['claude', 'copilot', 'pi']);

/**
 * What a question is about: `path` as the agent finds it from the repo it runs at (relative to
 * the repo, or an absolute container path), the selected `text` and the 1-based lines it spans,
 * when there is one, and whether it was selected in the pull request's diff.
 *
 * @typedef {{path: string, selection?: {text: string, startLine?: number, endLine?: number},
 *   diff?: boolean}} AskContext
 */

/**
 * Where a question is about, for the dialog and the text: the path in backticks, then its lines.
 *
 * @param {AskContext} ctx
 */
export function askWhere(ctx) {
  const { startLine, endLine } = ctx.selection ?? {};
  let where = `\`${ctx.path}\``;
  if (typeof startLine === 'number') {
    where += typeof endLine === 'number' && endLine > startLine
      ? `, lines ${startLine}–${endLine}`
      : `, line ${startLine}`;
  }
  return ctx.diff ? `${where}, in the pull request's diff` : where;
}

/**
 * The text sent: the question (trimmed) first, so it titles a new session, then what it is about,
 * with the selection (cut to {@link MAX_ASK_SELECTION}) fenced by more backticks than it holds.
 * `includeSelection` false leaves the selection, and its lines, out.
 *
 * @param {string} question @param {AskContext} ctx @param {boolean} [includeSelection]
 */
export function askText(question, ctx, includeSelection = true) {
  const sel = includeSelection ? ctx.selection : undefined;
  const about = askWhere(sel ? ctx : { ...ctx, selection: undefined });
  const lines = [question.trim(), ''];
  if (!sel || sel.text === '') {
    lines.push(`About ${about}.`);
    return lines.join('\n');
  }
  const cut = sel.text.length > MAX_ASK_SELECTION;
  const code = cut ? sel.text.slice(0, MAX_ASK_SELECTION) : sel.text;
  const longest = Math.max(
    0,
    ...[...code.matchAll(/`+/g)].map((m) => m[0].length),
  );
  const fence = '`'.repeat(Math.max(3, longest + 1));
  lines.push(
    `About ${about}${cut ? ' (the selection, cut short)' : ''}:`,
    '',
    fence,
    code.replace(/\n$/, ''),
    fence,
  );
  return lines.join('\n');
}

/**
 * Where a question can go: an agent running in a terminal (`pane`), a past session (`session`,
 * resumed on it), or a new session (`new`). `label` is what the picker shows; `agent` its icon.
 *
 * @typedef {{kind: 'pane', key: string, pane_id: string, agent: string, label: string}
 *   | {kind: 'session', key: string, agent: 'claude' | 'copilot' | 'pi', session: string,
 *     label: string}
 *   | {kind: 'new', key: string, agent: 'claude' | 'copilot' | 'pi', label: string}} AskTarget
 */

/**
 * The targets for a question about repo `root`, in the picker's order: the agents running at the
 * repo (`panes`, in their order; a listed session's title names its pane), then the repo's past
 * sessions not running in one of them (`sessions`, in `list_sessions`' order, newest first), then
 * a new session of each of {@link ASK_AGENT_IDS}.
 *
 * @param {{pane_id: string, agent: string, label: string}[]} panes  agent panes at the repo
 * @param {import('./sessions.js').AgentSession[]} sessions  the container's listed sessions
 * @param {string} root  the repo's host folder (a session's `root`)
 * @param {Record<string, string>} agentLabels  agent id → name
 * @returns {AskTarget[]}
 */
export function askTargets(panes, sessions, root, agentLabels) {
  const ofRepo = sessions.filter((s) => s.root === root);
  const titles = new Map(
    ofRepo.filter((s) => s.pane_id).map((s) => [s.pane_id, s.title]),
  );
  const paneIds = new Set(panes.map((p) => p.pane_id));
  return [
    ...panes.map((p) => /** @type {AskTarget} */ ({
      kind: 'pane',
      key: `pane:${p.pane_id}`,
      pane_id: p.pane_id,
      agent: p.agent,
      label: titles.get(p.pane_id) || p.label,
    })),
    ...ofRepo.filter((s) => !(s.pane_id && paneIds.has(s.pane_id))).map((
      s,
    ) => /** @type {AskTarget} */ ({
      kind: 'session',
      key: `session:${s.agent}:${s.session}`,
      agent: s.agent,
      session: s.session,
      label: s.title,
    })),
    ...ASK_AGENT_IDS.map((agent) => /** @type {AskTarget} */ ({
      kind: 'new',
      key: `new:${agent}`,
      agent,
      label: `New ${agentLabels[agent] ?? agent} session`,
    })),
  ];
}

/**
 * The target the picker starts on: `saved` (the key last asked from this repo) while it is still
 * offered, else the first running agent, else a new Claude session.
 *
 * @param {AskTarget[]} targets @param {string | null | undefined} saved
 */
export function defaultAskTarget(targets, saved) {
  return targets.find((t) => t.key === saved) ??
    targets.find((t) => t.kind === 'pane') ??
    targets.find((t) => t.key === 'new:claude') ?? targets[0] ?? null;
}

/**
 * `ask_agent`'s target fields for `t`.
 *
 * @param {AskTarget} t
 * @returns {{pane_id: string} | {agent: string, session?: string}}
 */
export function askTargetFields(t) {
  if (t.kind === 'pane') return { pane_id: t.pane_id };
  if (t.kind === 'session') return { agent: t.agent, session: t.session };
  return { agent: t.agent };
}
