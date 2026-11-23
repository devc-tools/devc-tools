// The devc web orchestrator's Pi extension (`.plans/devc-web-orchestrator.md`). devc web copies
// this file into `$HOME/.local/share/devc-orchestrator/` in a container and starts Pi there with
// `--no-builtin-tools -e ./orchestrator.ts`, so the tools below are the only ones the model has.
// It reads files, runs `git` and `herdr`, and nothing else: it routes a request to one of the
// container's repos and starts a worker agent there in a new Herdr pane.
//
// Pi loads it (with its own copies of the imports below), never Deno: it is out of `deno check`
// and `deno lint`.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

interface Repo {
  name: string;
  path: string;
}

/** What each repo looks like, built on first need and kept for the Pi process. */
const summaries = new Map<string, string>();

const AGENTS = ['claude', 'copilot', 'pi'] as const;
type Agent = typeof AGENTS[number];

const MAX_SEARCH_LINES = 200;
const MAX_READ_LINES = 400;
const MAX_READ_CHARS = 40_000;
const MAX_TITLE = 60;

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
    name: 'search',
    label: 'Search',
    description:
      'Search tracked files with git grep (extended regex). Omit repo to search every repo.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Extended regular expression' }),
      repo: Type.Optional(Type.String({ description: 'A repo name' })),
    }),
    async execute(_id, params) {
      const repos = params.repo ? [findRepo(params.repo)] : readRepos();
      const out: string[] = [];
      for (const r of repos) {
        const g = await run('git', [
          '-C',
          r.path,
          'grep',
          '-n',
          '-I',
          '-E',
          '--max-count',
          '20',
          '-e',
          params.pattern,
        ]);
        for (const line of g.stdout.split('\n')) {
          if (line) out.push(`${r.name}: ${line.slice(0, 300)}`);
        }
      }
      if (out.length > MAX_SEARCH_LINES) {
        return text(
          `${out.slice(0, MAX_SEARCH_LINES).join('\n')}\n… (more matches cut)`,
        );
      }
      return text(out.join('\n') || 'No matches.');
    },
  });

  pi.registerTool({
    name: 'read_file',
    label: 'Read file',
    description: 'Read a file in a repo (path relative to the repo).',
    parameters: Type.Object({
      repo: Type.String({ description: 'A repo name' }),
      path: Type.String({ description: 'Path relative to the repo' }),
    }),
    async execute(_id, params) {
      const repo = findRepo(params.repo);
      const full = resolve(repo.path, params.path);
      const rel = relative(repo.path, full);
      if (rel.startsWith('..') || rel === '' && params.path !== '.') {
        throw new Error(`${params.path} is outside ${repo.name}`);
      }
      let body: string;
      try {
        body = readFileSync(full, 'utf8');
      } catch (e) {
        throw new Error(`Can't read ${params.path}: ${(e as Error).message}`);
      }
      const lines = body.split('\n');
      let cut = lines.slice(0, MAX_READ_LINES).join('\n');
      if (cut.length > MAX_READ_CHARS) cut = cut.slice(0, MAX_READ_CHARS);
      return text(
        cut.length < body.length ? `${cut}\n… (cut; file is longer)` : cut,
      );
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
      const args = agent === 'copilot' ? ['-i', prompt] : [prompt];
      await herdr([
        'agent',
        'start',
        title,
        '--kind',
        agent,
        '--pane',
        pane,
        '--',
        ...args,
      ]);
      return text(`Started ${agent} in ${repo.name} (pane ${pane})`);
    },
  });
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
