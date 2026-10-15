// devc-bridge per-container identity, pure half: the key, the policy line, and the pin read out
// of a repo. The one property worth the most here is that deriving a pin never runs git — a
// planted `core.fsmonitor` in every repo fixture below is the tripwire for it.

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
  assertThrows,
} from 'jsr:@std/assert@^1';
import {
  BRIDGE_CAPABILITIES,
  BRIDGE_CAPABILITY_COMMANDS,
  type BridgeCapability,
  bridgePaths,
  capabilityForCommand,
  gitHubRepoOf,
  isGitHubRemote,
  parseGitdirPointer,
  parseHead,
  parseOriginUrl,
  parsePolicy,
  policyProblem,
  type PolicyRecord,
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

// ── the policy lines ────────────────────────────────────────────────────────────────────────

/** One v2 policy line. */
const line = (
  repo: string,
  target: string,
  grants = 'gh-push',
  remote = 'git@github.com:acme/app.git',
  branch = 'feat/x',
) => `${repo}\t${remote}\t${branch}\t${grants}\t${target}\n`;

Deno.test('policy: a one-line policy round-trips as five tab-separated fields', () => {
  const record: PolicyRecord = {
    grants: ['gh-push', 'gh-pr-review'],
    repos: [{
      repo: '/Users/me/code/app',
      remote: 'git@github.com:acme/app.git',
      branch: 'feat/x',
      target: '/workspaces/app',
    }],
  };
  const text = serializePolicy(record);
  assertEquals(
    text,
    '/Users/me/code/app\tgit@github.com:acme/app.git\tfeat/x\tgh-push,gh-pr-review\t/workspaces/app\n',
  );
  assertEquals(parsePolicy(text), record);
});

Deno.test('policy: a three-line policy round-trips, workspace first, grants on every line', () => {
  const record: PolicyRecord = {
    grants: ['gh-push', 'gh-pr-review', 'gh-pr-resolve'],
    repos: [
      {
        repo: '/Users/me/code/app',
        remote: 'git@github.com:acme/app.git',
        branch: 'feat/x',
        target: '/workspaces/app',
      },
      {
        repo: '/Users/me/code/tools/lib',
        remote: 'https://github.com/acme/lib',
        branch: 'feat/lib',
        target: '/workspaces/tools/lib',
      },
      {
        repo: '/Users/me/code/docs',
        remote: 'ssh://git@github.com-work/acme/docs.git',
        branch: 'fix/typo',
        target: '/workspaces/docs',
      },
    ],
  };
  const text = serializePolicy(record);
  const grants = 'gh-push,gh-pr-review,gh-pr-resolve';
  assertEquals(
    text,
    `/Users/me/code/app\tgit@github.com:acme/app.git\tfeat/x\t${grants}\t/workspaces/app\n` +
      `/Users/me/code/tools/lib\thttps://github.com/acme/lib\tfeat/lib\t${grants}\t/workspaces/tools/lib\n` +
      `/Users/me/code/docs\tssh://git@github.com-work/acme/docs.git\tfix/typo\t${grants}\t/workspaces/docs\n`,
  );
  assertEquals(parsePolicy(text), record);
});

Deno.test('policy: every valid grant set round-trips', () => {
  const sets: BridgeCapability[][] = [
    ['gh-push'],
    ['gh-pr-review'],
    ['gh-push', 'gh-pr-review'],
    ['gh-pr-review', 'gh-pr-resolve'],
    ['gh-push', 'gh-pr-review', 'gh-pr-resolve'],
    ['gh-pr-review', 'gh-pr-request-review'],
    ['gh-push', 'gh-pr-review', 'gh-pr-resolve', 'gh-pr-request-review'],
  ];
  for (const grants of sets) {
    const record: PolicyRecord = {
      grants,
      repos: [{ repo: '/a', remote: 'r', branch: 'b', target: '/w' }],
    };
    assertEquals(
      parsePolicy(serializePolicy(record)),
      record,
      grants.join(','),
    );
  }
});

Deno.test('policy: a malformed file parses to null', () => {
  for (
    const text of [
      '',
      '\n',
      '/a\tb\n',
      '/a\tb\tc\n', // three fields: a file from before grants existed
      '/a\tb\tc\tgh-push\n', // four fields: a v1 file, from before targets existed
      '/a\tb\tc\tgh-push\t/w', // no final newline
      '/a\tb\tc\tgh-push\t/w\n\n', // a trailing empty line
      '/a\tb\tc\tgh-push\t/w\te\n',
      '/a\t\tc\tgh-push\t/w\n',
      '/a\tb\tc\t\t/w\n', // empty grants
      '/a\tb\tc\tgh-push\t\n', // empty target
      '/a\tb\tc\tgh-push\t/w\r\n',
      line('/a', 'w'), // a relative target
      line('/a', '/'),
      line('/a', '/w/'),
      line('/a', '/w//x'),
      line('/a', '/w/./x'),
      line('/a', '/w/../x'),
      line('/a', '/w/..'),
      line('/a', '/w', 'git-pull'), // unknown capability
      line('/a', '/w', 'git-push'), // a name from before the gh- rename
      line('/a', '/w', 'gh-push,pr-review'), // … even alongside a current one
      line('/a', '/w', 'gh'), // the wildcard is devc's to expand, never a policy's
      line('/a', '/w', 'gh-push,gh-push'), // duplicate
      line('/a', '/w', 'gh-pr-review,gh-push'), // out of canonical order
      line('/a', '/w', 'gh-push, gh-pr-review'), // a space
      line('/a', '/w', 'gh-push,'), // trailing comma
      line('/a', '/w', 'gh-pr-resolve'), // gh-pr-resolve without gh-pr-review
      line('/a', '/w', 'gh-pr-request-review'), // gh-pr-request-review without gh-pr-review
      line('/a', '/w', 'gh-push,gh-pr-resolve,gh-pr-request-review'), // … even alongside gh-pr-resolve
      line('/a', '/w', 'gh-pr-review,gh-pr-request-review,gh-pr-resolve'), // out of canonical order
      line('/a', '/w') + line('/b', '/x', 'gh-push,gh-pr-review'), // grants differ
      line('/a', '/w') + line('/a', '/x'), // the same repo twice
      line('/a', '/w') + line('/b', '/w'), // the same target twice
      line('/a', '/w') + '\n' + line('/b', '/x'), // an empty middle line
    ]
  ) {
    assertEquals(parsePolicy(text), null, JSON.stringify(text));
  }
});

Deno.test('policy: policyProblem names the first problem, and parsePolicy agrees', () => {
  const seventeen = Array.from(
    { length: 17 },
    (_, i) => line(`/r${i}`, `/w${i}`),
  )
    .join('');
  const sixteen = Array.from({ length: 16 }, (_, i) => line(`/r${i}`, `/w${i}`))
    .join('');
  const cases: [string, string | null][] = [
    ['', 'the file does not end with a newline'],
    ['/a\tb\tc\tgh-push\t/w', 'the file does not end with a newline'],
    ['\n', 'line 1 is empty'],
    ['/a\tb\tc\tgh-push\n', 'line 1: want 5 tab-separated fields, found 4'],
    ['/a\tb\tc\n', 'line 1: want 5 tab-separated fields, found 3'],
    [
      '/a\tb\tc\tgh-push\t/w\tx\n',
      'line 1: want 5 tab-separated fields, found 6',
    ],
    ['/a\tb\t\tgh-push\t/w\n', 'line 1: branch is empty'],
    ['/a\t\t\tgh-push\t/w\n', 'line 1: remote is empty'],
    ['/a\tb\tc\t\t/w\n', 'line 1: grants is empty'],
    [
      '/a\tb\tc\tgh-push\t/w\r\n',
      'line 1: target contains a tab, newline or other control character',
    ],
    [line('/a', 'w'), 'line 1: target is not an absolute path'],
    [line('/a', '/'), 'line 1: target is /'],
    [line('/a', '/w/'), 'line 1: target ends with /'],
    [line('/a', '/w/../x'), 'line 1: target has an empty, . or .. segment'],
    [line('/a', '/w//x'), 'line 1: target has an empty, . or .. segment'],
    [
      line('/a', '/w', 'gh-push,gh-nope'),
      'line 1: unknown capability "gh-nope"',
    ],
    [
      line('/a', '/w', 'gh-pr-resolve'),
      'line 1: gh-pr-resolve requires gh-pr-review',
    ],
    [
      line('/a', '/w') + line('/b', '/x', 'gh-push,gh-pr-review'),
      "line 2: grants differ from line 1's",
    ],
    [line('/a', '/w') + line('/a', '/x'), "line 2: repo repeats line 1's"],
    [
      line('/a', '/w') + line('/b', '/x') + line('/c', '/w'),
      "line 3: target repeats line 1's",
    ],
    [line('/a', '/w') + '\n' + line('/b', '/x'), 'line 2 is empty'],
    [line('/a', '/w') + '\n', 'line 2 is empty'],
    [seventeen, 'more than 16 lines'],
    [sixteen, null],
    [line('/a', '/w', 'gh-push,gh-pr-review'), null],
    [line('/a', '/w') + line('/b', '/x'), null],
  ];
  for (const [text, want] of cases) {
    assertEquals(policyProblem(text), want, JSON.stringify(text));
    assertEquals(
      parsePolicy(text) === null,
      want !== null,
      JSON.stringify(text),
    );
  }
});

Deno.test('policy: serialize refuses a field that would not read back', () => {
  const ok = { repo: '/a', remote: 'r', branch: 'main', target: '/w' };
  const bad: PolicyRecord[] = [
    { grants: ['gh-push'], repos: [{ ...ok, remote: 'x\ty' }] },
    { grants: ['gh-push'], repos: [{ ...ok, branch: 'x\ny' }] },
    { grants: ['gh-push'], repos: [{ ...ok, target: '/w/' }] },
    { grants: ['gh-push'], repos: [] },
    { grants: ['gh-push'], repos: [ok, { ...ok, target: '/x' }] },
    { grants: [], repos: [ok] },
    { grants: ['gh-pr-review', 'gh-push'], repos: [ok] },
    { grants: ['gh-push', 'gh-push'], repos: [ok] },
    { grants: ['gh-pr-resolve'], repos: [ok] },
    { grants: ['gh-pr-request-review'], repos: [ok] },
    { grants: ['nope' as BridgeCapability], repos: [ok] },
  ];
  for (const record of bad) {
    assertThrows(
      () => serializePolicy(record),
      Error,
      undefined,
      JSON.stringify(record),
    );
  }
});

Deno.test('gitHubRepoOf: owner/name from each remote shape, null otherwise', () => {
  for (
    const url of [
      'git@github.com:acme/x.git',
      'git@github.com-work:acme/x',
      'ssh://git@github.com/acme/x.git',
      'https://github.com/acme/x',
    ]
  ) {
    assertEquals(gitHubRepoOf(url), 'acme/x', url);
  }
  assertEquals(gitHubRepoOf('git@gitlab.com:acme/x.git'), null);
  assertEquals(gitHubRepoOf('https://github.com/acme'), null);
});

Deno.test('capabilities: the canonical order', () => {
  assertEquals(
    [...BRIDGE_CAPABILITIES],
    ['gh-push', 'gh-pr-review', 'gh-pr-resolve', 'gh-pr-request-review'],
  );
});

Deno.test('capabilities: every built-in command maps to exactly one capability', () => {
  assertEquals(capabilityForCommand('gh-push'), 'gh-push');
  assertEquals(capabilityForCommand('gh-doctor'), 'gh-push');
  assertEquals(capabilityForCommand('gh-pr-comments'), 'gh-pr-review');
  assertEquals(capabilityForCommand('gh-pr-reply'), 'gh-pr-review');
  assertEquals(capabilityForCommand('gh-pr-resolve'), 'gh-pr-resolve');
  assertEquals(
    capabilityForCommand('gh-pr-request-review'),
    'gh-pr-request-review',
  );
  assertEquals(capabilityForCommand('caffeinate'), null);
  for (const old of ['git-push', 'git-doctor', 'pr-comments', 'pr-resolve']) {
    assertEquals(capabilityForCommand(old), null, old);
  }
  const all = BRIDGE_CAPABILITIES.flatMap((c) => BRIDGE_CAPABILITY_COMMANDS[c]);
  assertEquals(new Set(all).size, all.length);
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

// ── GitHub remotes ──────────────────────────────────────────────────────────────────────────

/**
 * The one shape table for a GitHub remote. `devc-bridge/tests/gh_push_test.sh` reads these rows
 * out of this file and asserts each against the shell `parse_remote` the bridge scripts carry, so
 * keep one `['<url>', <bool>],` row per line.
 */
const GITHUB_REMOTE_SHAPES: [string, boolean][] = [
  ['git@github.com:o/n.git', true],
  ['git@github.com:o/n', true],
  ['ssh://git@github.com/o/n', true],
  ['ssh://git@github.com/o/n.git', true],
  ['https://github.com/o/n.git', true],
  ['https://github.com/o/n', true],
  ['git@github.com-work:o/n.git', true],
  ['ssh://git@github.com-work/o/n', true],
  ['git@github.com:my.org/my_repo-2.git', true],
  ['/srv/repo.git', false],
  ['file:///x', false],
  ['../x.git', false],
  ['git@gitlab.com:o/n.git', false],
  ['ssh://git@gitlab.com/o/n.git', false],
  ['https://gitlab.com/o/n.git', false],
  ['https://github.com.evil.com/o/n', false],
  ['https://user@github.com/o/n', false],
  ['https://github.com:443/o/n', false],
  ['git@github.com_x:o/n', false],
  ['http://github.com/o/n', false],
  ['ssh://github.com/o/n', false],
  ['https://github.com/o', false],
  ['https://github.com/o/', false],
  ['https://github.com//n', false],
  ['https://github.com/../n', false],
  ['https://github.com/o/..', false],
  ['https://github.com/o/.git', false],
  ['git@github.com:o/n/extra', false],
  ['git@github.com:', false],
  ['git@github.com:o/n x', false],
];

Deno.test('isGitHubRemote: the shape table', () => {
  for (const [url, want] of GITHUB_REMOTE_SHAPES) {
    assertEquals(isGitHubRemote(url), want, url);
  }
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
