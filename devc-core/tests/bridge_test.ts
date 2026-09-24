// devc-bridge per-container identity, pure half: the key, the policy line, and the pin read out
// of a repo. The one property worth the most here is that deriving a pin never runs git — a
// planted `core.fsmonitor` in every repo fixture below is the tripwire for it.

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from 'jsr:@std/assert@^1';
import {
  bridgePaths,
  parseGitdirPointer,
  parseHead,
  parseOriginUrl,
  parsePolicy,
  resolvePin,
  serializePolicy,
} from '../bridge.ts';
import { projectKey } from '../merged_config.ts';
import { withTemp } from './helpers.ts';

const SHA1 = '0123456789abcdef0123456789abcdef01234567';

async function write(path: string, text: string): Promise<void> {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(path, text);
}

/**
 * A repo made of files alone — no `git init` — with `core.fsmonitor` set to a script that drops a
 * marker. If anything under test ran git in here, the marker would exist.
 */
async function trappedRepo(
  root: string,
  opts: { head?: string; config?: string } = {},
): Promise<{ root: string; marker: string }> {
  const marker = `${root}.fsmonitor-fired`;
  const hook = `${root}.fsmonitor.sh`;
  await write(hook, `#!/bin/sh\ntouch '${marker}'\n`);
  await Deno.chmod(hook, 0o755);
  await write(`${root}/.git/HEAD`, opts.head ?? 'ref: refs/heads/main\n');
  await Deno.mkdir(`${root}/.git/objects`, { recursive: true });
  await Deno.mkdir(`${root}/.git/refs/heads`, { recursive: true });
  await write(
    `${root}/.git/config`,
    opts.config ??
      `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = ${hook}\n` +
        `[remote "origin"]\n\turl = git@github.com:acme/app.git\n` +
        `\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
  return { root, marker };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

// ── the key ─────────────────────────────────────────────────────────────────────────────────

Deno.test('the key is stable for a workspace and differs per worktree', async () => {
  const a1 = await projectKey('/Users/me/code/app');
  const a2 = await projectKey('/Users/me/code/app');
  const wt1 = await projectKey('/Users/me/code/app.worktrees/feat-x');
  const wt2 = await projectKey('/Users/me/code/app.worktrees/feat-y');
  assertEquals(a1, a2);
  assertEquals(new Set([a1, wt1, wt2]).size, 3);
  for (const key of [a1, wt1, wt2]) {
    assert(/^[A-Za-z0-9_.-]+-[0-9a-f]{8}$/.test(key), key);
  }
});

Deno.test('bridgePaths: token under keys/<key>/, policy outside it', () => {
  const p = bridgePaths('/Users/me', 'app-1a2b3c4d');
  assertEquals(p.keyDir, '/Users/me/.config/devc-bridge/keys/app-1a2b3c4d');
  assertEquals(p.tokenFile, `${p.keyDir}/token`);
  assertEquals(
    p.policyFile,
    '/Users/me/.config/devc-bridge/policy/app-1a2b3c4d.conf',
  );
  assert(!p.policyFile.startsWith(p.keysDir));
  assert(!p.keyDir.includes('/run/'));
});

// ── the policy line ─────────────────────────────────────────────────────────────────────────

Deno.test('policy: serialize and parse round-trip one tab-separated line', () => {
  const record = {
    repo: '/Users/me/code/app',
    remote: 'git@github.com:acme/app.git',
    branch: 'feat/x',
  };
  const text = serializePolicy(record);
  assertEquals(
    text,
    '/Users/me/code/app\tgit@github.com:acme/app.git\tfeat/x\n',
  );
  assertEquals(parsePolicy(text), record);
});

Deno.test('policy: a malformed file parses to null', () => {
  for (
    const text of [
      '',
      '\n',
      '/a\tb\n',
      '/a\tb\tc\td\n',
      '/a\t\tc\n',
      '/a\tb\tc\n/d\te\tf\n',
      '/a\tb\tc\r\n',
    ]
  ) {
    assertEquals(parsePolicy(text), null, JSON.stringify(text));
  }
});

Deno.test('policy: serialize refuses a field that would not read back', () => {
  let threw = false;
  try {
    serializePolicy({ repo: '/a', remote: 'x\ty', branch: 'main' });
  } catch {
    threw = true;
  }
  assert(threw);
});

// ── HEAD and gitdir ─────────────────────────────────────────────────────────────────────────

Deno.test('parseHead: branch, detached, and everything else', () => {
  assertEquals(parseHead('ref: refs/heads/main\n'), {
    kind: 'branch',
    name: 'main',
  });
  assertEquals(parseHead('ref: refs/heads/feat/x'), {
    kind: 'branch',
    name: 'feat/x',
  });
  assertEquals(parseHead(`${SHA1}\n`), { kind: 'detached' });
  assertEquals(parseHead(`${'a'.repeat(64)}\n`), { kind: 'detached' });
  assertEquals(parseHead('ref: refs/remotes/origin/main\n'), {
    kind: 'invalid',
  });
  assertEquals(parseHead('ref: refs/tags/v1\n'), { kind: 'invalid' });
  assertEquals(parseHead('garbage\n'), { kind: 'invalid' });
  assertEquals(parseHead('ref: refs/heads/a\tb\n'), { kind: 'invalid' });
});

Deno.test('parseGitdirPointer reads the gitdir: line', () => {
  assertEquals(
    parseGitdirPointer('gitdir: ../app/.git/worktrees/feat\n'),
    '../app/.git/worktrees/feat',
  );
  assertEquals(parseGitdirPointer('nothing here\n'), null);
});

// ── remote.origin.url ───────────────────────────────────────────────────────────────────────

Deno.test('parseOriginUrl: the plain case, quoting, comments and case rules', () => {
  assertEquals(
    parseOriginUrl('[remote "origin"]\n\turl = git@github.com:a/b.git\n'),
    { ok: true, url: 'git@github.com:a/b.git' },
  );
  assertEquals(
    parseOriginUrl('[REMOTE "origin"]\n\tURL = "https://x/y.git" # c\n'),
    { ok: true, url: 'https://x/y.git' },
  );
  // Only `origin`, and the subsection is case-sensitive.
  assertEquals(
    parseOriginUrl(
      '[remote "Origin"]\n\turl = wrong\n[remote "upstream"]\n\turl = wrong\n' +
        '[remote "origin"]\n\turl = right ; trailing\n',
    ),
    { ok: true, url: 'right' },
  );
});

Deno.test('parseOriginUrl refuses anything ambiguous, each with a reason', () => {
  const cases: [string, string][] = [
    ['[core]\n\tbare = false\n', 'no remote.origin.url'],
    [
      '[remote "origin"]\n\turl = a\n\turl = b\n',
      'set 2 times',
    ],
    [
      '[include]\n\tpath = ../x.conf\n[remote "origin"]\n\turl = a\n',
      '[include]',
    ],
    [
      '[includeIf "gitdir:~/x/"]\n\tpath = y\n[remote "origin"]\n\turl = a\n',
      '[includeIf]',
    ],
    ['[remote "origin"]\n\turl = a\\\n', 'continued'],
    ['[remote "origin"]\n\turl = "a\n', 'unterminated'],
  ];
  for (const [text, reason] of cases) {
    const got = parseOriginUrl(text);
    assert(!got.ok, `accepted ${JSON.stringify(text)}`);
    assertStringIncludes(got.reason, reason);
  }
});

// ── resolvePin: files only, never git ───────────────────────────────────────────────────────

Deno.test('resolvePin: an attached branch, without ever running git', async () => {
  await withTemp(async (dir) => {
    const { root, marker } = await trappedRepo(`${dir}/app`, {
      head: 'ref: refs/heads/feat/x\n',
    });
    const pin = await resolvePin(root);
    assertEquals(pin, {
      ok: true,
      record: {
        repo: root,
        remote: 'git@github.com:acme/app.git',
        branch: 'feat/x',
      },
      worktree: false,
    });
    assertEquals(await exists(marker), false, 'git ran in the repo');
  });
});

Deno.test('the fsmonitor tripwire is live — running git in the fixture does fire it', async () => {
  // Proves the negative assertions above mean something: if the trap could not fire, "the marker
  // is absent" would pass whether or not devc had run git.
  await withTemp(async (dir) => {
    const { root, marker } = await trappedRepo(`${dir}/app`);
    await new Deno.Command('git', {
      args: ['-C', root, 'status', '--porcelain'],
      stdout: 'null',
      stderr: 'null',
    }).output();
    assertEquals(await exists(marker), true);
  });
});

Deno.test('resolvePin: a detached HEAD fails closed', async () => {
  await withTemp(async (dir) => {
    const { root, marker } = await trappedRepo(`${dir}/app`, {
      head: `${SHA1}\n`,
    });
    const pin = await resolvePin(root);
    assert(!pin.ok);
    assertStringIncludes(pin.reason, 'detached');
    assertEquals(await exists(marker), false);
  });
});

Deno.test('resolvePin: a linked worktree follows gitdir: for HEAD and commondir for config', async () => {
  await withTemp(async (dir) => {
    const { root: primary, marker } = await trappedRepo(`${dir}/app`);
    const wtGitDir = `${primary}/.git/worktrees/feat`;
    await write(`${wtGitDir}/HEAD`, 'ref: refs/heads/feat/y\n');
    await write(`${wtGitDir}/commondir`, '../..\n');
    const worktree = `${dir}/app.worktrees/feat`;
    await write(`${worktree}/.git`, 'gitdir: ../../app/.git/worktrees/feat\n');

    const pin = await resolvePin(worktree);
    assertEquals(pin, {
      ok: true,
      record: {
        repo: worktree,
        remote: 'git@github.com:acme/app.git',
        branch: 'feat/y',
      },
      worktree: true,
    });
    assertEquals(await exists(marker), false, 'git ran in the repo');
  });
});

Deno.test('resolvePin: not a repo, and a repo with no origin, each name the reason', async () => {
  await withTemp(async (dir) => {
    await Deno.mkdir(`${dir}/plain`);
    const notRepo = await resolvePin(`${dir}/plain`);
    assert(!notRepo.ok);
    assertStringIncludes(notRepo.reason, 'not a git repository');

    const { root } = await trappedRepo(`${dir}/app`, {
      config: '[core]\n\tbare = false\n',
    });
    const noOrigin = await resolvePin(root);
    assert(!noOrigin.ok);
    assertStringIncludes(noOrigin.reason, 'remote.origin.url');
  });
});

Deno.test('resolvePin: two worktrees of one repo give two different pins', async () => {
  await withTemp(async (dir) => {
    const { root: primary } = await trappedRepo(`${dir}/app`);
    for (const name of ['a', 'b']) {
      await write(
        `${primary}/.git/worktrees/${name}/HEAD`,
        `ref: refs/heads/${name}\n`,
      );
      await write(`${primary}/.git/worktrees/${name}/commondir`, '../..\n');
      await write(
        `${dir}/app.worktrees/${name}/.git`,
        `gitdir: ../../app/.git/worktrees/${name}\n`,
      );
    }
    const a = await resolvePin(`${dir}/app.worktrees/a`);
    const b = await resolvePin(`${dir}/app.worktrees/b`);
    assert(a.ok && b.ok);
    assertNotEquals(a.record.branch, b.record.branch);
  });
});
