// `task-add`, the first native built-in: the bridge appends the task to devc web's task list
// itself, through devc-core's task store, instead of running a script from `builtin/`. It never
// runs devc. A task is only added, routed to the repo of the policy line `--repo` selects and
// marked as an agent's; queueing and sending stay with the person at the page.
//
//   devc-bridge task-add [--repo <path>] <text>
//
// Exit codes: 1 not granted (dispatch's `grantRefusal`, before this runs), 2 wrong arguments or
// the selected line not granting `task-add`, 3 text to fix (blank, too long, a control
// character, or the container's cap reached), 4 a host failure.

import { join } from '@std/path';
import { parsePolicy, type PolicyLine } from '@devc-tools/core/bridge.ts';
import { listContainerFolders } from '@devc-tools/core/container.ts';
import { projectKey } from '@devc-tools/core/merged_config.ts';
import {
  AgentTaskCapError,
  appendAgentTask,
  TASKS_PATH,
  taskText,
} from '@devc-tools/core/tasks.ts';
import type { Response } from './core.ts';

/** What `task-add` reads besides its request; every field is injectable for tests. */
export interface TaskAddOptions {
  /** devc web's tasks file. Default `~/.config/devc/tasks/tasks.json`. */
  tasksPath?: string;
  /** Every devc container's host folder. Default `docker ps` (`listContainerFolders`). */
  listContainerFolders?: () => Promise<string[]>;
}

const USAGE = 'usage: task-add [--repo <path>] <text>';

// Any control character but a line break or a tab.
const CONTROL = /[^\P{Cc}\n\t]/u;

class Exit extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

/** Runs `task-add` for the caller holding workspace `key`, its policy in `policyDir`. */
export async function taskAdd(
  args: readonly string[],
  key: string,
  policyDir: string,
  opts: TaskAddOptions = {},
): Promise<Response> {
  try {
    const id = await add(args, key, policyDir, opts);
    return { ok: true, exitCode: 0, stdout: `${id}\n`, stderr: '' };
  } catch (e) {
    const exit = e instanceof Exit
      ? e
      : new Exit(4, e instanceof Error ? e.message : String(e));
    return {
      ok: true,
      exitCode: exit.code,
      stdout: '',
      stderr: `task-add: ${exit.message}\n`,
    };
  }
}

async function add(
  args: readonly string[],
  key: string,
  policyDir: string,
  opts: TaskAddOptions,
): Promise<string> {
  // `--repo <path>` only as the first argument, in the space form only.
  let want: string | null = null;
  let rest = args;
  if (rest[0] === '--repo') {
    if (rest.length < 2) throw new Exit(2, USAGE);
    want = rest[1];
    rest = rest.slice(2);
  }
  if (rest.length !== 1) throw new Exit(2, USAGE);
  const raw = rest[0];

  // Read again rather than trust what grantRefusal saw.
  let policy;
  try {
    policy = parsePolicy(
      await Deno.readTextFile(join(policyDir, `${key}.conf`)),
    );
  } catch (e) {
    throw new Exit(1, `no capabilities granted to this container (${e})`);
  }
  if (policy === null) {
    throw new Exit(2, "this container's policy is malformed");
  }
  const line = selectLine(policy.repos, want);
  if (!line.grants.includes('task-add')) {
    throw new Exit(
      2,
      policy.repos.length > 1
        ? `this container was not granted task-add for ${line.target}`
        : 'this container was not granted task-add',
    );
  }

  const text = taskText(raw);
  if (text === null) {
    throw new Exit(3, 'the task text is blank or longer than 20000 characters');
  }
  if (CONTROL.test(text)) {
    throw new Exit(
      3,
      'the task text holds a control character (only line breaks and tabs are allowed)',
    );
  }

  const folders = await (opts.listContainerFolders ?? listContainerFolders)();
  let localFolder: string | undefined;
  for (const folder of folders) {
    if (await projectKey(folder) === key) {
      localFolder = folder;
      break;
    }
  }
  if (localFolder === undefined) {
    throw new Exit(4, `no devc container for workspace ${key}`);
  }

  try {
    return await appendAgentTask(
      { text, localFolder, root: line.repo, key },
      opts.tasksPath ?? TASKS_PATH,
    );
  } catch (e) {
    if (e instanceof AgentTaskCapError) throw new Exit(3, e.message);
    throw e;
  }
}

/**
 * The line whose target is `want` (trailing `/`s dropped, compared as a plain string), or with
 * no `want` the only line — as `gh-push`'s `select_repo` picks one.
 */
function selectLine(lines: readonly PolicyLine[], want: string | null) {
  const targets = lines.map((l) => l.target).join(', ');
  if (want === null) {
    if (lines.length !== 1) {
      throw new Exit(
        2,
        `this container has ${lines.length} pinned repos — pass --repo <path>, one of: ${targets}`,
      );
    }
    return lines[0];
  }
  const t = want.replace(/\/+$/, '');
  const line = lines.find((l) => l.target === t);
  if (line === undefined) {
    throw new Exit(2, `no pinned repo at ${want} — pinned: ${targets}`);
  }
  return line;
}
