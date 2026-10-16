// Pure naming and status helpers for the `devc web` sidebar, shared with the Deno tests
// (`devc/tests/web_sidebar_test.ts`). No DOM access here.

/** Agent statuses, most in need of attention first. */
export const STATUS_ORDER = ['blocked', 'working', 'done', 'unknown', 'idle'];

function basename(path) {
  const parts = String(path ?? '').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function dirname(path) {
  return String(path ?? '').replace(/\/+$/, '').split('/').slice(0, -1).join(
    '/',
  );
}

/** A pane's agent status, `unknown` when Herdr sent none or one this page doesn't know. */
export function agentStatus(pane) {
  return STATUS_ORDER.includes(pane?.agent_status)
    ? pane.agent_status
    : 'unknown';
}

/**
 * The agent status most in need of attention among `panes`, and how many agents have it;
 * `null` when no pane runs an agent.
 */
export function topStatus(panes) {
  const agents = panes.filter((p) => p.agent);
  if (agents.length === 0) return null;
  const status = STATUS_ORDER.find((s) =>
    agents.some((p) => agentStatus(p) === s)
  );
  return {
    status,
    count: agents.filter((p) => agentStatus(p) === status).length,
  };
}

/** A pane's title as Herdr reports it, else its folder, else its id. */
export function paneTitle(pane) {
  return pane?.terminal_title_stripped || basename(pane?.cwd) ||
    pane?.pane_id ||
    '';
}

/**
 * A container's name in the sidebar and tile headers, `all` being every container listed.
 * Containers sharing a name (two `feature1` worktrees, say) get their parent folder appended,
 * and the full folder when even that is shared.
 */
export function containerLabel(c, all) {
  const twins = [...all].filter((o) => o.name === c.name);
  if (twins.length < 2) return c.name;
  const parent = basename(dirname(c.localFolder));
  const parentShared =
    twins.filter((o) => basename(dirname(o.localFolder)) === parent).length >
      1;
  return `${c.name} · ${parentShared || !parent ? c.localFolder : parent}`;
}

/**
 * A pane's sidebar label. A shell's title is just its folder, which is usually the container's
 * own name again, so a shell reads `shell`, or `shell · <folder>` when it is somewhere else.
 * Agents and anything with a title of its own (`npm run dev`) keep their title.
 */
export function paneLabel(c, pane) {
  const title = paneTitle(pane);
  const dir = basename(pane.foreground_cwd || pane.cwd);
  const folders = [basename(pane.cwd), basename(pane.foreground_cwd)];
  if (pane.agent || !dir) return title;
  if (title !== pane.pane_id && !folders.includes(title)) return title;
  return dir === basename(c.localFolder) ? 'shell' : `shell · ${dir}`;
}

/** A tab's name: Herdr labels new tabs with just their number. */
export function tabName(tab) {
  const label = tab.label ?? '';
  return label && !/^\d+$/.test(label) ? label : `tab ${tab.number ?? label}`;
}
