// The code-root workspace mirror (`workspace_mirror.ts`), and its wiring into the merged config.

import { assert, assertEquals } from 'jsr:@std/assert@^1';
import {
  dropRedundantWorkspaceRows,
  MIRROR_REASON,
  mirrorTargetTakenReason,
  workspaceMirror,
  workspaceMirrorDecision,
  workspaceMirrorLayer,
  workspaceMirrorStatusLine,
} from '../workspace_mirror.ts';
import { ensureMergedConfig } from '../merged_config.ts';
import { withTemp } from './helpers.ts';

/** Write `text` to `path`, creating parent directories. */
async function write(path: string, text: string): Promise<void> {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(path, text);
}

/** A primary repo whose `.git` reads as a git dir (HEAD, config, objects/, hooks/). */
async function repo(path: string): Promise<void> {
  await Deno.mkdir(`${path}/.git/objects`, { recursive: true });
  await Deno.mkdir(`${path}/.git/hooks`, { recursive: true });
  await Deno.writeTextFile(`${path}/.git/HEAD`, 'ref: refs/heads/main\n');
  await Deno.writeTextFile(`${path}/.git/config`, '[core]\n');
}

/** A linked worktree at `path` whose `.git` file holds `gitdir`. */
async function worktree(path: string, gitdir: string): Promise<void> {
  await write(`${path}/.git`, `gitdir: ${gitdir}\n`);
}

// ── the decision ────────────────────────────────────────────────────────────────────────────

Deno.test('a repo under a nested code-root folder mirrors its path under the root', async () => {
  await withTemp(async (dir) => {
    const code = `${dir}/code`;
    await repo(`${code}/tools/ggg`);
    const m = await workspaceMirror({}, `${code}/tools/ggg`, [code], true);
    assertEquals(m, {
      source: `${code}/tools/ggg`,
      target: '/workspaces/tools/ggg',
      workspaceFolder: '/workspaces/tools/ggg',
      codeRoot: code,
      commonDir: null,
    });
  });
});

Deno.test('a project in a repo subfolder mounts the git root and lands in the subfolder', async () => {
  await withTemp(async (dir) => {
    const code = `${dir}/code`;
    await repo(`${code}/tools/ggg`);
    await Deno.mkdir(`${code}/tools/ggg/pkg/a`, { recursive: true });
    const m = await workspaceMirror(
      {},
      `${code}/tools/ggg/pkg/a/`,
      [code],
      true,
    );
    assertEquals(m?.source, `${code}/tools/ggg`);
    assertEquals(m?.target, '/workspaces/tools/ggg');
    assertEquals(m?.workspaceFolder, '/workspaces/tools/ggg/pkg/a');
  });
});

Deno.test('a folder that is not a repo mounts itself', async () => {
  await withTemp(async (dir) => {
    const code = `${dir}/code`;
    await Deno.mkdir(`${code}/tools/plain`, { recursive: true });
    const m = await workspaceMirror({}, `${code}/tools/plain`, [code], true);
    assertEquals(m?.source, `${code}/tools/plain`);
    assertEquals(m?.target, '/workspaces/tools/plain');
  });
});

Deno.test('a linked worktree mirrors itself and adds the primary .git mount', async () => {
  await withTemp(async (dir) => {
    const code = `${dir}/code`;
    await repo(`${code}/tools/ggg`);
    await worktree(
      `${code}/tools/ggg.worktrees/feat`,
      '../../ggg/.git/worktrees/feat',
    );
    const m = await workspaceMirror(
      {},
      `${code}/tools/ggg.worktrees/feat`,
      [code],
      true,
    );
    assertEquals(m?.target, '/workspaces/tools/ggg.worktrees/feat');
    assertEquals(m?.commonDir, {
      source: `${code}/tools/ggg/.git`,
      target: '/workspaces/tools/ggg/.git',
    });
  });
});

Deno.test('a worktree whose primary sits outside the code root is left to the CLI', async () => {
  await withTemp(async (dir) => {
    await repo(`${dir}/elsewhere/ggg`);
    await worktree(
      `${dir}/code/feat`,
      '../../elsewhere/ggg/.git/worktrees/feat',
    );
    const d = await workspaceMirrorDecision(
      {},
      `${dir}/code/feat`,
      [`${dir}/code`],
      true,
    );
    assertEquals(d.reason, MIRROR_REASON.primaryOutsideRoot);
  });
});

Deno.test('a worktree uses the longest root holding both checkouts', async () => {
  await withTemp(async (dir) => {
    const code = `${dir}/code`;
    await repo(`${code}/other/ggg`);
    await worktree(`${code}/tools/feat`, '../../other/ggg/.git/worktrees/feat');
    const m = await workspaceMirror(
      {},
      `${code}/tools/feat`,
      [code, `${code}/tools`],
      true,
    );
    assertEquals(m?.codeRoot, code);
    assertEquals(m?.target, '/workspaces/tools/feat');
    assertEquals(m?.commonDir?.target, '/workspaces/other/ggg/.git');
  });
});

Deno.test('an absolute gitdir is left to the CLI', async () => {
  await withTemp(async (dir) => {
    const code = `${dir}/code`;
    await repo(`${code}/ggg`);
    await worktree(`${code}/feat`, `${code}/ggg/.git/worktrees/feat`);
    const d = await workspaceMirrorDecision({}, `${code}/feat`, [code], true);
    assertEquals(d.reason, MIRROR_REASON.absoluteGitdir);
  });
});

Deno.test('outside every root, or the root itself, is left to the CLI', async () => {
  await withTemp(async (dir) => {
    await Deno.mkdir(`${dir}/code`, { recursive: true });
    await Deno.mkdir(`${dir}/other/x`, { recursive: true });
    for (const folder of [`${dir}/other/x`, `${dir}/code`]) {
      const d = await workspaceMirrorDecision(
        {},
        folder,
        [`${dir}/code`],
        true,
      );
      assertEquals(d.reason, MIRROR_REASON.notUnderRoot);
    }
  });
});

Deno.test('nested roots: the longest wins', async () => {
  await withTemp(async (dir) => {
    await repo(`${dir}/code/team/app`);
    const m = await workspaceMirror(
      {},
      `${dir}/code/team/app`,
      [`${dir}/code`, `${dir}/code/team/`],
      true,
    );
    assertEquals(m?.target, '/workspaces/app');
  });
});

Deno.test('an explicit workspaceMount or workspaceFolder, or compose, wins', async () => {
  await withTemp(async (dir) => {
    const code = `${dir}/code`;
    await repo(`${code}/tools/ggg`);
    const folder = `${code}/tools/ggg`;
    for (
      const config of [
        { workspaceFolder: '/workspaces/ggg' },
        { workspaceMount: 'type=bind,source=/x,target=/y' },
      ]
    ) {
      const d = await workspaceMirrorDecision(config, folder, [code], true);
      assertEquals(d.reason, MIRROR_REASON.explicit);
    }
    const d = await workspaceMirrorDecision(
      { dockerComposeFile: 'compose.yml' },
      folder,
      [code],
      true,
    );
    assertEquals(d.reason, MIRROR_REASON.compose);
  });
});

Deno.test('disabled: no mirror and no reason', async () => {
  await withTemp(async (dir) => {
    await repo(`${dir}/code/tools/ggg`);
    assertEquals(
      await workspaceMirrorDecision(
        {},
        `${dir}/code/tools/ggg`,
        [`${dir}/code`],
        false,
      ),
      { mirror: null, reason: null },
    );
  });
});

Deno.test('a mount on the target from another source turns the mirror off', async () => {
  await withTemp(async (dir) => {
    const code = `${dir}/code`;
    await repo(`${code}/tools/ggg`);
    const d = await workspaceMirrorDecision(
      { mounts: ['type=bind,source=/elsewhere,target=/workspaces/tools/ggg'] },
      `${code}/tools/ggg`,
      [code],
      true,
    );
    assertEquals(d.reason, mirrorTargetTakenReason('/elsewhere'));
  });
});

Deno.test('the same mount listed as a row is kept out of the merged mounts', async () => {
  await withTemp(async (dir) => {
    const code = `${dir}/home/code`;
    await repo(`${code}/tools/ggg`);
    const row =
      'type=bind,source=${localEnv:HOME}/code/tools/ggg,target=/workspaces/tools/ggg';
    const config = { mounts: [row, 'type=bind,source=/a,target=/b'] };
    const m = await workspaceMirror(
      config,
      `${code}/tools/ggg`,
      [code],
      true,
      undefined,
      `${dir}/home`,
    );
    assert(m !== null);
    assertEquals(
      dropRedundantWorkspaceRows(config, m, `${dir}/home`).mounts,
      ['type=bind,source=/a,target=/b'],
    );
  });
});

Deno.test('the layer sets both keys, and the common-dir mount for a worktree', () => {
  assertEquals(
    workspaceMirrorLayer({
      source: '/c/tools/ggg.worktrees/feat',
      target: '/workspaces/tools/ggg.worktrees/feat',
      workspaceFolder: '/workspaces/tools/ggg.worktrees/feat',
      codeRoot: '/c',
      commonDir: {
        source: '/c/tools/ggg/.git',
        target: '/workspaces/tools/ggg/.git',
      },
    }),
    {
      workspaceMount:
        'type=bind,source=/c/tools/ggg.worktrees/feat,target=/workspaces/tools/ggg.worktrees/feat',
      workspaceFolder: '/workspaces/tools/ggg.worktrees/feat',
      mounts: [
        'type=bind,source=/c/tools/ggg/.git,target=/workspaces/tools/ggg/.git',
      ],
    },
  );
});

// ── the status line ─────────────────────────────────────────────────────────────────────────

Deno.test('status: off prints nothing, skipped names why, stale container says so', () => {
  assertEquals(workspaceMirrorStatusLine(null, null, null), null);
  assertEquals(
    workspaceMirrorStatusLine(null, MIRROR_REASON.compose, null),
    'workspace: CLI default (Docker Compose project)',
  );
  const mirror = {
    source: '/c/tools/ggg',
    target: '/workspaces/tools/ggg',
    workspaceFolder: '/workspaces/tools/ggg',
    codeRoot: '/c',
    commonDir: null,
  };
  const base = 'workspace: /workspaces/tools/ggg (mirrored from code root /c)';
  assertEquals(workspaceMirrorStatusLine(mirror, null, null), base);
  const bind = (destination: string) => ({
    type: 'bind' as const,
    source: '/c/tools/ggg',
    destination,
    rw: true,
  });
  assertEquals(
    workspaceMirrorStatusLine(mirror, null, [bind('/workspaces/tools/ggg')]),
    base,
  );
  assertEquals(
    workspaceMirrorStatusLine(mirror, null, [bind('/workspaces/ggg')]),
    `${base} — container predates this, run devc build to apply`,
  );
});

// ── the merged config ───────────────────────────────────────────────────────────────────────

/** `ensureMergedConfig` for `project` with every real path redirected under `dir`. */
function merge(
  dir: string,
  project: string,
  mirror: { codeRoots?: string[]; mirrorCodeRoots?: boolean } = {},
) {
  return ensureMergedConfig(project, {
    cacheRoot: `${dir}/cache`,
    templatesDir: `${dir}/cache/no-templates`,
    configDir: `${dir}/config`,
    home: `${dir}/home`,
    ...mirror,
  });
}

Deno.test('merged: mirrorCodeRoots sets both keys and git protection follows the mount', async () => {
  await withTemp(async (dir) => {
    const code = `${dir}/code`;
    await repo(`${code}/tools/ggg`);
    await write(
      `${code}/tools/ggg/.devcontainer/devcontainer.json`,
      '{"image":"x"}',
    );
    const merged = await merge(dir, `${code}/tools/ggg`, {
      codeRoots: [code],
      mirrorCodeRoots: true,
    });
    assertEquals(
      merged.config.workspaceMount,
      `type=bind,source=${code}/tools/ggg,target=/workspaces/tools/ggg`,
    );
    assertEquals(merged.config.workspaceFolder, '/workspaces/tools/ggg');
    assertEquals(merged.workspaceMirror?.target, '/workspaces/tools/ggg');
    assertEquals(
      merged.protectedRows.map((r) => [r.target, r.kind]),
      [['/workspaces/tools/ggg', 'repo']],
    );
  });
});

Deno.test('merged: a worktree protects the mirrored common dir as a gitdir row', async () => {
  await withTemp(async (dir) => {
    const code = `${dir}/code`;
    await repo(`${code}/tools/ggg`);
    const wt = `${code}/tools/ggg.worktrees/feat`;
    await worktree(wt, '../../ggg/.git/worktrees/feat');
    await write(`${wt}/.devcontainer/devcontainer.json`, '{"image":"x"}');
    const merged = await merge(dir, wt, {
      codeRoots: [code],
      mirrorCodeRoots: true,
    });
    assert(
      (merged.config.mounts as string[]).includes(
        `type=bind,source=${code}/tools/ggg/.git,target=/workspaces/tools/ggg/.git`,
      ),
    );
    assertEquals(
      merged.protectedRows.map((r) => [r.target, r.kind]),
      [['/workspaces/tools/ggg/.git', 'gitdir']],
    );
  });
});

Deno.test('merged: a project-level workspaceFolder wins over the mirror', async () => {
  await withTemp(async (dir) => {
    const code = `${dir}/code`;
    await repo(`${code}/tools/ggg`);
    await write(
      `${code}/tools/ggg/.devcontainer/devcontainer.json`,
      '{"image":"x","workspaceFolder":"/workspaces/ggg"}',
    );
    const merged = await merge(dir, `${code}/tools/ggg`, {
      codeRoots: [code],
      mirrorCodeRoots: true,
    });
    assertEquals(merged.config.workspaceMount, undefined);
    assertEquals(merged.workspaceMirror, null);
    assertEquals(merged.workspaceMirrorSkipped, MIRROR_REASON.explicit);
  });
});

Deno.test('merged: off is identical to no mirror inputs at all', async () => {
  await withTemp(async (dir) => {
    const code = `${dir}/code`;
    const project = `${code}/tools/ggg`;
    await repo(project);
    await write(`${project}/.devcontainer/devcontainer.json`, '{"image":"x"}');
    const off = await merge(dir, project, {
      codeRoots: [code],
      mirrorCodeRoots: false,
    });
    const text = await Deno.readTextFile(off.path);
    // No global config in `configDir`: the default load reads the setting as off.
    const dflt = await merge(dir, project);
    assertEquals(await Deno.readTextFile(dflt.path), text);
    assertEquals(off.config.workspaceMount, undefined);
    assertEquals(dflt.workspaceMirrorSkipped, null);
  });
});

Deno.test('merged: the global config in configDir turns it on', async () => {
  await withTemp(async (dir) => {
    const code = `${dir}/code`;
    const project = `${code}/tools/ggg`;
    await repo(project);
    await write(`${project}/.devcontainer/devcontainer.json`, '{"image":"x"}');
    await write(
      `${dir}/config/config.jsonc`,
      `{ "codeRoots": ["${code}"], "mirrorCodeRoots": true }`,
    );
    const merged = await merge(dir, project);
    assertEquals(merged.workspaceMirror?.target, '/workspaces/tools/ggg');
  });
});
