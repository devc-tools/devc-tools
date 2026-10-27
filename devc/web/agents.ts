// The coding agents the page can start in a new terminal (`open_tab` with `agent`). The page
// sends an id; the command typed into the new tab's shell comes from this table only, so
// nothing the page sends is ever run. Ids are Herdr's agent ids (`pane.agent`), the same ones
// `KIND_TABLE` in `herdr.ts` maps commands to, and the ones `static/lib/agent_icons.js` draws.
// Pure: `protocol.ts` validates ids with it.

export type AgentId = 'claude' | 'copilot' | 'pi' | 'opencode';

/** Agent id → the command typed into the new tab's shell: bare, as `devc claude` runs it. */
export const AGENT_COMMANDS: Readonly<Record<AgentId, string>> = {
  claude: 'claude',
  copilot: 'copilot',
  pi: 'pi',
  opencode: 'opencode',
};

export function isAgentId(v: unknown): v is AgentId {
  return typeof v === 'string' && Object.hasOwn(AGENT_COMMANDS, v);
}

// Agents a task can be sent to (`send_task`): those whose CLI takes a session id chosen at
// launch, so the task's Sent entry can find the session again. opencode can only continue a
// session it already has. Every command is built from fixed text and the server's uuid; the
// task's own text goes in a file (`taskFilePath`), never on the command line. The one exception
// is Claude's session name, its title cut down by `sessionName` to text no shell reads anything
// in when it is single-quoted.

// The agent and action types live with the task store in core, which the devc-bridge host also
// writes through.
import type { SessionAgentId, TaskAction } from '@devc-tools/core/tasks.ts';
export {
  isSessionAgentId,
  isTaskAction,
  type SessionAgentId,
  type TaskAction,
} from '@devc-tools/core/tasks.ts';

/** The folder in the container a sent task's text is written to. */
export const TASK_FILE_DIR = '/tmp/devc-tasks';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `v` is a session id as the agents' commands take one: a lowercase uuid. */
export function isSessionId(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}

function checkedUuid(sessionId: string): string {
  if (!isSessionId(sessionId)) throw new Error(`not a uuid: ${sessionId}`);
  return sessionId;
}

/** Where a sent task's text is written in the container: named by its session id. */
export function taskFilePath(sessionId: string): string {
  return `${TASK_FILE_DIR}/${checkedUuid(sessionId)}.md`;
}

/** Where a queued task's agent writes its outcome (see {@link taskOutcome}). */
export function taskResultPath(sessionId: string): string {
  return `${TASK_FILE_DIR}/${checkedUuid(sessionId)}.result`;
}

/**
 * The agent's first prompt: points at the task file. A queued task's (`result`, the file its
 * outcome goes to) also has it finish the task on its own, as the plan-orchestrating method
 * does: verify it, commit only its own changes when it succeeded, and report how it went, so
 * the repo's queue moves on only after a success. Never contains `'` or `\`.
 */
export function taskPrompt(
  action: TaskAction,
  file: string,
  result?: string,
): string {
  const ask = action === 'implement'
    ? `Implement the task described in ${file}.`
    : `Write an implementation plan for the task described in ${file}, following the ` +
      `conventions this project uses for plans (a .plans/ doc if the project has a .plans/ ` +
      `folder). Do not implement it yet.`;
  if (result === undefined) return ask;
  const work = action === 'implement'
    ? `Verify it with the checks this project uses. If it succeeded, follow the project ` +
      `conventions for finished work (for a .plans/ plan: check off its items, archive it ` +
      `and update .plans/PLAN.md), then commit the changes you made for it`
    : `Once the plan is written and registered as the project conventions say, commit the ` +
      `plan files you added or changed`;
  return `${ask} It is one of a queue of tasks run one after another in this repo, so ` +
    `finish it on its own without waiting for a reply. ${work}: stage them by path, leave ` +
    `changes you did not make alone, and follow the commit conventions of the project. ` +
    `Do not commit a task that failed. Last, write its outcome to ${result}: the line ok if ` +
    `it succeeded and is committed, else the line failed: followed by why. The next task in ` +
    `the queue starts only after ok.`;
}

/**
 * A queued task's outcome from its result file's text (see {@link taskResultPath}): its first
 * non-blank line, `ok` (any case) for success, else `failed: <why>` or anything else as why.
 */
export function taskOutcome(
  text: string,
): { ok: true } | { ok: false; reason: string } {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l) ?? '';
  if (/^ok\.?$/i.test(line)) return { ok: true };
  const reason = line.replace(/^failed:?\s*/i, '').slice(0, 300).trim();
  return { ok: false, reason: reason || 'no reason given' };
}

const MAX_SESSION_NAME = 80;

/**
 * A task's title made safe to type single-quoted into an interactive shell (sh, bash, zsh or
 * fish): no control or format characters (a typed one acts on the terminal or line editor even
 * inside quotes), no line breaks, no `'` (it would end the quoting; `’` is shown instead), no `\`
 * (fish reads `\'` inside single quotes), and no leading `-` (it would read as an option). Spaces
 * are collapsed and it is cut to {@link MAX_SESSION_NAME}. `''` when nothing is left.
 */
export function sessionName(title: string): string {
  const name = title
    .replace(/\s+/g, ' ')
    .replace(/[\p{C}\\]/gu, '')
    .replaceAll("'", '’')
    .replace(/^[\s-]+/, '')
    .trim();
  return [...name].slice(0, MAX_SESSION_NAME).join('').trim();
}

/**
 * The command typed into a new tab's shell to start `agent` on a task, as session `sessionId`.
 * Claude is also given `title` as its session name (see {@link sessionName}): it names a session
 * after its first prompt otherwise, and that is only the task file's path. `queued`: sent by its
 * repo's queue, so the prompt is {@link taskPrompt}'s queued one.
 */
export function startTaskCommand(
  agent: SessionAgentId,
  sessionId: string,
  action: TaskAction,
  title = '',
  queued = false,
): string {
  const id = checkedUuid(sessionId);
  const prompt = taskPrompt(
    action,
    taskFilePath(id),
    queued ? taskResultPath(id) : undefined,
  );
  return startCommand(agent, id, prompt, title);
}

/** `agent` started as session `id` on `prompt` (fixed text with no `'`), named `title`. */
function startCommand(
  agent: SessionAgentId,
  id: string,
  prompt: string,
  title: string,
): string {
  const quoted = `'${prompt}'`;
  const name = sessionName(title);
  switch (agent) {
    case 'claude':
      return name
        ? `claude --session-id ${id} --name '${name}' ${quoted}`
        : `claude --session-id ${id} ${quoted}`;
    case 'copilot':
      return `copilot --session-id ${id} -i ${quoted}`;
    case 'pi':
      return `pi --session-id ${id} ${quoted}`;
  }
}

/** The command typed into a new tab's shell to resume session `sessionId`. */
export function resumeTaskCommand(
  agent: SessionAgentId,
  sessionId: string,
): string {
  const id = checkedUuid(sessionId);
  switch (agent) {
    case 'claude':
      return `claude --resume ${id}`;
    case 'copilot':
      return `copilot --resume ${id}`;
    case 'pi':
      return `pi --session-id ${id}`;
  }
}

// Asking an agent a question from a file or diff tile (`ask_agent`). An agent already running in
// a pane is prompted with the question itself, through Herdr's `agent.prompt` (no shell reads
// it). A new or resumed session gets it as a task does: the text in a file named by a fresh uuid
// (`taskFilePath`), its first prompt only pointing at that file.

/** A question's first prompt: points at the question's file. Never contains `'`. */
export function askPrompt(file: string): string {
  return `Answer the question in ${file}. Do not change any files unless it asks you to.`;
}

/**
 * The command typed into a new tab's shell to start `agent` as session `sessionId` on the
 * question in file `askId` (see {@link taskFilePath}), named `title` as a task's is.
 */
export function startAskCommand(
  agent: SessionAgentId,
  sessionId: string,
  askId: string,
  title = '',
): string {
  return startCommand(
    agent,
    checkedUuid(sessionId),
    askPrompt(taskFilePath(askId)),
    title,
  );
}

/** The command typed into a new tab's shell to resume session `sessionId` on question `askId`. */
export function resumeAskCommand(
  agent: SessionAgentId,
  sessionId: string,
  askId: string,
): string {
  const prompt = `'${askPrompt(taskFilePath(askId))}'`;
  const resume = resumeTaskCommand(agent, sessionId);
  return agent === 'copilot' ? `${resume} -i ${prompt}` : `${resume} ${prompt}`;
}
