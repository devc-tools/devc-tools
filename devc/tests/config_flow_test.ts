// The project-config flow driven headlessly: a scripted key stream + fake `readDir`, asserting
// that `apply` receives the rows the pickers produced. No TTY (raw off).

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1';
import {
  type FlowDeps,
  type FlowResult,
  type ProjectFlowOptions,
  runProjectFlow,
} from '../tui/config_flow.ts';
import type { WizardSelection } from '@devc-tools/core/wizard_apply.ts';
import type { FsProbe } from '@devc-tools/core/worktree.ts';
import type { ContainerStatus } from '../container.ts';

const FS: Record<string, string[]> = {
  '/code': ['app', 'lib'],
  '/skills': ['review', 'writing'],
};
const fakeReadDir = (p: string) => Promise.resolve(FS[p] ?? []);

/** One chunk per key so a picker never over-reads keys meant for the next step. */
function streamOfKeys(keys: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const k of keys) c.enqueue(enc.encode(k));
      c.close();
    },
  });
}

function sink(): WritableStream<Uint8Array> {
  return new WritableStream({ write() {} });
}

function baseOpts(): ProjectFlowOptions {
  return {
    projectDir: '/proj',
    overlayPath: '/proj/.devcontainer/devc.jsonc',
    creating: true,
    sourceRows: [],
    skillsRows: [],
    codeRoots: ['/code'],
    skillsRoots: ['/skills'],
    color: false,
  };
}

const SPACE = ' ';
const ENTER = '\r';
const DOWN = '\x1b[B';
const RIGHT = '\x1b[C';
const UP = '\x1b[A';
const ESC = '\x1b';

Deno.test('project flow: pick one source + one skills folder, apply gets the rows', async () => {
  let captured: WizardSelection | null = null;
  const deps: FlowDeps = {
    // A single configured root opens inside itself — no → needed to enter it.
    // source: tick "app", Enter · skills: down to "writing", tick, Enter · confirm y
    input: streamOfKeys([SPACE, ENTER, DOWN, SPACE, ENTER, 'y']),
    output: sink(),
    size: () => ({ columns: 80, rows: 24 }),
    raw: false,
    readDir: fakeReadDir,
    apply: (_dir, sel) => {
      captured = sel;
      return Promise.resolve({
        created: true,
        changed: true,
        overlayPath: '/proj/.devcontainer/devc.jsonc',
      });
    },
  };

  const result = await runProjectFlow(baseOpts(), deps);
  assertEquals(result.applied, true);
  assert(captured !== null);
  const sel = captured as unknown as WizardSelection;

  assertEquals(sel.source, [{
    source: '/code/app',
    target: '/workspaces/app',
  }]);
  assertEquals(sel.skills, [{
    source: '/skills/writing',
    target: '/home/vscode/.claude/skills/writing',
  }]);
});

Deno.test('project flow: declining the confirm applies nothing', async () => {
  let called = false;
  const deps: FlowDeps = {
    // single roots open inside · src: pick, done · skills: none, done · confirm n
    input: streamOfKeys([SPACE, ENTER, ENTER, 'n']),
    output: sink(),
    size: () => ({ columns: 80, rows: 24 }),
    raw: false,
    readDir: fakeReadDir,
    apply: () => {
      called = true;
      return Promise.resolve({
        created: true,
        changed: true,
        overlayPath: 'x',
      });
    },
  };
  const result = await runProjectFlow(baseOpts(), deps);
  assertEquals(result.applied, false);
  assertEquals(called, false);
});

Deno.test('project flow: Esc in the source picker cancels the whole flow', async () => {
  let called = false;
  const deps: FlowDeps = {
    input: streamOfKeys([ESC]),
    output: sink(),
    size: () => ({ columns: 80, rows: 24 }),
    raw: false,
    readDir: fakeReadDir,
    apply: () => {
      called = true;
      return Promise.resolve({
        created: true,
        changed: true,
        overlayPath: 'x',
      });
    },
  };
  const result = await runProjectFlow(baseOpts(), deps);
  assertEquals(result.applied, false);
  assertEquals(called, false);
});

Deno.test('project flow: the project folder is pinned in the picker, not a pick', async () => {
  let captured: WizardSelection | null = null;
  const opts = { ...baseOpts(), projectDir: '/code/app' };
  const deps: FlowDeps = {
    // src: space on "app" (the project folder — inert), done · skills: none, done · confirm y
    input: streamOfKeys([SPACE, ENTER, ENTER, 'y']),
    output: sink(),
    size: () => ({ columns: 80, rows: 24 }),
    raw: false,
    readDir: fakeReadDir,
    apply: (_dir, sel) => {
      captured = sel;
      return Promise.resolve({
        created: true,
        changed: true,
        overlayPath: '/code/app/.devcontainer/devc.jsonc',
      });
    },
  };

  const result = await runProjectFlow(opts, deps);
  assertEquals(result.applied, true);
  // The container binds the project folder itself, so it must not be written as a source mount
  // (a second bind on the same target).
  assertEquals((captured as unknown as WizardSelection).source, []);
});

// ── worktree-aware source mounts ────────────────────────────────────────────────

const WFS: Record<string, string[]> = {
  '/': ['code', 'skills', 'srv'],
  '/code': ['myproject', 'myproject.worktrees', 'zlib'], // `zlib`: an unrelated plain folder

  '/code/myproject.worktrees': ['feature1', 'feature2'],
  '/srv': ['proj', 'proj.worktrees'],
  '/srv/proj.worktrees': ['f1'],
  '/skills': [],
};
const wReadDir = (p: string) => Promise.resolve(WFS[p] ?? []);

/** A fake FsProbe backed by an explicit set of `.git` files. */
function fsProbe(files: Record<string, string>): FsProbe {
  return {
    statIsFile: (p) => Promise.resolve(p in files),
    readText: (p) => Promise.resolve(files[p] ?? null),
  };
}

/** Run the flow with the worktree FS and capture the applied selection. */
async function runWith(
  keys: string[],
  files: Record<string, string>,
): Promise<WizardSelection> {
  let captured: WizardSelection | null = null;
  const deps: FlowDeps = {
    input: streamOfKeys(keys),
    output: sink(),
    size: () => ({ columns: 80, rows: 24 }),
    raw: false,
    readDir: wReadDir,
    fsProbe: fsProbe(files),
    apply: (_dir, sel) => {
      captured = sel;
      return Promise.resolve({
        created: true,
        changed: true,
        overlayPath: 'x',
      });
    },
  };
  const result = await runProjectFlow(baseOpts(), deps);
  assertEquals(result.applied, true);
  assert(captured !== null);
  return captured as unknown as WizardSelection;
}

Deno.test('worktree flow: source keeps its sub-path and mounts the primary .git', async () => {
  // start in /code, down to myproject.worktrees, open it, tick feature1, done · skills none · y
  const sel = await runWith(
    [DOWN, RIGHT, SPACE, ENTER, ENTER, 'y'],
    {
      '/code/myproject.worktrees/feature1/.git':
        'gitdir: ../../myproject/.git/worktrees/feature1\n',
    },
  );
  // The primary `.git` leads, then the worktree that needs it.
  assertEquals(sel.source, [
    {
      source: '/code/myproject/.git',
      target: '/workspaces/myproject/.git',
    },
    {
      source: '/code/myproject.worktrees/feature1',
      target: '/workspaces/myproject.worktrees/feature1',
    },
  ]);
});

Deno.test('worktree flow: an absolute-path worktree mounts the folder but not the primary', async () => {
  const sel = await runWith(
    [DOWN, RIGHT, SPACE, ENTER, ENTER, 'y'],
    {
      '/code/myproject.worktrees/feature1/.git':
        'gitdir: /code/myproject/.git/worktrees/feature1\n',
    },
  );
  assertEquals(sel.source, [
    {
      source: '/code/myproject.worktrees/feature1',
      target: '/workspaces/myproject.worktrees/feature1',
    },
  ]);
});

Deno.test('worktree flow: two worktrees of one primary share a single .git mount', async () => {
  // start in /code, down, open worktrees, tick feature1, down, tick feature2, done · skills · y
  const sel = await runWith(
    [DOWN, RIGHT, SPACE, DOWN, SPACE, ENTER, ENTER, 'y'],
    {
      '/code/myproject.worktrees/feature1/.git':
        'gitdir: ../../myproject/.git/worktrees/feature1\n',
      '/code/myproject.worktrees/feature2/.git':
        'gitdir: ../../myproject/.git/worktrees/feature2\n',
    },
  );
  const primaries = sel.source.filter((r) =>
    r.target === '/workspaces/myproject/.git'
  );
  assertEquals(primaries.length, 1);
  // Written in order: the shared `.git` first, then both worktrees behind it.
  assertEquals(sel.source.map((r) => r.target), [
    '/workspaces/myproject/.git',
    '/workspaces/myproject.worktrees/feature1',
    '/workspaces/myproject.worktrees/feature2',
  ]);
});

Deno.test('worktree flow: picking the primary working tree too skips the redundant .git mount', async () => {
  // start in /code, tick myproject, down to worktrees, open, tick feature1, done · skills · y
  const sel = await runWith(
    [SPACE, DOWN, RIGHT, SPACE, ENTER, ENTER, 'y'],
    {
      '/code/myproject.worktrees/feature1/.git':
        'gitdir: ../../myproject/.git/worktrees/feature1\n',
    },
  );
  // No separate `.git` row, but the grouping still holds: the repo, then its worktree.
  assertEquals(sel.source.map((r) => r.target), [
    '/workspaces/myproject',
    '/workspaces/myproject.worktrees/feature1',
  ]);
});

Deno.test('worktree flow: a repo groups as one block however the picks were interleaved', async () => {
  // Pick feature1, an unrelated folder, then feature2 — the two worktrees still write as one block
  // behind their `.git`, and the unrelated pick keeps its place after them.
  const sel = await runWith(
    [
      DOWN,
      RIGHT,
      SPACE, // into myproject.worktrees, tick feature1
      LEFT,
      DOWN,
      DOWN,
      SPACE, // back to /code (cursor resets to the top), down to zlib, tick it
      UP,
      RIGHT,
      DOWN,
      SPACE, // back into myproject.worktrees, tick feature2
      ENTER,
      ENTER,
      'y',
    ],
    {
      '/code/myproject.worktrees/feature1/.git':
        'gitdir: ../../myproject/.git/worktrees/feature1\n',
      '/code/myproject.worktrees/feature2/.git':
        'gitdir: ../../myproject/.git/worktrees/feature2\n',
    },
  );
  assertEquals(sel.source.map((r) => r.target), [
    '/workspaces/myproject/.git',
    '/workspaces/myproject.worktrees/feature1',
    '/workspaces/myproject.worktrees/feature2',
    '/workspaces/zlib',
  ]);
});

/**
 * Run the flow capturing every painted frame, and return the ones showing the source picker —
 * so what the user saw *while picking* can be asserted, not just what got applied.
 */
async function sourceFrames(
  keys: string[],
  files: Record<string, string>,
  opts: ProjectFlowOptions = baseOpts(),
): Promise<string[]> {
  const out: string[] = [];
  await runProjectFlow(opts, {
    input: streamOfKeys(keys),
    output: capturingSink(out),
    size: () => ({ columns: 100, rows: 24 }),
    raw: false,
    readDir: wReadDir,
    fsProbe: fsProbe(files),
    apply: () =>
      Promise.resolve({
        created: true,
        changed: false,
        overlayPath: 'x',
      }),
  });
  return out.filter((f) => f.includes('Source Folders'));
}

Deno.test('worktree flow: the primary .git shows in the picks as soon as the worktree is ticked', async () => {
  // down to myproject.worktrees, open it, tick feature1 · done · skills none · y
  const frames = await sourceFrames(
    [DOWN, RIGHT, SPACE, ENTER, ENTER, 'y'],
    {
      '/code/myproject.worktrees/feature1/.git':
        'gitdir: ../../myproject/.git/worktrees/feature1\n',
    },
  );
  // Before the tick there is nothing to drag in; after it the mount is listed under its worktree.
  assert(
    !frames[0].includes('/code/myproject/.git'),
    'the primary .git is not shown before the worktree is picked',
  );
  assertStringIncludes(
    frames[frames.length - 1],
    '◉ /code/myproject.worktrees/feature1',
  );
  assertStringIncludes(
    frames[frames.length - 1],
    '◎ /code/myproject/.git  required by worktree feature1',
  );
});

Deno.test('worktree flow: unticking the worktree takes its primary .git with it', async () => {
  // down, open worktrees, tick feature1, tick it again (untick) · done · skills none · y
  const frames = await sourceFrames(
    [DOWN, RIGHT, SPACE, SPACE, ENTER, ENTER, 'y'],
    {
      '/code/myproject.worktrees/feature1/.git':
        'gitdir: ../../myproject/.git/worktrees/feature1\n',
    },
  );
  assertStringIncludes(
    frames[frames.length - 2],
    '◎ /code/myproject/.git',
  ); // present while ticked
  assert(
    !frames[frames.length - 1].includes('/code/myproject/.git'),
    'the derived row is gone once nothing requires it',
  );
});

Deno.test('worktree flow: a worktree preselected from the fence shows its .git on the first frame', async () => {
  // Nothing is ticked during this run — the pick comes from the existing config, so the derived
  // row has to be there before any keypress, not conjured by one.
  const frames = await sourceFrames([ENTER, ENTER, 'y'], {
    '/code/myproject.worktrees/feature1/.git':
      'gitdir: ../../myproject/.git/worktrees/feature1\n',
  }, {
    ...baseOpts(),
    sourceRows: [{
      source: '/code/myproject.worktrees/feature1',
      target: '/workspaces/myproject.worktrees/feature1',
    }],
  });
  assertStringIncludes(
    frames[0],
    '◎ /code/myproject/.git  required by worktree feature1',
  );
});

Deno.test('worktree flow: a fence carrying both the worktree and its .git shows the .git once', async () => {
  // The previous run wrote the derived mount into `devc:source`, so reopening preselects it *and*
  // derives it. It has to collapse to the single inert row, not appear twice.
  const gitRow = {
    source: '/code/myproject/.git',
    target: '/workspaces/myproject/.git',
  };
  const frames = await sourceFrames([ENTER, ENTER, 'y'], {
    '/code/myproject.worktrees/feature1/.git':
      'gitdir: ../../myproject/.git/worktrees/feature1\n',
  }, {
    ...baseOpts(),
    sourceRows: [
      {
        source: '/code/myproject.worktrees/feature1',
        target: '/workspaces/myproject.worktrees/feature1',
      },
      gitRow,
    ],
  });
  const lines = frames[0].split('\r\n');
  assertEquals(
    lines.filter((l) => l.includes('/code/myproject/.git')).length,
    1,
    `the primary .git is listed once, not twice:\n${frames[0]}`,
  );
  assertStringIncludes(
    frames[0],
    '◎ /code/myproject/.git  required by worktree feature1',
  );
  assert(
    !frames[0].includes('◉ /code/myproject/.git'),
    'no removable duplicate of the derived mount',
  );
});

Deno.test("worktree flow: absorbing the fence's .git row rewrites the same fence, warning-free", async () => {
  // Dropping the absorbed pick must not drop the mount: it comes back as the derived one, at the
  // same target. Previously the two collided and the duplicate was skipped with a warning.
  let captured: WizardSelection | null = null;
  const warnings: string[] = [];
  await runProjectFlow({
    ...baseOpts(),
    sourceRows: [
      {
        source: '/code/myproject.worktrees/feature1',
        target: '/workspaces/myproject.worktrees/feature1',
      },
      {
        source: '/code/myproject/.git',
        target: '/workspaces/myproject/.git',
      },
    ],
  }, {
    input: streamOfKeys([ENTER, ENTER, 'y']),
    output: sink(),
    size: () => ({ columns: 80, rows: 24 }),
    raw: false,
    readDir: wReadDir,
    fsProbe: fsProbe({
      '/code/myproject.worktrees/feature1/.git':
        'gitdir: ../../myproject/.git/worktrees/feature1\n',
    }),
    err: (m) => warnings.push(m),
    apply: (_dir, sel) => {
      captured = sel;
      return Promise.resolve({
        created: false,
        changed: false,
        overlayPath: 'x',
      });
    },
  });
  // Rewritten primary-first, whatever order the fence on disk was in.
  assertEquals((captured as unknown as WizardSelection).source, [
    {
      source: '/code/myproject/.git',
      target: '/workspaces/myproject/.git',
    },
    {
      source: '/code/myproject.worktrees/feature1',
      target: '/workspaces/myproject.worktrees/feature1',
    },
  ]);
  assertEquals(warnings, [], 'no duplicate-target skip to report any more');
});

Deno.test('worktree flow: an invalid worktree shows the ⚠ flag and no derived row', async () => {
  const frames = await sourceFrames(
    [DOWN, RIGHT, SPACE, ENTER, ENTER, 'y'],
    {
      '/code/myproject.worktrees/feature1/.git':
        'gitdir: /code/myproject/.git/worktrees/feature1\n', // absolute → unmountable primary
    },
  );
  const last = frames[frames.length - 1];
  assertStringIncludes(
    last,
    '⚠ primary not mounted (worktree uses absolute paths)',
  );
  assert(
    !last.includes('/code/myproject/.git'),
    'an unmountable primary is flagged, never listed as a pick',
  );
});

// ── picking outside the configured roots ────────────────────────────────────────

const LEFT = '\x1b[D';

Deno.test('free navigation: ← walks out of the code root and folders there are pickable', async () => {
  // The single root opens inside /code. ← to /, down to "srv", open it, tick "proj", done.
  const sel = await runWith(
    [LEFT, DOWN, DOWN, RIGHT, SPACE, ENTER, ENTER, 'y'],
    {},
  );
  assertEquals(sel.source, [{
    source: '/srv/proj',
    // Outside every root, so the basename fallback — not a mirrored path.
    target: '/workspaces/proj',
  }]);
});

Deno.test('free navigation: a worktree outside every root still mounts its primary .git', async () => {
  // ← to /, down to "srv", open, down to "proj.worktrees", open, tick "f1", done.
  const sel = await runWith(
    [LEFT, DOWN, DOWN, RIGHT, DOWN, RIGHT, SPACE, ENTER, ENTER, 'y'],
    { '/srv/proj.worktrees/f1/.git': 'gitdir: ../../proj/.git/worktrees/f1\n' },
  );
  // Both targets mirror from /srv, their common ancestor, so `../../proj/.git` still resolves:
  // /workspaces/proj.worktrees/f1/../../proj/.git → /workspaces/proj/.git.
  assertEquals(sel.source, [
    {
      source: '/srv/proj/.git',
      target: '/workspaces/proj/.git',
    },
    {
      source: '/srv/proj.worktrees/f1',
      target: '/workspaces/proj.worktrees/f1',
    },
  ]);
});

// ── post-apply rebuild prompt ───────────────────────────────────────────────────

/** Capture every line the flow writes, so the prompts/notices can be asserted. */
function capturingSink(out: string[]): WritableStream<Uint8Array> {
  const dec = new TextDecoder();
  return new WritableStream({
    write(chunk) {
      out.push(dec.decode(chunk));
    },
  });
}

interface RebuildRun {
  result: FlowResult;
  text: string;
  rebuiltDirs: string[];
}

/**
 * Run the flow with a stub apply reporting `changed`, a stub container status, and a stub
 * rebuild — the minimal pick-one-source path plus whatever keys the prompt needs.
 */
async function runRebuild(
  changed: boolean,
  status: ContainerStatus,
  extraKeys: string[],
  opts: { failRebuild?: boolean } = {},
): Promise<RebuildRun> {
  const chunks: string[] = [];
  const rebuiltDirs: string[] = [];
  const deps: FlowDeps = {
    // src: tick "app", done · skills: none, done · confirm apply y · then extraKeys
    input: streamOfKeys([SPACE, ENTER, ENTER, 'y', ...extraKeys]),
    output: capturingSink(chunks),
    size: () => ({ columns: 80, rows: 24 }),
    raw: false,
    readDir: fakeReadDir,
    err: (m) => chunks.push(m + '\n'),
    apply: () =>
      Promise.resolve({
        created: false,
        changed,
        overlayPath: '/proj/.devcontainer/devc.jsonc',
      }),
    containerStatus: () => Promise.resolve(status),
    rebuild: (dir) => {
      rebuiltDirs.push(dir);
      if (opts.failRebuild) return Promise.reject(new Error('build blew up'));
      return Promise.resolve('abc123 running — workspace /workspaces/proj');
    },
  };
  const result = await runProjectFlow(baseOpts(), deps);
  return { result, text: chunks.join(''), rebuiltDirs };
}

Deno.test('rebuild prompt: a changed config with an existing container offers a rebuild', async () => {
  const { result, text, rebuiltDirs } = await runRebuild(true, 'running', [
    'y',
  ]);
  assertEquals(result.applied, true);
  assertEquals(result.changed, true);
  assertEquals(result.rebuilt, true);
  assertStringIncludes(text, 'must be rebuilt');
  assertStringIncludes(text, 'Rebuild now?');
  assertEquals(rebuiltDirs, ['/proj']);
  assertStringIncludes(text, 'abc123 running');
});

Deno.test('rebuild prompt: declining leaves the container alone', async () => {
  const { result, text, rebuiltDirs } = await runRebuild(true, 'stopped', [
    'n',
  ]);
  assertEquals(result.changed, true);
  assertEquals(result.rebuilt, false);
  assertEquals(rebuiltDirs, []);
  assertStringIncludes(text, "Skipped — run `devc build` when you're ready.");
});

Deno.test('rebuild prompt: an unchanged config never prompts and never rebuilds', async () => {
  // No prompt keys supplied: if the flow asked anything, it would read past the stream's end.
  const { result, text, rebuiltDirs } = await runRebuild(false, 'running', []);
  assertEquals(result.applied, true);
  assertEquals(result.changed, false);
  assertEquals(result.rebuilt, false);
  assertEquals(rebuiltDirs, []);
  assertStringIncludes(text, 'No config changes — no rebuild needed.');
  assert(!text.includes('Rebuild now?'), 'must not offer a rebuild');
  assertStringIncludes(text, 'Unchanged /proj/.devcontainer/devc.jsonc');
});

Deno.test('rebuild prompt: no container yet is worded as a first build', async () => {
  const { result, text, rebuiltDirs } = await runRebuild(true, 'missing', [
    'y',
  ]);
  assertStringIncludes(text, 'No dev container exists for this project yet.');
  assertStringIncludes(text, 'Build it now?');
  assertEquals(rebuiltDirs, ['/proj']);
  assertEquals(result.rebuilt, true);
});

Deno.test('rebuild prompt: a failed rebuild is reported, not thrown', async () => {
  const { result, text } = await runRebuild(true, 'running', ['y'], {
    failRebuild: true,
  });
  assertEquals(result.applied, true);
  assertEquals(result.rebuilt, false);
  assertStringIncludes(text, 'devc: build blew up');
});

Deno.test('rebuild prompt: without the deps the flow only points at `devc build`', async () => {
  const chunks: string[] = [];
  const deps: FlowDeps = {
    input: streamOfKeys([SPACE, ENTER, ENTER, 'y']),
    output: capturingSink(chunks),
    size: () => ({ columns: 80, rows: 24 }),
    raw: false,
    readDir: fakeReadDir,
    apply: () =>
      Promise.resolve({
        created: false,
        changed: true,
        overlayPath: '/proj/.devcontainer/devc.jsonc',
      }),
  };
  const result = await runProjectFlow(baseOpts(), deps);
  assertEquals(result.rebuilt, false);
  assertStringIncludes(chunks.join(''), 'run `devc build` to rebuild');
});

Deno.test('rebuild prompt: a failed status lookup falls back to the `devc build` hint', async () => {
  const chunks: string[] = [];
  let rebuildCalled = false;
  const deps: FlowDeps = {
    input: streamOfKeys([SPACE, ENTER, ENTER, 'y']),
    output: capturingSink(chunks),
    size: () => ({ columns: 80, rows: 24 }),
    raw: false,
    readDir: fakeReadDir,
    apply: () =>
      Promise.resolve({
        created: false,
        changed: true,
        overlayPath: '/proj/.devcontainer/devc.jsonc',
      }),
    // e.g. no docker on PATH.
    containerStatus: () => Promise.reject(new Error('docker not found')),
    rebuild: () => {
      rebuildCalled = true;
      return Promise.resolve('never');
    },
  };
  const result = await runProjectFlow(baseOpts(), deps);
  assertEquals(result.rebuilt, false);
  assertEquals(rebuildCalled, false);
  assertStringIncludes(chunks.join(''), 'run `devc build` to rebuild');
});

// ── repo scope (`devc config --repo`) ───────────────────────────────────────────────────────

interface RepoRun {
  result: FlowResult;
  text: string;
  applyOpts: unknown[];
}

/** The pick-one-source path, optionally in repo scope, with a stub apply reporting `changed`. */
async function runScoped(
  repoCommonDir: string | undefined,
  changed: boolean,
  keys = [SPACE, ENTER, ENTER, 'y'],
): Promise<RepoRun> {
  const chunks: string[] = [];
  const applyOpts: unknown[] = [];
  const overlayPath = repoCommonDir === undefined
    ? '/proj/.devcontainer/devc.jsonc'
    : '/cfg/repos/proj-12345678/devc.jsonc';
  const deps: FlowDeps = {
    input: streamOfKeys(keys),
    output: capturingSink(chunks),
    size: () => ({ columns: 80, rows: 24 }),
    raw: false,
    readDir: fakeReadDir,
    apply: (_dir, _sel, opts) => {
      applyOpts.push(opts);
      return Promise.resolve({ created: true, changed, overlayPath });
    },
  };
  const result = await runProjectFlow(
    { ...baseOpts(), overlayPath, repoCommonDir },
    deps,
  );
  return { result, text: chunks.join(''), applyOpts };
}

Deno.test('repo flow: header names the repo overlay; apply gets the repo target and seed', async () => {
  const { result, text, applyOpts } = await runScoped('/proj/.git', true);
  assertEquals(result.applied, true);
  assertStringIncludes(
    text,
    'Configuring devc mounts at /cfg/repos/proj-12345678/devc.jsonc',
  );
  assertStringIncludes(
    text,
    '(creating a new repo overlay, shared by every checkout of /proj/.git)',
  );
  assertEquals(applyOpts.length, 1);
  const opts = applyOpts[0] as {
    target: { path: string; creating: boolean };
    seedText: string;
  };
  assertEquals(opts.target, {
    path: '/cfg/repos/proj-12345678/devc.jsonc',
    creating: true,
  });
  assertStringIncludes(opts.seedText, 'Repo devc overlay for /proj/.git');
  assertStringIncludes(
    text,
    'Other checkouts of this repo pick this up on their next `devc build`.',
  );
});

Deno.test('repo flow: an unchanged apply says nothing about other checkouts', async () => {
  const { text } = await runScoped('/proj/.git', false);
  assert(!text.includes('Other checkouts'));
});

Deno.test('project flow: never mentions other checkouts, and passes apply no target', async () => {
  const { text, applyOpts } = await runScoped(undefined, true);
  assert(!text.includes('Other checkouts'));
  assert(!text.includes('repo overlay'));
  assertEquals(applyOpts, [undefined]);
});

Deno.test('repo flow: cancelling writes nothing', async () => {
  const { result, applyOpts } = await runScoped('/proj/.git', true, [ESC]);
  assertEquals(result.applied, false);
  assertEquals(applyOpts, []);
});
