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

export type SessionAgentId = 'claude' | 'copilot' | 'pi';

export type TaskAction = 'plan' | 'implement';

const SESSION_AGENTS: readonly SessionAgentId[] = ['claude', 'copilot', 'pi'];

export function isSessionAgentId(v: unknown): v is SessionAgentId {
  return SESSION_AGENTS.includes(v as SessionAgentId);
}

export function isTaskAction(v: unknown): v is TaskAction {
  return v === 'plan' || v === 'implement';
}

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

/** The agent's first prompt: points at the task file. Never contains `'`. */
export function taskPrompt(action: TaskAction, file: string): string {
  return action === 'implement'
    ? `Implement the task described in ${file}.`
    : `Write an implementation plan for the task described in ${file}, following the ` +
      `conventions this project uses for plans (a .plans/ doc if the project has a .plans/ ` +
      `folder). Do not implement it yet.`;
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
 * after its first prompt otherwise, and that is only the task file's path.
 */
export function startTaskCommand(
  agent: SessionAgentId,
  sessionId: string,
  action: TaskAction,
  title = '',
): string {
  const id = checkedUuid(sessionId);
  const prompt = `'${taskPrompt(action, taskFilePath(id))}'`;
  const name = sessionName(title);
  switch (agent) {
    case 'claude':
      return name
        ? `claude --session-id ${id} --name '${name}' ${prompt}`
        : `claude --session-id ${id} ${prompt}`;
    case 'copilot':
      return `copilot --session-id ${id} -i ${prompt}`;
    case 'pi':
      return `pi --session-id ${id} ${prompt}`;
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
