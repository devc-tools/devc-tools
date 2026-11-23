// The devc web orchestrator's Pi extension (`.plans/devc-web-orchestrator.md`). devc web copies
// this file into `$HOME/.local/share/devc-orchestrator/` in a container and starts Pi there with
// `-e ./orchestrator.ts`, beside Pi's own tools (SYSTEM.md asks it to delegate repo work rather
// than do it). The tools below route a request to one of the container's repos, start a worker
// agent there in a new Herdr pane, and watch the workers: when one waits on the user they tell the
// orchestrator what the worker's screen shows, so the orchestrator can tell the user.
//
// Pi loads it (with its own copies of the imports below), never Deno: it is out of `deno check`
// and `deno lint`.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Repo {
  name: string;
  path: string;
}

/** What each repo looks like, built on first need and kept for the Pi process. */
const summaries = new Map<string, string>();

const AGENTS = ['claude', 'copilot', 'pi'] as const;
type Agent = typeof AGENTS[number];

const MAX_TITLE = 60;
/** How often the watcher checks the workers' status. */
const WATCH_MS = 3_000;
/** How long a new worker may go undetected before it counts as gone. */
const START_GRACE_MS = 60_000;
const READ_LINES = 60;
const MAX_WORKER_LINES = 200;

/** A worker this orchestrator dispatched, kept in `workers.json` across Pi restarts. */
interface Worker {
  pane: string;
  repo: string;
  agent: string;
  title: string;
  /** When it was dispatched, ms since the epoch. */
  started: number;
}

const workersFile = () => join(process.cwd(), 'workers.json');

function readWorkers(): Worker[] {
  try {
    const parsed = JSON.parse(readText(workersFile()));
    return Array.isArray(parsed?.workers) ? parsed.workers : [];
  } catch {
    return [];
  }
}

function writeWorkers(workers: Worker[]) {
  writeFileSync(workersFile(), `${JSON.stringify({ workers }, null, 2)}\n`);
}

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }], details: {} };
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function readRepos(): Repo[] {
  try {
    const parsed = JSON.parse(readText(join(process.cwd(), 'repos.json')));
    const list = Array.isArray(parsed?.repos) ? parsed.repos : [];
    return list.filter((r: unknown): r is Repo =>
      typeof (r as Repo)?.name === 'string' &&
      typeof (r as Repo)?.path === 'string'
    );
  } catch {
    return [];
  }
}

function findRepo(name: string): Repo {
  const repos = readRepos();
  const repo = repos.find((r) => r.name === name);
  if (repo) return repo;
  throw new Error(
    `No repo named '${name}'. Repos: ${
      repos.map((r) => r.name).join(', ') || '(none)'
    }`,
  );
}

export default function (pi: ExtensionAPI) {
  const run = async (cmd: string, args: string[], cwd?: string) => {
    const r = await pi.exec(cmd, args, {
      timeout: 60_000,
      ...(cwd ? { cwd } : {}),
    });
    return r;
  };

  const herdr = async (args: string[]) => {
    const r = await run('herdr', args);
    if (r.code !== 0) {
      throw new Error(
        `herdr ${args.slice(0, 2).join(' ')} failed: ${
          (r.stderr || r.stdout).trim()
        }`,
      );
    }
    try {
      return JSON.parse(r.stdout)?.result ?? {};
    } catch {
      return {};
    }
  };

  const summarize = async (repo: Repo): Promise<string> => {
    const lines = [`### ${repo.name}`, `path: ${repo.path}`];
    const branch = await run('git', ['branch', '--show-current'], repo.path);
    if (branch.code === 0 && branch.stdout.trim()) {
      lines.push(`branch: ${branch.stdout.trim()}`);
    }
    const readme = ['README.md', 'README', 'readme.md']
      .map((f) => readText(join(repo.path, f)))
      .find((t) => t !== '') ?? '';
    const para = readme
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) =>
        p !== '' && !p.startsWith('#') && !p.startsWith('<') &&
        !p.startsWith('![')
      );
    if (para) lines.push(`readme: ${para.replace(/\s+/g, ' ').slice(0, 600)}`);
    for (const f of ['AGENTS.md', 'CLAUDE.md']) {
      const heads = readText(join(repo.path, f))
        .split('\n')
        .filter((l) => /^#{1,2} /.test(l))
        .map((l) => l.trim());
      if (heads.length) lines.push(`${f}: ${heads.join(' | ')}`);
    }
    const log = await run('git', ['log', '-5', '--format=%s'], repo.path);
    if (log.code === 0 && log.stdout.trim()) {
      lines.push('recent commits:');
      for (const s of log.stdout.trim().split('\n')) {
        lines.push(`- ${s.slice(0, 160)}`);
      }
    }
    return lines.join('\n');
  };

  /** Every repo's summary, building the ones not seen yet. */
  const repoSummaries = async (): Promise<string> => {
    const repos = readRepos();
    await Promise.all(
      repos
        .filter((r) => !summaries.has(r.name))
        .map(async (r) => summaries.set(r.name, await summarize(r))),
    );
    return repos.map((r) => summaries.get(r.name)!).join('\n\n') ||
      '(no repos)';
  };

  // Rereads the routing notes and the repo list on every prompt, so a change applies at once.
  pi.on('before_agent_start', async (event) => {
    const opts = event.systemPromptOptions;
    opts.sections = opts.sections ?? {};
    opts.sections.routing =
      readText(join(process.cwd(), 'routing.md')).trim() ||
      '(no routing notes)';
    opts.sections.repos = await repoSummaries();
  });

  pi.registerCommand('reindex', {
    description:
      'Forget the repo summaries; they are built again on the next prompt',
    handler: async (_args, ctx) => {
      summaries.clear();
      ctx.ui.notify('Repo summaries cleared.', 'info');
    },
  });

  pi.registerTool({
    name: 'list_repos',
    label: 'List repos',
    description:
      "The container's repos: name, path, branch, README summary, AGENTS.md/CLAUDE.md headings, recent commits.",
    parameters: Type.Object({}),
    async execute() {
      return text(await repoSummaries());
    },
  });

  pi.registerTool({
    name: 'ask_user',
    label: 'Ask',
    description:
      'Ask the user to choose, e.g. between candidate repos. Returns their answer.',
    parameters: Type.Object({
      question: Type.String(),
      options: Type.Array(Type.String(), { minItems: 1 }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const other = 'Something else…';
      const choice = await ctx.ui.select(params.question, [
        ...params.options,
        other,
      ]);
      if (choice === undefined) return text('The user dismissed the question.');
      if (choice !== other) return text(`The user chose: ${choice}`);
      const typed = await ctx.ui.input(params.question, '');
      return text(
        typed ? `The user answered: ${typed}` : 'The user gave no answer.',
      );
    },
  });

  /** A worker's Herdr agent status, `starting` before Herdr sees it, `gone` once it never will. */
  const workerStatus = async (w: Worker): Promise<string> => {
    const r = await run('herdr', ['agent', 'get', w.pane]);
    if (r.code === 0) {
      try {
        return JSON.parse(r.stdout)?.result?.agent?.agent_status ?? 'unknown';
      } catch {
        return 'unknown';
      }
    }
    if (!(r.stderr + r.stdout).includes('agent_not_found')) return 'unknown';
    return Date.now() - w.started < START_GRACE_MS ? 'starting' : 'gone';
  };

  const workerScreen = async (
    pane: string,
    lines: number,
    source: 'visible' | 'recent' = 'recent',
  ) => {
    const r = await run('herdr', [
      'agent',
      'read',
      pane,
      '--source',
      source,
      '--lines',
      String(lines),
    ]);
    if (r.code !== 0) return null;
    return r.stdout.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  };

  const describe = (w: Worker) =>
    `${w.agent} in ${w.repo} (pane ${w.pane}, "${w.title}")`;

  const findWorker = (pane: string): Worker => {
    const workers = readWorkers();
    const w = workers.find((x) => x.pane === pane);
    if (w) return w;
    throw new Error(
      `No worker in pane ${pane}. Workers: ${
        workers.map((x) => x.pane).join(', ') || '(none)'
      }`,
    );
  };

  // The watcher: each worker's last status, so a change is told once. A worker found waiting when
  // the watcher first sees it (e.g. after a restart) is told too; one found done is not.
  const last = new Map<string, string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;

  // A waiting worker's message holds its screen for the model and wakes it (the user sees its
  // reply, not the screen); a finished one is only shown, and the model sees it on the next turn.
  const tell = (content: string, triggerTurn: boolean) =>
    pi.sendMessage(
      { customType: 'devc-worker', content, display: !triggerTurn },
      { triggerTurn, deliverAs: 'followUp' },
    );

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const workers = readWorkers();
      const kept: Worker[] = [];
      for (const w of workers) {
        const status = await workerStatus(w);
        const before = last.get(w.pane);
        last.set(w.pane, status);
        if (status === 'gone') {
          last.delete(w.pane);
          continue;
        }
        kept.push(w);
        if (status === before) continue;
        if (status === 'blocked') {
          const screen = await workerScreen(w.pane, 40, 'visible');
          tell(
            `Worker ${
              describe(w)
            } is waiting on the user. The end of its screen:\n\n\`\`\`\n${
              screen ?? '(could not read it)'
            }\n\`\`\`\n\nTell the user in a line or two what it is asking and that they answer it in that pane.`,
            true,
          );
        } else if (status === 'done' && before !== undefined) {
          tell(`Worker ${describe(w)} finished its turn.`, false);
        }
      }
      if (kept.length !== workers.length) {
        // Re-read so a dispatch made meanwhile is kept.
        const gone = new Set(
          workers.filter((w) => !kept.includes(w)).map((w) => w.pane),
        );
        writeWorkers(readWorkers().filter((w) => !gone.has(w.pane)));
      }
      if (kept.length === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    } finally {
      polling = false;
    }
  };

  const watch = () => {
    if (!timer) timer = setInterval(() => void poll(), WATCH_MS);
  };

  pi.on('session_start', async () => {
    if (readWorkers().length) watch();
  });
  pi.on('session_shutdown', async () => {
    if (timer) clearInterval(timer);
    timer = null;
  });

  pi.registerTool({
    name: 'workers',
    label: 'Workers',
    description:
      "The workers you dispatched that still exist, with each one's status: working, blocked (waiting on the user: a question or a permission prompt), done (finished its turn, unseen), idle, starting or unknown.",
    parameters: Type.Object({}),
    async execute() {
      const workers = readWorkers();
      if (!workers.length) return text('No workers.');
      const lines: string[] = [];
      for (const w of workers) {
        const status = await workerStatus(w);
        if (status !== 'gone') lines.push(`${describe(w)}: ${status}`);
      }
      return text(lines.join('\n') || 'No workers.');
    },
  });

  pi.registerTool({
    name: 'read_worker',
    label: 'Read worker',
    description:
      "The end of a worker's screen: what it is doing, asking or has answered.",
    parameters: Type.Object({
      pane: Type.String({ description: "The worker's pane id" }),
      lines: Type.Optional(
        Type.Number({ description: `Lines to read (default ${READ_LINES})` }),
      ),
    }),
    async execute(_id, params) {
      const w = findWorker(params.pane);
      const n = Math.min(
        Math.max(Math.floor(params.lines ?? READ_LINES), 1),
        MAX_WORKER_LINES,
      );
      const screen = await workerScreen(w.pane, n);
      if (screen === null) throw new Error(`Can't read pane ${w.pane}`);
      return text(screen || '(empty)');
    },
  });

  pi.registerTool({
    name: 'message_worker',
    label: 'Message worker',
    description:
      "Send a worker a follow-up message, as if the user typed it into its pane. Refused while the worker shows a question or permission prompt: those are the user's to answer in the pane.",
    parameters: Type.Object({
      pane: Type.String({ description: "The worker's pane id" }),
      message: Type.String(),
    }),
    async execute(_id, params) {
      const w = findWorker(params.pane);
      const r = await run('herdr', ['agent', 'prompt', w.pane, params.message]);
      if (r.code === 0) return text(`Sent to ${describe(w)}.`);
      const out = (r.stderr || r.stdout).trim();
      if (out.includes('agent_blocked')) {
        return text(
          `Not sent: ${
            describe(w)
          } is showing a question or permission prompt. The user answers it in that pane.`,
        );
      }
      throw new Error(`herdr agent prompt failed: ${out}`);
    },
  });

  pi.registerTool({
    name: 'dispatch',
    label: 'Dispatch',
    description:
      "Start a worker agent in a repo's own new Herdr pane with the prompt. The prompt is the user's request verbatim, optionally followed by routing notes.",
    parameters: Type.Object({
      repo: Type.String({ description: 'A repo name' }),
      agent: Type.Union(AGENTS.map((a) => Type.Literal(a)), {
        description: 'claude unless the user named another',
      }),
      title: Type.String({
        description: 'Short pane title, at most 60 characters',
      }),
      prompt: Type.String({ description: "The user's request, verbatim" }),
      notes: Type.Optional(
        Type.String({ description: 'Routing notes for the worker, if any' }),
      ),
    }),
    async execute(_id, params) {
      const repo = findRepo(params.repo);
      const agent = params.agent as Agent;
      if (!AGENTS.includes(agent)) throw new Error(`Unknown agent ${agent}`);
      const title = params.title.trim().slice(0, MAX_TITLE) || repo.name;
      const prompt = params.notes?.trim()
        ? `${params.prompt}\n\n## Routing notes\n\n${params.notes.trim()}`
        : params.prompt;

      const listed = await herdr(['workspace', 'list']);
      const workspaces: { workspace_id?: string; label?: string }[] =
        Array.isArray(listed?.workspaces) ? listed.workspaces : [];
      const ws = workspaces.find((w) => w.label === repo.name)?.workspace_id;
      const created = ws
        ? await herdr([
          'tab',
          'create',
          '--workspace',
          ws,
          '--cwd',
          repo.path,
          '--label',
          title,
        ])
        : await herdr([
          'workspace',
          'create',
          '--cwd',
          repo.path,
          '--label',
          repo.name,
          '--no-focus',
        ]);
      const pane = paneId(created);
      if (!pane) {
        throw new Error(`herdr gave no pane id: ${JSON.stringify(created)}`);
      }
      await herdr(['pane', 'rename', pane, title]).catch(() => {});
      // The prompt goes on the agent's command line, read from a file that the command line
      // deletes as it reads it. Not `herdr agent start -- <prompt>`: it refuses arguments it
      // can't quote for the shell (newlines, quotes). Nor `agent start` then `agent prompt`:
      // herdr calls Claude idle while its folder-trust question is up, so the paste's Enter
      // would answer "No, exit", and Pi drops an Enter sent as soon as it starts.
      const file = join(tmpdir(), `devc-dispatch-${randomUUID()}.md`);
      writeFileSync(file, prompt, { mode: 0o600 });
      const q = shellQuote(file);
      const flag = agent === 'copilot' ? '-i ' : '';
      try {
        await herdr([
          'pane',
          'run',
          pane,
          `${agent} ${flag}"$(cat ${q}; rm -f ${q})"`,
        ]);
      } catch (e) {
        rmSync(file, { force: true });
        throw e;
      }
      writeWorkers([
        ...readWorkers(),
        { pane, repo: repo.name, agent, title, started: Date.now() },
      ]);
      watch();
      return text(`Started ${agent} in ${repo.name} (pane ${pane})`);
    },
  });
}

/** `s` in single quotes for a POSIX shell. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The new pane's id in a `tab create` or `workspace create` result. */
function paneId(result: unknown): string | null {
  const seen = new Set<unknown>();
  const walk = (v: unknown): string | null => {
    if (typeof v !== 'object' || v === null || seen.has(v)) return null;
    seen.add(v);
    const o = v as Record<string, unknown>;
    for (const k of ['root_pane_id', 'pane_id']) {
      if (typeof o[k] === 'string') return o[k] as string;
    }
    for (const k of ['root_pane', 'pane', 'tab', 'workspace']) {
      const found = walk(o[k]);
      if (found) return found;
    }
    if (Array.isArray(o.panes)) {
      for (const p of o.panes) {
        const found = walk(p);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(result);
}
