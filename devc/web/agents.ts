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
