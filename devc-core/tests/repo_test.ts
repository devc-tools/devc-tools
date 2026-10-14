import { assertEquals, assertRejects } from 'jsr:@std/assert@^1';
import {
  repoKey,
  RepoMetadataError,
  repoOverlayDir,
  resolveRepo,
} from '../repo.ts';
import { withTemp } from './helpers.ts';

/** Write `text` to `path`, creating parent directories. */
async function write(path: string, text: string): Promise<void> {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(path, text);
}

/** A primary checkout at `<dir>/app` with one linked worktree's git dir, as git lays them out. */
async function primaryWithWorktreeDir(dir: string, name: string) {
  await Deno.mkdir(`${dir}/app/.git/worktrees/${name}`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/app/.git/worktrees/${name}/commondir`,
    '../..\n',
  );
}

async function sha8(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 8);
}

Deno.test('resolveRepo: a .git directory is its own common dir, from the root and a subdirectory', async () => {
  await withTemp(async (dir) => {
    await Deno.mkdir(`${dir}/app/.git`, { recursive: true });
    await Deno.mkdir(`${dir}/app/src/deep`, { recursive: true });
    const expected = {
      checkoutRoot: `${dir}/app`,
      gitDir: `${dir}/app/.git`,
      commonDir: `${dir}/app/.git`,
    };
    assertEquals(await resolveRepo(`${dir}/app`), expected);
    assertEquals(await resolveRepo(`${dir}/app/src/deep`), expected);
  });
});

Deno.test('resolveRepo: a linked worktree resolves through commondir, relative or absolute gitdir', async () => {
  await withTemp(async (dir) => {
    await primaryWithWorktreeDir(dir, 'feat');
    await write(
      `${dir}/app.worktrees/feat/.git`,
      'gitdir: ../../app/.git/worktrees/feat\n',
    );
    await write(
      `${dir}/abs/.git`,
      `gitdir: ${dir}/app/.git/worktrees/feat\n`,
    );
    const rel = await resolveRepo(`${dir}/app.worktrees/feat`);
    assertEquals(rel?.gitDir, `${dir}/app/.git/worktrees/feat`);
    assertEquals(rel?.commonDir, `${dir}/app/.git`);
    assertEquals(
      (await resolveRepo(`${dir}/abs`))?.commonDir,
      `${dir}/app/.git`,
    );
  });
});

Deno.test('resolveRepo: worktrees in unrelated directories share the common dir and key', async () => {
  await withTemp(async (dir) => {
    await primaryWithWorktreeDir(dir, 'a');
    await primaryWithWorktreeDir(dir, 'b');
    await write(`${dir}/x/one/.git`, `gitdir: ${dir}/app/.git/worktrees/a\n`);
    await write(
      `${dir}/y/z/two/.git`,
      'gitdir: ../../../app/.git/worktrees/b\n',
    );
    const one = await resolveRepo(`${dir}/x/one`);
    const two = await resolveRepo(`${dir}/y/z/two`);
    const primary = await resolveRepo(`${dir}/app`);
    assertEquals(one?.commonDir, `${dir}/app/.git`);
    assertEquals(two?.commonDir, `${dir}/app/.git`);
    assertEquals(primary?.commonDir, `${dir}/app/.git`);
    assertEquals(await repoKey(one!.commonDir), await repoKey(two!.commonDir));
  });
});

Deno.test('resolveRepo: an absolute commondir is honored', async () => {
  await withTemp(async (dir) => {
    await Deno.mkdir(`${dir}/app/.git`, { recursive: true });
    await Deno.mkdir(`${dir}/elsewhere/wt`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/elsewhere/wt/commondir`,
      `${dir}/app/.git`,
    );
    await write(`${dir}/co/.git`, `gitdir: ${dir}/elsewhere/wt\n`);
    assertEquals(
      (await resolveRepo(`${dir}/co`))?.commonDir,
      `${dir}/app/.git`,
    );
  });
});

Deno.test('resolveRepo: a symlinked path gets the same identity as the real one', async () => {
  await withTemp(async (dir) => {
    await Deno.mkdir(`${dir}/real/app/.git`, { recursive: true });
    await Deno.symlink(`${dir}/real`, `${dir}/link`);
    const viaLink = await resolveRepo(`${dir}/link/app`);
    assertEquals(viaLink?.commonDir, `${dir}/real/app/.git`);
    assertEquals(
      await repoKey(viaLink!.commonDir),
      await repoKey((await resolveRepo(`${dir}/real/app`))!.commonDir),
    );
  });
});

Deno.test('resolveRepo: a submodule is its own repo, not its parent', async () => {
  await withTemp(async (dir) => {
    await Deno.mkdir(`${dir}/app/.git/modules/sub`, { recursive: true });
    await write(`${dir}/app/sub/.git`, 'gitdir: ../.git/modules/sub\n');
    const sub = await resolveRepo(`${dir}/app/sub`);
    assertEquals(sub?.commonDir, `${dir}/app/.git/modules/sub`);
    const parent = await resolveRepo(`${dir}/app`);
    assertEquals(parent?.commonDir, `${dir}/app/.git`);
    // Distinct keys: the submodule never picks up the parent's overlay.
    assertEquals(
      (await repoKey(sub!.commonDir)) === (await repoKey(parent!.commonDir)),
      false,
    );
  });
});

Deno.test('resolveRepo: a worktree of a bare repo resolves to the bare repo', async () => {
  await withTemp(async (dir) => {
    await Deno.mkdir(`${dir}/app.git/worktrees/w`, { recursive: true });
    await Deno.writeTextFile(`${dir}/app.git/worktrees/w/commondir`, '../..\n');
    await write(`${dir}/w/.git`, `gitdir: ${dir}/app.git/worktrees/w\n`);
    const repo = await resolveRepo(`${dir}/w`);
    assertEquals(repo?.commonDir, `${dir}/app.git`);
    assertEquals((await repoKey(repo!.commonDir)).startsWith('app-'), true);
  });
});

Deno.test('resolveRepo: a folder in no repo gives null', async () => {
  await withTemp(async (dir) => {
    await Deno.mkdir(`${dir}/plain`);
    assertEquals(await resolveRepo(`${dir}/plain`), null);
  });
});

Deno.test('resolveRepo: unreadable metadata is a RepoMetadataError with a reason', async () => {
  await withTemp(async (dir) => {
    await write(`${dir}/nolink/.git`, 'not a link\n');
    await assertRejects(
      () => resolveRepo(`${dir}/nolink`),
      RepoMetadataError,
      `${dir}/nolink/.git has no "gitdir:" line`,
    );
    await write(`${dir}/dangling/.git`, `gitdir: ${dir}/gone/worktrees/x\n`);
    await assertRejects(
      () => resolveRepo(`${dir}/dangling`),
      RepoMetadataError,
      `git dir ${dir}/gone/worktrees/x not found`,
    );
  });
});

Deno.test('repoKey: <name>-<first 8 hex of sha256 over the lowercased common dir>', async () => {
  const path = '/home/u/code/app/.git';
  assertEquals(await repoKey(path), `app-${await sha8(path)}`);
  assertEquals(
    await repoKey('/home/u/Code/App/.git'),
    `App-${await sha8('/home/u/code/app/.git')}`,
  );
  assertEquals(
    await repoKey('/srv/my repo.git'),
    `my-repo-${await sha8('/srv/my repo.git')}`,
  );
  assertEquals(
    await repoOverlayDir(path, '/cfg'),
    `/cfg/repos/app-${await sha8(path)}`,
  );
});

Deno.test("resolveRepo: a real git worktree shares its primary's common dir", async () => {
  await withTemp(async (dir) => {
    const git = async (...args: string[]) => {
      const out = await new Deno.Command('git', {
        args,
        cwd: dir,
        stdout: 'null',
        stderr: 'piped',
        env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      }).output();
      if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
    };
    await git('init', '-q', 'app');
    await git(
      '-C',
      'app',
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    );
    await git('-C', 'app', 'worktree', 'add', '-q', `${dir}/wt/feat`);
    const primary = await resolveRepo(`${dir}/app`);
    const worktree = await resolveRepo(`${dir}/wt/feat`);
    assertEquals(primary?.commonDir, `${dir}/app/.git`);
    assertEquals(worktree?.commonDir, `${dir}/app/.git`);
  });
});
