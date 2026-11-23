// devc web's orchestrator (`.plans/devc-web-orchestrator.md`): one Pi session per running
// container that routes a prompt to one of the container's repos and starts a worker agent there.
// The pure parts: where its files go, what they hold, the command that starts it, and how its
// pane is recognized. The server does the writing and the Herdr calls.
//
// The files it copies in (`orchestrator_files/`) are embedded beside this module, as `static/`
// is (the compiled binary's `--include web/orchestrator_files`).

import { CONFIG_DIR } from '@devc-tools/core/default_config.ts';
import type { MountedRepo } from './git_repo.ts';
import { repoName } from './projects_view.ts';

/** The orchestrator's folder under the remote user's `$HOME`, never a repo. */
export const ORCHESTRATOR_HOME_SUBDIR = '.local/share/devc-orchestrator';

/** Its folder in an environment whose `$HOME` is `home`. */
export function orchestratorDir(home: string): string {
  return `${home.replace(/\/+$/, '')}/${ORCHESTRATOR_HOME_SUBDIR}`;
}

/** The embedded files' folder: a checkout's, or the binary's `--include`. */
export const ORCHESTRATOR_FILES_ROOT = new URL(
  './orchestrator_files/',
  import.meta.url,
);

/** The files copied in verbatim from {@link ORCHESTRATOR_FILES_ROOT}. */
export const EMBEDDED_FILES = ['orchestrator.ts', 'SYSTEM.md'] as const;

/** The host folder of the routing notes every container's orchestrator shares. */
export const ROUTING_HOST_DIR = `${CONFIG_DIR}/orchestrator`;
export const ROUTING_FILE = 'routing.md';
export const ROUTING_HOST_PATH = `${ROUTING_HOST_DIR}/${ROUTING_FILE}`;

/** The Herdr workspace the orchestrator's pane lives in, and the pane's label. */
export const ORCHESTRATOR_WORKSPACE = 'Orchestrator';
export const ORCHESTRATOR_PANE_LABEL = 'Orchestrator';

/** The failure a container without Pi gets. */
export const NOT_INSTALLED_MESSAGE =
  "This container needs the agents feature's installPiCli and installHerdr.";

/** What an `orchestrator` request does: see the plan's § The `orchestrator` request. */
export type OrchestratorMode = 'open' | 'restart' | 'new';

export function isOrchestratorMode(v: unknown): v is OrchestratorMode {
  return v === 'open' || v === 'restart' || v === 'new';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A `session-id` file's id, or null when it holds none. */
export function parseSessionId(text: string): string | null {
  const id = text.trim();
  return UUID.test(id) ? id : null;
}

/** The line that starts Pi in the orchestrator's folder (sent to its shell, then `\n`). */
export function launchCommand(sessionId: string): string {
  if (parseSessionId(sessionId) === null) {
    throw new Error(`not a session id: ${sessionId}`);
  }
  return [
    'exec pi --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve',
    '--no-builtin-tools -e ./orchestrator.ts --system-prompt "$(cat SYSTEM.md)"',
    `--session-id ${sessionId} --name Orchestrator`,
  ].join(' ');
}

/** `repos.json`: each mounted repo's card name and container folder, in order. */
export function reposJson(repos: readonly MountedRepo[]): string {
  const list = repos
    .filter((r) => r.containerFolder !== null)
    .map((r) => ({
      name: repoName(r.folder, r.containerFolder),
      path: (r.containerFolder as string).replace(/\/+$/, '') || '/',
    }));
  return `${JSON.stringify({ repos: list }, null, 2)}\n`;
}

/** Whether a pane's `cwd` (not `foreground_cwd`) is an orchestrator's folder. */
export function isOrchestratorCwd(cwd: unknown): boolean {
  return typeof cwd === 'string' &&
    cwd.replace(/\/+$/, '').endsWith(`/${ORCHESTRATOR_HOME_SUBDIR}`);
}

/** The orchestrator's pane among a snapshot's panes, or null. */
export function orchestratorPane<
  P extends { pane_id?: unknown; tab_id?: unknown; cwd?: unknown },
>(panes: readonly P[]): (P & { pane_id: string; tab_id: string }) | null {
  const p = panes.find((p) =>
    isOrchestratorCwd(p.cwd) && typeof p.pane_id === 'string' &&
    typeof p.tab_id === 'string'
  );
  return (p as (P & { pane_id: string; tab_id: string }) | undefined) ?? null;
}

/** An embedded file's text. */
export function readEmbedded(name: string): Promise<string> {
  return Deno.readTextFile(new URL(name, ORCHESTRATOR_FILES_ROOT));
}

/**
 * The host's routing notes, created from the embedded default when missing (never overwritten).
 * `path` and `dir` are for tests.
 */
export async function ensureRoutingFile(
  path = ROUTING_HOST_PATH,
  dir = ROUTING_HOST_DIR,
): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const text = await readEmbedded(ROUTING_FILE);
  await Deno.mkdir(dir, { recursive: true });
  try {
    await Deno.writeTextFile(path, text, { createNew: true });
  } catch (e) {
    // Made meanwhile by another server: theirs stands.
    if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
    return await Deno.readTextFile(path);
  }
  return text;
}
