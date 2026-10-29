// `devc git push-plan` / `devc git push` against the real gh-push recipe, offline: a `git` shim
// first on the recipe's PATH points the GitHub remote's HTTPS URL at a local bare repo, and a
// `gh` shim answers `auth status` and `auth git-credential`, as in
// `devc-bridge/tests/gh_push_test.sh` (which covers the recipe's modes case by case).

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import {
  gitPush,
  parseGitArgs,
  parsePushPlan,
  pushKey,
  type PushOptions,
  pushPin,
  type PushPlan,
  pushPlan,
  pushPolicyDir,
} from '../git_push.ts';

const GH_PIN = 'git@github.com:acme/widget.git';
const decoder = new TextDecoder();

/** git in `cwd` under the test's own HOME, failing loudly. */
async function git(home: string, cwd: string, ...args: string[]) {
  const out = await new Deno.Command('git', {
    args: [
      '-c',
      'user.name=tester',
      '-c',
      'user.email=t@example.invalid',
      ...args,
    ],
    cwd,
    env: { HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  if (!out.success) throw new Error(decoder.decode(out.stderr));
  return decoder.decode(out.stdout).trim();
}

async function shim(path: string, body: string) {
  await Deno.writeTextFile(path, body);
  await Deno.chmod(path, 0o755);
}

/**
 * A bare `widget.git` whose default branch is `main`, a `repo` cloned from it with `origin` set to
 * {@link GH_PIN}, on a new branch `feat` with one commit, and the shims.
 */
async function world(dir: string) {
  const home = `${dir}/home`;
  await Deno.mkdir(home);
  const remote = `${dir}/widget.git`;
  const repo = `${dir}/repo`;
  await git(home, dir, 'init', '-q', '--bare', '-b', 'main', remote);
  await git(home, dir, 'init', '-q', '-b', 'main', `${dir}/seed`);
  await git(home, `${dir}/seed`, 'commit', '-q', '--allow-empty', '-m', 'seed');
  await git(home, `${dir}/seed`, 'push', '-q', remote, 'HEAD:refs/heads/main');
  await git(home, dir, 'clone', '-q', remote, repo);
  await git(home, repo, 'remote', 'set-url', 'origin', GH_PIN);
  await git(home, repo, 'checkout', '-q', '-b', 'feat');
  await git(home, repo, 'commit', '-q', '--allow-empty', '-m', 'work');
  const bin = `${dir}/bin`;
  await Deno.mkdir(bin);
  const realGit = (await new Deno.Command('sh', {
    args: ['-c', 'command -v git'],
    stdout: 'piped',
  }).output()).stdout;
  await shim(
    `${bin}/git`,
    `#!/usr/bin/env bash
args=()
for a in "$@"; do
  case $a in
    https://github.com/acme/*.git) args+=("${dir}/\${a#https://github.com/acme/}") ;;
    *) args+=("$a") ;;
  esac
done
exec ${decoder.decode(realGit).trim()} "\${args[@]}"
`,
  );
  await shim(
    `${bin}/gh`,
    `#!/bin/sh
if [ "$1 $2 $3" = "auth git-credential get" ]; then
  echo username=x-access-token
  echo password=shim-token
  exit 0
fi
[ "$1" = auth ] && exit 0
exit 99
`,
  );
  const opts: PushOptions = {
    home,
    env: { HOME: home, PATH: `${bin}:${Deno.env.get('PATH')}` },
  };
  const remoteRef = (ref: string) =>
    git(home, dir, '--git-dir', remote, 'rev-parse', '-q', '--verify', ref)
      .catch(() => null);
  return { home, remote, repo, opts, remoteRef };
}

async function withWorld(
  fn: (w: Awaited<ReturnType<typeof world>>) => Promise<void>,
) {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: 'devc-git-push-' }),
  );
  try {
    await fn(await world(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const exists = (path: string) => Deno.stat(path).then(() => true, () => false);

Deno.test('parseGitArgs: push-plan and push, with a full --sha', () => {
  const sha = 'a'.repeat(40);
  assertEquals(parseGitArgs(['push-plan', '.']), {
    command: 'push-plan',
    folder: '.',
  });
  assertEquals(parseGitArgs(['push', 'r', '--sha', sha]), {
    command: 'push',
    folder: 'r',
    sha,
  });
  assertEquals(parseGitArgs(['push', `--sha=${sha}`, 'r']).command, 'push');
  for (
    const bad of [
      [],
      ['pull', '.'],
      ['push-plan'],
      ['push-plan', '.', '--sha', sha],
      ['push-plan', 'a', 'b'],
      ['push', '.'],
      ['push', '.', '--sha'],
      ['push', '.', '--sha', 'abc1234'],
      ['push', '.', '--sha', 'main'],
      ['push', '.', '--sha', 'A'.repeat(40)],
      ['push', '.', '--sha', sha, '--force'],
    ]
  ) {
    let threw = false;
    try {
      parseGitArgs(bad);
    } catch {
      threw = true;
    }
    assert(threw, `accepted ${JSON.stringify(bad)}`);
  }
});

Deno.test('parsePushPlan accepts the type and nothing else', () => {
  const plan: PushPlan = {
    ok: true,
    folder: '/r',
    remote: GH_PIN,
    branch: 'feat',
    sha: 'a'.repeat(40),
    remoteSha: null,
    commits: [{ sha: 'a'.repeat(40), subject: 's', author: 'a' }],
    totalCommits: 1,
    defaultBranch: false,
    guarded: [],
    lfs: false,
    fastForward: true,
    upToDate: false,
  };
  assertEquals(parsePushPlan(JSON.stringify(plan)), plan);
  assertEquals(parsePushPlan('not json'), null);
  for (
    const bad of [
      { ...plan, ok: false },
      { ...plan, sha: 'main' },
      { ...plan, remoteSha: 'x' },
      { ...plan, totalCommits: 0 },
      { ...plan, guarded: [1] },
      { ...plan, lfs: 'no' },
      { ...plan, commits: [{ sha: 'a'.repeat(40), subject: 1, author: 'a' }] },
    ]
  ) assertEquals(parsePushPlan(JSON.stringify(bad)), null);
});

Deno.test('pushPin reads the branch and remote as files, and refuses what it cannot push', async () => {
  await withWorld(async ({ home, repo }) => {
    // No upstream yet: origin's URL.
    assertEquals(await pushPin(`${repo}/.`), {
      line: {
        repo,
        remote: GH_PIN,
        branch: 'feat',
        grants: ['gh-push'],
        target: repo,
      },
    });
    await git(home, repo, 'config', 'branch.feat.remote', 'origin');
    await git(home, repo, 'config', 'branch.feat.merge', 'refs/heads/other');
    assertStringIncludes(
      (await pushPin(repo) as { problem: string }).problem,
      'feat tracks other on origin',
    );
    await git(home, repo, 'config', 'branch.feat.merge', 'refs/heads/feat');
    assert('line' in await pushPin(repo));
    await git(
      home,
      repo,
      'remote',
      'set-url',
      'origin',
      'https://gitlab.com/a/b.git',
    );
    assertStringIncludes(
      (await pushPin(repo) as { problem: string }).problem,
      'is not a GitHub remote',
    );
    await git(home, repo, 'checkout', '-q', '--detach');
    assertStringIncludes(
      (await pushPin(repo) as { problem: string }).problem,
      'HEAD is detached',
    );
    assertStringIncludes(
      (await pushPin(`${repo}/missing`) as { problem: string }).problem,
      'does not exist',
    );
  });
});

Deno.test('push-plan, then push of its sha, through the mirror', async () => {
  await withWorld(async ({ home, repo, opts, remoteRef }) => {
    const tip = await git(home, repo, 'rev-parse', 'feat');
    const plan = await pushPlan(repo, opts);
    assertEquals(plan, {
      ok: true,
      folder: repo,
      remote: GH_PIN,
      branch: 'feat',
      sha: tip,
      remoteSha: null,
      commits: [{ sha: tip, subject: 'work', author: 'tester' }],
      totalCommits: 1,
      defaultBranch: false,
      guarded: [],
      lfs: false,
      fastForward: true,
      upToDate: false,
    });
    // The policy it wrote: one line, gh-push, under push-policy/, private.
    const policy = `${pushPolicyDir(home)}/${pushKey(repo)}.conf`;
    assertEquals(
      await Deno.readTextFile(policy),
      `${repo}\t${GH_PIN}\tfeat\tgh-push\t${repo}\n`,
    );
    assertEquals((await Deno.stat(policy)).mode! & 0o777, 0o600);
    assertEquals(await remoteRef('refs/heads/feat'), null);

    assertEquals(await gitPush(repo, tip, opts), 0);
    assertEquals(await remoteRef('refs/heads/feat'), tip);
    const after = await pushPlan(repo, opts);
    assert(after.ok && after.upToDate && after.totalCommits === 0);
  });
});

Deno.test('push refuses a sha the branch has moved past, and pushes nothing', async () => {
  await withWorld(async ({ home, repo, opts, remoteRef }) => {
    const plan = await pushPlan(repo, opts);
    assert(plan.ok);
    await git(home, repo, 'commit', '-q', '--allow-empty', '-m', 'late');
    assertEquals(await gitPush(repo, plan.sha, opts), 2);
    assertEquals(await remoteRef('refs/heads/feat'), null);
  });
});

Deno.test('the default branch is allowed, and said so', async () => {
  await withWorld(async ({ home, repo, opts, remoteRef }) => {
    await git(home, repo, 'checkout', '-q', 'main');
    await git(home, repo, 'commit', '-q', '--allow-empty', '-m', 'on main');
    const plan = await pushPlan(repo, opts);
    assert(
      plan.ok && plan.defaultBranch && plan.totalCommits === 1,
      JSON.stringify(plan),
    );
    assertEquals(await gitPush(repo, plan.sha, opts), 0);
    assertEquals(await remoteRef('refs/heads/main'), plan.sha);
  });
});

Deno.test("a problem is ok: false with the recipe's reason", async () => {
  await withWorld(async ({ repo, opts }) => {
    // gh not logged in: the recipe's exit 4, its message without the prefix.
    await shim(`${opts.env!.PATH.split(':')[0]}/gh`, '#!/bin/sh\nexit 1\n');
    const plan = await pushPlan(repo, opts);
    assertEquals(plan.ok, false);
    assertStringIncludes(
      (plan as { problem: string }).problem,
      'gh is not authenticated',
    );
    assert(!(plan as { problem: string }).problem.startsWith('gh-push:'));
  });
  assertEquals((await pushPlan('/nonexistent/repo')).ok, false);
});

Deno.test("the repo's hooks and core.fsmonitor never run", async () => {
  await withWorld(async ({ home, repo, opts, remoteRef }) => {
    const mark = `${home}/marks`;
    await Deno.mkdir(mark);
    await shim(
      `${repo}/.git/hooks/pre-push`,
      `#!/bin/sh\ntouch ${mark}/pre-push\n`,
    );
    await shim(`${home}/fsmonitor`, `#!/bin/sh\ntouch ${mark}/fsmonitor\n`);
    await git(home, repo, 'config', 'core.fsmonitor', `${home}/fsmonitor`);
    const plan = await pushPlan(repo, opts);
    assert(plan.ok);
    assertEquals(await gitPush(repo, plan.sha, opts), 0);
    assertEquals(await remoteRef('refs/heads/feat'), plan.sha);
    assertEquals(await exists(`${mark}/pre-push`), false);
    assertEquals(await exists(`${mark}/fsmonitor`), false);
  });
});
