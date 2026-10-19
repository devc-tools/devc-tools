import { assertEquals } from 'jsr:@std/assert';
import {
  isFetchableRemote,
  mountedRepos,
  parseUpstream,
  readBranch,
  resolveRepo,
} from '../web/git_repo.ts';

async function git(cwd: string, ...args: string[]) {
  const out = await new Deno.Command('git', {
    args: ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    cwd,
    stdout: 'null',
    stderr: 'piped',
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
}

const list = (...entries: [string, string][]) =>
  entries.map(([k, v]) => `${k}\n${v}`).join('\0') + '\0';

Deno.test("parseUpstream reads a branch's remote, merge and url", () => {
  const config = list(
    ['remote.origin.url', 'git@github.com:o/r.git'],
    ['remote.origin.url', 'https://mirror.example/o/r.git'],
    ['branch.feat/x.remote', 'origin'],
    ['branch.feat/x.merge', 'refs/heads/feat/x'],
    ['branch.local.remote', '.'],
    ['branch.local.merge', 'refs/heads/main'],
    ['branch.direct.remote', 'https://github.com/o/r.git'],
    ['branch.direct.merge', 'refs/heads/main'],
  );
  assertEquals(parseUpstream(config, 'feat/x'), {
    remote: 'origin',
    url: 'git@github.com:o/r.git',
    branch: 'feat/x',
    trackingRef: 'refs/remotes/origin/feat/x',
  });
  assertEquals(parseUpstream(config, 'local'), null);
  assertEquals(parseUpstream(config, 'none'), null);
  assertEquals(parseUpstream(config, 'direct'), {
    remote: 'https://github.com/o/r.git',
    url: 'https://github.com/o/r.git',
    branch: 'main',
    trackingRef: null,
  });
});

Deno.test('isFetchableRemote allows https, ssh and scp-style only', () => {
  for (
    const url of [
      'https://github.com/o/r.git',
      'ssh://git@github.com/o/r.git',
      'git@github.com:o/r.git',
      'git@github.com-work:o/r',
    ]
  ) assertEquals(isFetchableRemote(url), true, url);
  for (
    const url of [
      'ext::sh -c touch% /tmp/x',
      'file:///Users/me/secret',
      '/Users/me/secret',
      '../other',
      'ssh://-oProxyCommand=x/r',
      'git@-oProxyCommand=x:r',
      'http://github.com/o/r',
      'https://github.com/o/r x',
    ]
  ) assertEquals(isFetchableRemote(url), false, url);
});

Deno.test('resolveRepo: a primary, an honest worktree, and forged pointers', async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    const main = `${dir}/app`;
    await git(dir, 'init', '-q', '-b', 'main', main);
    await git(main, 'commit', '-q', '--allow-empty', '-m', 'one');
    await git(
      main,
      'worktree',
      'add',
      '-q',
      '-b',
      'feat',
      `${dir}/app.worktrees/feat`,
    );
    assertEquals(await resolveRepo(main), {
      gitDir: `${main}/.git`,
      commonDir: `${main}/.git`,
    });
    const wt = await resolveRepo(`${dir}/app.worktrees/feat`);
    assertEquals(wt, {
      gitDir: `${main}/.git/worktrees/feat`,
      commonDir: `${main}/.git`,
    });
    assertEquals(await readBranch(wt!.gitDir), 'feat');
    assertEquals(await resolveRepo(dir), null);

    // A pointer at some other git dir, and one whose dir doesn't point back.
    const fake = `${dir}/fake`;
    await Deno.mkdir(fake);
    await Deno.writeTextFile(`${fake}/.git`, `gitdir: ${main}/.git\n`);
    assertEquals(await resolveRepo(fake), null);
    await Deno.writeTextFile(
      `${fake}/.git`,
      `gitdir: ${main}/.git/worktrees/feat\n`,
    );
    assertEquals(await resolveRepo(fake), null);
    // A primary that borrows another repo's refs.
    await Deno.writeTextFile(`${main}/.git/commondir`, '../elsewhere\n');
    assertEquals(await resolveRepo(main), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('mountedRepos lists the primary, other repos, and worktrees under their repo', async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    for (const name of ['proj', 'tools/zeta', 'tools/alpha']) {
      await git(dir, 'init', '-q', '-b', 'main', `${dir}/${name}`);
      await git(`${dir}/${name}`, 'commit', '-q', '--allow-empty', '-m', 'one');
    }
    const alpha = `${dir}/tools/alpha`;
    await git(
      alpha,
      'worktree',
      'add',
      '-q',
      '-b',
      'b',
      `${dir}/tools/alpha.worktrees/b`,
    );
    await git(
      alpha,
      'worktree',
      'add',
      '-q',
      '-b',
      'a',
      `${dir}/tools/alpha.worktrees/a`,
    );
    await Deno.mkdir(`${dir}/skills`);
    const repos = await mountedRepos(`${dir}/proj`, [
      `${dir}/proj`,
      `${dir}/proj/node_modules`,
      `${dir}/tools/zeta`,
      `${dir}/tools/zeta/.git`,
      `${dir}/tools/zeta/.git/config`,
      `${dir}/tools/alpha.worktrees`,
      alpha,
      `${dir}/skills`,
    ]);
    assertEquals(repos, [
      { folder: `${dir}/proj`, worktreeOf: null, containerFolder: null },
      { folder: alpha, worktreeOf: null, containerFolder: null },
      {
        folder: `${dir}/tools/alpha.worktrees/a`,
        worktreeOf: alpha,
        containerFolder: null,
      },
      {
        folder: `${dir}/tools/alpha.worktrees/b`,
        worktreeOf: alpha,
        containerFolder: null,
      },
      { folder: `${dir}/tools/zeta`, worktreeOf: null, containerFolder: null },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
