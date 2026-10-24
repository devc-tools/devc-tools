import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import { join } from 'jsr:@std/path';
import type { ContainerInfo } from '@devc-tools/core/container.ts';
import { bridgePaths } from '@devc-tools/core/bridge.ts';
import { projectKey } from '@devc-tools/core/merged_config.ts';
import {
  appendViewedMark,
  fileHistory,
  fileUrl,
  MAX_BODY_CHARS,
  MAX_COMMENTS,
  MAX_FILES,
  MAX_HISTORY_ENTRIES,
  MAX_HISTORY_LINES,
  MAX_HUNK_CHARS,
  MAX_PATCH_BYTES,
  noGrantMessage,
  NOT_RUNNING_MESSAGE,
  parsePrFiles,
  parsePrThreads,
  type PrAnswer,
  type PrMessage,
  PrReview,
  readViewedHistory,
  replyBodyProblem,
  viewedHistoryFile,
  type ViewedMark,
} from '../web/pr_review.ts';

const LOCAL = '/src/app';
const ROOT = '/src/app';
const TARGET = '/workspaces/app';
const URL = 'https://github.com/o/app/pull/7';
const SHA = 'a'.repeat(40);

const info: ContainerInfo = {
  containerId: 'c0ffee',
  remoteUser: 'vscode',
  remoteWorkspaceFolder: '/workspaces/app',
  remoteEnv: {},
};

const pr = {
  repo: 'o/app',
  number: 7,
  url: URL,
  headSha: SHA,
  title: 'Fix the thing',
  state: 'OPEN',
  isDraft: false,
  author: 'me',
  baseRef: 'main',
  headRef: 'feat',
  changedFiles: 2,
};

const file = (path: string, extra: Record<string, unknown> = {}) => ({
  path,
  previousPath: null,
  status: 'modified',
  additions: 1,
  deletions: 0,
  patch: '@@ -1 +1 @@\n-a\n+b',
  viewed: 'UNVIEWED',
  ...extra,
});

const filesOut = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    pr,
    files: [file('src/a.ts'), file('b.md')],
    truncated: false,
    ...over,
  });

const thread = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  path: 'src/a.ts',
  line: 1,
  isResolved: false,
  isOutdated: false,
  copilot: false,
  comments: [{
    author: 'rev',
    body: 'Consider…',
    createdAt: '2026-10-20T00:00:00Z',
    url: 'https://github.com/o/app/pull/7#discussion_r1',
  }],
  ...extra,
});

const commentsOut = JSON.stringify({
  pr: { repo: 'o/app', number: 7, url: URL, headSha: SHA },
  threads: [
    thread('PRRT_human'),
    thread('PRRT_copilot', { copilot: true }),
    thread('PRRT_done', { isResolved: true }),
    thread('PRRT_other', { path: 'b.md' }),
  ],
  copilotReview: null,
  pending: false,
});

/**
 * A temp home for policy files and a stub `docker` that logs each call's argv (NUL-separated,
 * one file per call) and answers from `<dir>/<command>.{out,err,code}`. `<command>.sleep` makes
 * it sleep instead, and `<command>.big` makes it write that many bytes.
 */
async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'pr-review-' });
  const docker = join(dir, 'docker');
  await Deno.writeTextFile(
    docker,
    `#!/bin/bash
d=${JSON.stringify(dir)}
n=$(cat "$d/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$d/count"
printf '%s\\0' "$@" > "$d/call.$n"
cmd=''
for ((i=1; i<=$#; i++)); do
  if [ "\${!i}" = devc-bridge ]; then j=$((i+1)); cmd=\${!j}; break; fi
done
if [ -f "$d/$cmd.sleep" ]; then exec sleep "$(cat "$d/$cmd.sleep")"; fi
if [ -f "$d/$cmd.big" ]; then exec head -c "$(cat "$d/$cmd.big")" /dev/zero; fi
[ -f "$d/$cmd.out" ] && cat "$d/$cmd.out"
[ -f "$d/$cmd.err" ] && cat "$d/$cmd.err" >&2
exit "$(cat "$d/$cmd.code" 2>/dev/null || echo 0)"
`,
  );
  await Deno.chmod(docker, 0o755);
  await Deno.writeTextFile(join(dir, 'gh-pr-files.out'), filesOut());
  await Deno.writeTextFile(join(dir, 'gh-pr-comments.out'), commentsOut);
  await Deno.writeTextFile(
    join(dir, 'gh-pr-viewed.out'),
    JSON.stringify({ path: 'src/a.ts', viewed: 'VIEWED' }),
  );
  await Deno.writeTextFile(join(dir, 'gh-pr-resolve.out'), 'resolved: x\n');
  const home = join(dir, 'home');
  let running = true;
  const review = (opts: { timeoutMs?: number; maxOutput?: number } = {}) =>
    new PrReview({
      isRepo: (l, r) => l === LOCAL && r === ROOT,
      container: () => Promise.resolve(running ? { info, name: 'app' } : null),
      home,
      docker,
      ...opts,
    });
  const policyFile = bridgePaths(home, await projectKey(LOCAL)).policyFile;
  const policy = async (grants: string, repo = ROOT) => {
    await Deno.mkdir(join(home, '.config/devc-bridge/policy'), {
      recursive: true,
    });
    await Deno.writeTextFile(
      policyFile,
      `${repo}\thttps://github.com/o/app.git\tfeat\t${grants}\t${TARGET}\n`,
    );
  };
  const calls = async () => {
    const out: string[][] = [];
    for (let n = 1;; n++) {
      try {
        const raw = await Deno.readTextFile(join(dir, `call.${n}`));
        out.push(raw.split('\0').slice(0, -1));
      } catch {
        return out;
      }
    }
  };
  const write = (name: string, text: string) =>
    Deno.writeTextFile(join(dir, name), text);
  return {
    dir,
    home,
    review,
    policy,
    policyFile,
    calls,
    write,
    stop: () => {
      running = false;
    },
    done: () => Deno.remove(dir, { recursive: true }),
  };
}

const files: PrMessage = { type: 'pr_files', localFolder: LOCAL, root: ROOT };
const at = (type: 'pr_diff' | 'pr_threads', path = 'src/a.ts'): PrMessage => ({
  type,
  localFolder: LOCAL,
  root: ROOT,
  path,
});

function result(a: PrAnswer): Record<string, unknown> {
  assert(a.ok, `expected ok, got ${JSON.stringify(a)}`);
  return a.result;
}

function failed(a: PrAnswer, code: string, message?: string) {
  assert(!a.ok, `expected ${code}, got ${JSON.stringify(a)}`);
  assertEquals(a.code, code);
  if (message !== undefined) assertEquals(a.message, message);
}

Deno.test('pr lookup: no policy, another repo, gh-push only and a malformed policy are no_grant', async () => {
  const t = await setup();
  try {
    const noGrant = {
      available: false,
      reason: 'no_grant',
      message: noGrantMessage(join(t.home, '.config/devc/config.json')),
    };
    assertEquals(result(await t.review().handle(files)), noGrant);
    await t.policy('gh-pr-read', '/src/other');
    assertEquals(result(await t.review().handle(files)), noGrant);
    await t.policy('gh-push');
    assertEquals(result(await t.review().handle(files)), noGrant);
    // gh-pr-reply needs gh-pr-read: the policy is malformed.
    await t.policy('gh-pr-reply');
    assertEquals(result(await t.review().handle(files)), noGrant);
    assertEquals(await t.calls(), []);
    // The message names the config file in use: config.jsonc once it exists.
    await Deno.mkdir(join(t.home, '.config/devc'), { recursive: true });
    await Deno.writeTextFile(join(t.home, '.config/devc/config.jsonc'), '{}');
    assertEquals(
      result(await t.review().handle(files)).message,
      noGrantMessage(join(t.home, '.config/devc/config.jsonc')),
    );
    assertStringIncludes(
      String(result(await t.review().handle(files)).message),
      'config.jsonc',
    );
    await t.policy('gh-pr-read');
    assertEquals(result(await t.review().handle(files)).available, true);
  } finally {
    await t.done();
  }
});

Deno.test('pr lookup: resolveScope and the offers follow the grants', async () => {
  const t = await setup();
  try {
    const offers = async (grants: string) => {
      await t.policy(grants);
      const r = result(await t.review().handle(files));
      return [r.canViewed, r.canReply, r.resolveScope, r.canReview];
    };
    assertEquals(
      await offers('gh-pr-read,gh-pr-reply,gh-pr-viewed,gh-pr-resolve'),
      [true, true, 'any', false],
    );
    assertEquals(
      await offers('gh-pr-read,gh-pr-resolve-copilot'),
      [false, false, 'copilot', false],
    );
    assertEquals(await offers('gh-pr-read'), [false, false, null, false]);
    assertEquals(
      await offers('gh-pr-read,gh-pr-pending-review'),
      [false, false, null, true],
    );
  } finally {
    await t.done();
  }
});

Deno.test('pr lookup: trailing slashes match, a stopped container is not_running, the policy is read per message', async () => {
  const t = await setup();
  try {
    await t.policy('gh-pr-read', `${ROOT}/`);
    const review = t.review();
    const r = result(await review.handle({ ...files, root: `${ROOT}/` }));
    assertEquals(r.available, true);
    assertEquals(r.container, 'app');
    assertEquals((r.pr as { number: number }).number, 7);
    // Files come without their patch.
    assertEquals(
      (r.files as Record<string, unknown>[]).map((f) => 'patch' in f),
      [false, false],
    );
    await Deno.remove(t.policyFile);
    assertEquals(result(await review.handle(files)).reason, 'no_grant');
    await t.policy('gh-pr-read');
    t.stop();
    assertEquals(result(await review.handle(files)), {
      available: false,
      reason: 'not_running',
      message: NOT_RUNNING_MESSAGE,
    });
    failed(
      await review.handle({ ...files, root: '/src/nope' }),
      'bad_request',
      'unknown repo',
    );
  } finally {
    await t.done();
  }
});

Deno.test('pr argv: docker exec … devc-bridge <cmd> --repo <target>, replies --as human, bodies one element each', async () => {
  const t = await setup();
  try {
    await t.policy('gh-pr-read,gh-pr-reply');
    const review = t.review();
    result(await review.handle(files));
    const [first] = await t.calls();
    assertEquals(first, [
      'exec',
      '-u',
      'vscode',
      '-w',
      '/',
      'c0ffee',
      'devc-bridge',
      'gh-pr-files',
      '--repo',
      TARGET,
    ]);
    result(await review.handle(at('pr_threads')));
    assertEquals((await t.calls())[1].slice(6), [
      'devc-bridge',
      'gh-pr-comments',
      '--repo',
      TARGET,
      '--state',
      'all',
    ]);
    for (const body of ['--repo x', '@/etc/passwd', '$(id)']) {
      assertEquals(
        result(
          await review.handle({
            type: 'pr_reply',
            localFolder: LOCAL,
            root: ROOT,
            path: 'src/a.ts',
            thread: 'PRRT_human',
            body,
          }),
        ),
        {},
      );
      const calls = await t.calls();
      assertEquals(calls[calls.length - 1].slice(6), [
        'devc-bridge',
        'gh-pr-reply',
        '--repo',
        TARGET,
        '--as',
        'human',
        'PRRT_human',
        body,
      ]);
    }
  } finally {
    await t.done();
  }
});

Deno.test('pr parse: bad pr fields fail the listing, bad files are dropped or fixed up', () => {
  assertEquals(
    parsePrFiles(
      filesOut({ pr: { ...pr, url: 'https://evil.com/o/a/pull/7' } }),
    ),
    null,
  );
  assertEquals(
    parsePrFiles(filesOut({ pr: { ...pr, headSha: 'a'.repeat(39) } })),
    null,
  );
  assertEquals(parsePrFiles('not json'), null);
  const parsed = parsePrFiles(filesOut({
    files: [
      file('a\0b'),
      file('x', { status: 'weird', viewed: 'MAYBE' }),
      file('y', { patch: 'p'.repeat(MAX_PATCH_BYTES + 1) }),
      file('z', { patch: 'p'.repeat(MAX_PATCH_BYTES) }),
      file('x', { status: 'added' }),
      file('n', { additions: -1 }),
    ],
  }))!;
  assertEquals(parsed.files.map((f) => f.path), ['x', 'y', 'z']);
  assertEquals(parsed.files[0].status, 'modified');
  assertEquals(parsed.files[0].viewed, 'UNVIEWED');
  assertEquals(parsed.files[1].patch, null);
  assertEquals(parsed.files[2].patch?.length, MAX_PATCH_BYTES);
  const many = parsePrFiles(filesOut({
    files: Array.from({ length: MAX_FILES + 1 }, (_, i) => file(`f${i}`)),
  }))!;
  assertEquals(many.files.length, 3000);
  const long = parsePrFiles(
    filesOut({ pr: { ...pr, title: 't'.repeat(2000) } }),
  )!;
  assertEquals(long.pr.title.length, 1024);
});

Deno.test('pr parse: thread ids, wrong types, urls and caps', () => {
  const parsed = parsePrThreads(JSON.stringify({
    pr: { url: URL },
    threads: [
      thread('x'),
      thread('PRRT_ok', {
        comments: [
          ...Array.from({ length: MAX_COMMENTS + 5 }, () => ({
            author: 'a',
            body: 'b'.repeat(MAX_BODY_CHARS + 10),
            createdAt: 'now',
            url: 'javascript:alert(1)',
          })),
        ],
      }),
      thread('PRRT_bad', { isResolved: 'no' }),
      thread('PRRT_c', { comments: [{ author: 1, body: 'x' }] }),
    ],
  }))!;
  assertEquals(parsed.threads.map((t) => t.id), ['PRRT_ok', 'PRRT_c']);
  const [ok, c] = parsed.threads;
  assertEquals(ok.comments.length, MAX_COMMENTS);
  assertEquals(ok.comments[0].body.length, MAX_BODY_CHARS);
  assertEquals(ok.comments[0].url, '');
  assertEquals(c.comments, []);
  assertEquals(parsePrThreads(JSON.stringify({ pr: {}, threads: [] })), null);
});

Deno.test("pr parse: a block's startLine, kept only before its line", () => {
  const parsed = parsePrThreads(JSON.stringify({
    pr: { url: URL },
    threads: [
      thread('PRRT_block', { line: 9, startLine: 4 }),
      thread('PRRT_old', { line: 9 }),
      thread('PRRT_same', { line: 9, startLine: 9 }),
      thread('PRRT_after', { line: 9, startLine: 12 }),
      thread('PRRT_text', { line: 9, startLine: '4' }),
      thread('PRRT_outdated', { line: null, startLine: 4 }),
    ],
  }))!;
  assertEquals(
    parsed.threads.map((t) => [t.id, t.startLine]),
    [
      ['PRRT_block', 4],
      ['PRRT_old', null],
      ['PRRT_same', null],
      ['PRRT_after', null],
      ['PRRT_text', null],
      ['PRRT_outdated', null],
    ],
  );
});

Deno.test('pr limits: a command past its timeout, and one writing past the cap, are bridge results', async () => {
  const t = await setup();
  try {
    await t.policy('gh-pr-read');
    await t.write('gh-pr-files.sleep', '5');
    const started = Date.now();
    const slow = result(await t.review({ timeoutMs: 200 }).handle(files));
    assertEquals(slow.available, false);
    assertEquals(slow.reason, 'bridge');
    assert(Date.now() - started < 3000);
    await Deno.remove(join(t.dir, 'gh-pr-files.sleep'));
    await t.write('gh-pr-files.big', String(64 * 1024 * 1024 + 1));
    assertEquals(result(await t.review().handle(files)), {
      available: false,
      reason: 'bridge',
      message: 'bridge output too large',
    });
    await Deno.remove(join(t.dir, 'gh-pr-files.big'));
    await t.write('gh-pr-files.code', '1');
    await t.write(
      'gh-pr-files.err',
      'first line\ndevc-bridge: gh-pr-files needs capability gh-pr-read\n\n',
    );
    assertEquals(result(await t.review().handle(files)), {
      available: false,
      reason: 'bridge',
      message: 'devc-bridge: gh-pr-files needs capability gh-pr-read',
    });
  } finally {
    await t.done();
  }
});

Deno.test('pr writes: pr_viewed needs its grant and a listed path', async () => {
  const t = await setup();
  try {
    const viewed = (path: string): PrMessage => ({
      type: 'pr_viewed',
      localFolder: LOCAL,
      root: ROOT,
      path,
      viewed: true,
    });
    await t.policy('gh-pr-read');
    failed(
      await t.review().handle(viewed('src/a.ts')),
      'bad_request',
      'Needs --bridge-allow gh-pr-viewed on this repo',
    );
    await t.policy('gh-pr-read,gh-pr-viewed');
    const review = t.review();
    result(await review.handle(files));
    failed(await review.handle(viewed('nope.ts')), 'not_found');
    assertEquals(result(await review.handle(viewed('src/a.ts'))), {
      path: 'src/a.ts',
      viewed: 'VIEWED',
    });
    assertEquals((await t.calls())[1].slice(6), [
      'devc-bridge',
      'gh-pr-viewed',
      '--repo',
      TARGET,
      'viewed',
      'src/a.ts',
    ]);
    // The stored listing was updated.
    const diff = result(await review.handle(at('pr_diff')));
    assertEquals((diff.file as { viewed: string }).viewed, 'VIEWED');
    await t.write(
      'gh-pr-viewed.out',
      JSON.stringify({ path: 'b.md', viewed: 'VIEWED' }),
    );
    assertEquals(
      result(await review.handle(viewed('src/a.ts'))).message,
      'unexpected bridge output',
    );
  } finally {
    await t.done();
  }
});

Deno.test('pr writes: reply body rules, and an unlisted thread', async () => {
  assertEquals(replyBodyProblem('ok\n\tfine'), null);
  assert(replyBodyProblem('   \n') !== null);
  assert(replyBodyProblem('a\u0007b') !== null);
  assert(replyBodyProblem('a\rb') !== null);
  assertEquals(replyBodyProblem('é'.repeat(2000)), null);
  assert(replyBodyProblem('é'.repeat(2001)) !== null);
  const t = await setup();
  try {
    await t.policy('gh-pr-read,gh-pr-reply');
    const review = t.review();
    const reply = (body: string, thread = 'PRRT_human'): PrMessage => ({
      type: 'pr_reply',
      localFolder: LOCAL,
      root: ROOT,
      path: 'src/a.ts',
      thread,
      body,
    });
    failed(await review.handle(reply('hi')), 'not_found');
    result(await review.handle(at('pr_threads')));
    failed(await review.handle(reply('')), 'bad_request', 'The reply is empty');
    failed(await review.handle(reply('x'.repeat(4001))), 'bad_request');
    failed(await review.handle(reply('a\0b')), 'bad_request');
    failed(await review.handle(reply('hi', 'PRRT_gone')), 'not_found');
    assertEquals(result(await review.handle(reply('hi'))), {});
    await t.policy('gh-pr-read');
    failed(
      await review.handle(reply('hi')),
      'bad_request',
      'Needs --bridge-allow gh-pr-reply on this repo',
    );
  } finally {
    await t.done();
  }
});

Deno.test('pr writes: pr_resolve follows the resolve grants', async () => {
  const t = await setup();
  try {
    const resolve = (thread: string): PrMessage => ({
      type: 'pr_resolve',
      localFolder: LOCAL,
      root: ROOT,
      path: 'src/a.ts',
      thread,
    });
    await t.policy('gh-pr-read');
    const review = t.review();
    result(await review.handle(at('pr_threads')));
    failed(
      await review.handle(resolve('PRRT_human')),
      'bad_request',
      'Needs --bridge-allow gh-pr-resolve on this repo',
    );
    await t.policy('gh-pr-read,gh-pr-resolve-copilot');
    failed(
      await review.handle(resolve('PRRT_human')),
      'bad_request',
      "This container may resolve only Copilot's threads (gh-pr-resolve-copilot)",
    );
    assertEquals(result(await review.handle(resolve('PRRT_copilot'))), {});
    await t.policy('gh-pr-read,gh-pr-resolve');
    failed(
      await review.handle(resolve('PRRT_done')),
      'bad_request',
      'Already resolved',
    );
    const before = (await t.calls()).length;
    assertEquals(result(await review.handle(resolve('PRRT_human'))), {});
    const calls = await t.calls();
    assertEquals(calls.length, before + 1);
    assertEquals(calls[calls.length - 1].slice(6), [
      'devc-bridge',
      'gh-pr-resolve',
      '--repo',
      TARGET,
      'PRRT_human',
    ]);
  } finally {
    await t.done();
  }
});

Deno.test('pr_threads: runs gh-pr-comments --state all, keeps the path, and refuses another PR', async () => {
  const t = await setup();
  try {
    await t.policy('gh-pr-read');
    const review = t.review();
    const r = result(await review.handle(at('pr_threads')));
    assertEquals(r.container, 'app');
    assertEquals(
      (r.threads as { id: string }[]).map((x) => x.id),
      ['PRRT_human', 'PRRT_copilot', 'PRRT_done'],
    );
    await t.write(
      'gh-pr-comments.out',
      JSON.stringify({
        pr: { url: 'https://github.com/o/app/pull/8' },
        threads: [],
      }),
    );
    assertEquals(result(await review.handle(at('pr_threads'))), {
      available: false,
      reason: 'other_pr',
      message:
        'The bridge reports a different PR: https://github.com/o/app/pull/8',
    });
  } finally {
    await t.done();
  }
});

Deno.test('pr_diff: fetches a listing when none is stored, and names the file on github.com', async () => {
  const t = await setup();
  try {
    await t.policy('gh-pr-read');
    const review = t.review();
    const r = result(await review.handle(at('pr_diff')));
    assertEquals((await t.calls()).length, 1);
    assertEquals((r.file as { patch: string }).patch, '@@ -1 +1 @@\n-a\n+b');
    const hex = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode('src/a.ts'),
        ),
      ),
    ).map((b) => b.toString(16).padStart(2, '0')).join('');
    assertEquals(r.fileUrl, `${URL}/files#diff-${hex}`);
    assertEquals(await fileUrl(URL, 'src/a.ts'), r.fileUrl);
    failed(
      await review.handle(at('pr_diff', 'gone.ts')),
      'not_found',
      'This file is not in the pull request any more',
    );
    // The stored listing answers: no second run.
    assertEquals((await t.calls()).length, 1);
  } finally {
    await t.done();
  }
});

Deno.test('pr lookup: grants are per line — each repo is offered what its own line grants', async () => {
  const t = await setup();
  try {
    const LIB = '/src/lib';
    const LIB_TARGET = '/workspaces/lib';
    await Deno.mkdir(join(t.dir, 'home/.config/devc-bridge/policy'), {
      recursive: true,
    });
    await Deno.writeTextFile(
      t.policyFile,
      `${ROOT}\thttps://github.com/o/app.git\tfeat\tgh-pr-read,gh-pr-reply\t${TARGET}\n` +
        `${LIB}\thttps://github.com/o/lib.git\tfeat\tgh-pr-read\t${LIB_TARGET}\n`,
    );
    const review = new PrReview({
      isRepo: (l, r) => l === LOCAL && (r === ROOT || r === LIB),
      container: () => Promise.resolve({ info, name: 'app' }),
      home: join(t.dir, 'home'),
      docker: join(t.dir, 'docker'),
    });
    const app = result(await review.handle(files));
    assertEquals(app.canReply, true);
    const lib = result(await review.handle({ ...files, root: LIB }));
    assertEquals(lib.canReply, false);
    // Line 2's own target is the one the bridge is asked about.
    assertEquals((await t.calls())[1].slice(6), [
      'devc-bridge',
      'gh-pr-files',
      '--repo',
      LIB_TARGET,
    ]);
    const reply = (root: string): PrMessage => ({
      type: 'pr_reply',
      localFolder: LOCAL,
      root,
      path: 'src/a.ts',
      thread: 'PRRT_human',
      body: 'hi',
    });
    result(await review.handle({ ...at('pr_threads'), root: LIB }));
    failed(
      await review.handle(reply(LIB)),
      'bad_request',
      'Needs --bridge-allow gh-pr-reply on this repo',
    );
    result(await review.handle(at('pr_threads')));
    assertEquals(result(await review.handle(reply(ROOT))), {});
    // A line without gh-pr-read offers nothing, whatever another line grants.
    await Deno.writeTextFile(
      t.policyFile,
      `${ROOT}\thttps://github.com/o/app.git\tfeat\tgh-push\t${TARGET}\n` +
        `${LIB}\thttps://github.com/o/lib.git\tfeat\tgh-pr-read\t${LIB_TARGET}\n`,
    );
    assertEquals(result(await review.handle(files)).reason, 'no_grant');
    assertEquals(
      result(await review.handle({ ...files, root: LIB })).available,
      true,
    );
  } finally {
    await t.done();
  }
});

Deno.test('pr parse: side, original lines, subject type, hunk and pending, leniently', () => {
  const parsed = parsePrThreads(JSON.stringify({
    pr: { url: URL },
    threads: [
      thread('PRRT_left', {
        line: 5,
        startLine: 3,
        diffSide: 'LEFT',
        startDiffSide: 'LEFT',
        originalLine: 5,
        originalStartLine: 3,
        subjectType: 'LINE',
        diffHunk: '@@ -1,5 +1,4 @@\n a\n-b',
        comments: [{
          id: 'PRRC_1',
          author: 'me',
          body: 'x',
          createdAt: 'now',
          url: '',
          pending: true,
        }],
      }),
      // A bridge that predates the fields.
      thread('PRRT_old'),
      thread('PRRT_odd', {
        line: null,
        diffSide: 'UP',
        startDiffSide: 'LEFT',
        originalLine: 9,
        originalStartLine: 12,
        subjectType: 'REPO',
        diffHunk: 'h'.repeat(MAX_HUNK_CHARS + 5),
        comments: [{
          id: 'bad id!',
          author: 'me',
          body: 'x',
          createdAt: 'now',
          url: '',
          pending: 'yes',
        }],
      }),
      thread('PRRT_file', { line: null, subjectType: 'FILE', originalLine: 0 }),
    ],
  }))!;
  const [left, old, odd, file] = parsed.threads;
  assertEquals(
    [
      left.diffSide,
      left.startDiffSide,
      left.originalLine,
      left.originalStartLine,
      left.subjectType,
      left.diffHunk,
    ],
    ['LEFT', 'LEFT', 5, 3, 'LINE', '@@ -1,5 +1,4 @@\n a\n-b'],
  );
  assertEquals([left.comments[0].id, left.comments[0].pending], [
    'PRRC_1',
    true,
  ]);
  assertEquals(
    [
      old.diffSide,
      old.startDiffSide,
      old.originalLine,
      old.originalStartLine,
      old.subjectType,
      old.diffHunk,
      old.comments[0].id,
      old.comments[0].pending,
    ],
    ['RIGHT', null, null, null, 'LINE', '', '', false],
  );
  // startDiffSide only with a kept startLine; originalStartLine only before originalLine.
  assertEquals(
    [
      odd.diffSide,
      odd.startDiffSide,
      odd.originalLine,
      odd.originalStartLine,
      odd.subjectType,
      odd.diffHunk.length,
      odd.comments[0].id,
      odd.comments[0].pending,
    ],
    ['RIGHT', null, 9, null, 'LINE', MAX_HUNK_CHARS, '', false],
  );
  assertEquals([file.subjectType, file.originalLine], ['FILE', null]);
});

const mark = (path: string, n: number, viewed = 'VIEWED'): ViewedMark => ({
  path,
  viewed: viewed as 'VIEWED',
  headSha: String(n % 10).repeat(40),
  at: new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString(),
});

Deno.test('pr history: append, cap, read back newest first by path or previous path', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'pr-history-' });
  try {
    const file = viewedHistoryFile(join(dir, 'devc'), 'o/app', 7);
    assertEquals(file, join(dir, 'devc/pr-viewed/o/app/7.jsonl'));
    assertEquals(await readViewedHistory(file), []);
    await appendViewedMark(file, mark('src/a.ts', 1));
    assertEquals((await Deno.stat(file)).mode! & 0o777, 0o600);
    assertEquals(
      (await Deno.stat(join(dir, 'devc/pr-viewed/o'))).mode! & 0o777,
      0o700,
    );
    assertEquals(
      await Deno.readTextFile(file),
      JSON.stringify(mark('src/a.ts', 1)) + '\n',
    );
    // Lines that don't parse to a mark are skipped.
    await Deno.writeTextFile(
      file,
      'not json\n{"path":"x","viewed":"MAYBE","headSha":"' + '1'.repeat(40) +
        '","at":"2026-10-01T00:00:00Z"}\n' +
        JSON.stringify({ ...mark('x', 1), headSha: 'A'.repeat(40) }) + '\n',
      { append: true },
    );
    await appendViewedMark(file, mark('old/a.ts', 2));
    await appendViewedMark(file, mark('src/b.ts', 3));
    await appendViewedMark(file, mark('src/a.ts', 4, 'UNVIEWED'));
    const marks = await readViewedHistory(file);
    assertEquals(marks.map((m) => m.path), [
      'src/a.ts',
      'old/a.ts',
      'src/b.ts',
      'src/a.ts',
    ]);
    assertEquals(
      fileHistory(marks, 'src/a.ts', 'old/a.ts').map((m) => m.at),
      [mark('', 4).at, mark('', 2).at, mark('', 1).at],
    );
    assertEquals(fileHistory(marks, 'src/b.ts', null).length, 1);
    const many = Array.from({ length: 60 }, (_, i) => mark('m', i));
    assertEquals(fileHistory(many, 'm', null).length, MAX_HISTORY_ENTRIES);
    assertEquals(fileHistory(many, 'm', null)[0].at, mark('m', 59).at);
    // Past the cap the file keeps its last MAX_HISTORY_LINES lines.
    await Deno.writeTextFile(
      file,
      Array.from(
        { length: MAX_HISTORY_LINES },
        (_, i) => JSON.stringify(mark(`f${i}`, i)),
      ).join('\n') + '\n',
    );
    await appendViewedMark(file, mark('last', 1));
    const capped = (await Deno.readTextFile(file)).trimEnd().split('\n');
    assertEquals(capped.length, MAX_HISTORY_LINES);
    assertEquals(JSON.parse(capped[0]).path, 'f1');
    assertEquals(JSON.parse(capped[capped.length - 1]).path, 'last');
    assertEquals((await Deno.stat(file)).mode! & 0o777, 0o600);
    assertEquals(
      [...Deno.readDirSync(join(dir, 'devc/pr-viewed/o/app'))].map((e) =>
        e.name
      ),
      ['7.jsonl'],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pr history: every pr_viewed is recorded with its head, and pr_diff lists the file's marks", async () => {
  const t = await setup();
  try {
    await t.policy('gh-pr-read,gh-pr-viewed');
    await t.write(
      'gh-pr-files.out',
      filesOut({
        files: [file('src/a.ts', { previousPath: 'old/a.ts' }), file('b.md')],
      }),
    );
    const review = t.review();
    result(await review.handle(files));
    const viewed = (path: string, v: boolean): PrMessage => ({
      type: 'pr_viewed',
      localFolder: LOCAL,
      root: ROOT,
      path,
      viewed: v,
    });
    const history = viewedHistoryFile(
      join(t.home, '.config/devc'),
      'o/app',
      7,
    );
    // A bridge without headSha still marks; nothing is recorded.
    result(await review.handle(viewed('src/a.ts', true)));
    assertEquals(await readViewedHistory(history), []);
    await appendViewedMark(history, mark('old/a.ts', 1));
    await t.write(
      'gh-pr-viewed.out',
      JSON.stringify({ path: 'src/a.ts', viewed: 'VIEWED', headSha: SHA }),
    );
    const before = Date.now();
    result(await review.handle(viewed('src/a.ts', true)));
    await t.write(
      'gh-pr-viewed.out',
      JSON.stringify({ path: 'b.md', viewed: 'UNVIEWED', headSha: SHA }),
    );
    result(await review.handle(viewed('b.md', false)));
    const marks = await readViewedHistory(history);
    assertEquals(marks.length, 3);
    assertEquals(
      [marks[1].path, marks[1].viewed, marks[1].headSha],
      ['src/a.ts', 'VIEWED', SHA],
    );
    assert(Date.parse(marks[1].at) >= before - 1000);
    assertEquals([marks[2].path, marks[2].viewed], ['b.md', 'UNVIEWED']);
    // A bad headSha is not recorded.
    await t.write(
      'gh-pr-viewed.out',
      JSON.stringify({ path: 'b.md', viewed: 'VIEWED', headSha: 'HEAD' }),
    );
    result(await review.handle(viewed('b.md', true)));
    assertEquals((await readViewedHistory(history)).length, 3);
    const diff = result(await review.handle(at('pr_diff')));
    assertEquals(
      (diff.viewedHistory as ViewedMark[]).map((m) => m.path),
      ['src/a.ts', 'old/a.ts'],
    );
  } finally {
    await t.done();
  }
});

Deno.test('pr_file_at: argv, a listed path or previous path, and each answer', async () => {
  const t = await setup();
  try {
    await t.policy('gh-pr-read');
    await t.write(
      'gh-pr-files.out',
      filesOut({
        files: [file('src/a.ts', { previousPath: 'old/a.ts' }), file('b.md')],
      }),
    );
    const review = t.review();
    const fileAt = (path: string, sha = SHA): PrMessage => ({
      type: 'pr_file_at',
      localFolder: LOCAL,
      root: ROOT,
      path,
      sha,
    });
    const answer = async (out: Record<string, unknown>, path = 'src/a.ts') => {
      await t.write('gh-pr-file-at.out', JSON.stringify(out));
      return result(await review.handle(fileAt(path)));
    };
    assertEquals(await answer({ path: 'src/a.ts', sha: SHA, content: 'x\n' }), {
      available: true,
      path: 'src/a.ts',
      sha: SHA,
      text: 'x\n',
    });
    const calls = await t.calls();
    assertEquals(calls[calls.length - 1].slice(6), [
      'devc-bridge',
      'gh-pr-file-at',
      '--repo',
      TARGET,
      SHA,
      'src/a.ts',
    ]);
    assertEquals(
      (await answer({ path: 'old/a.ts', sha: SHA, content: '' }, 'old/a.ts'))
        .text,
      '',
    );
    assertEquals(await answer({ path: 'src/a.ts', sha: SHA, missing: true }), {
      available: false,
      reason: 'missing',
      message: 'That commit no longer has this file on GitHub',
    });
    assertEquals(await answer({ path: 'src/a.ts', sha: SHA, binary: true }), {
      available: false,
      reason: 'binary',
      message: 'Binary file',
    });
    assertEquals(
      await answer({ path: 'src/a.ts', sha: SHA, tooLarge: true }),
      { available: false, reason: 'too_large', message: 'Larger than 1 MB' },
    );
    for (
      const bad of [
        { path: 'b.md', sha: SHA, content: 'x' },
        { path: 'src/a.ts', sha: 'b'.repeat(40), content: 'x' },
        { path: 'src/a.ts', sha: SHA, content: 7 },
        { path: 'src/a.ts', sha: SHA },
      ]
    ) {
      assertEquals(
        (await answer(bad)).message,
        'unexpected bridge output',
        JSON.stringify(bad),
      );
    }
    const n = (await t.calls()).length;
    failed(await review.handle(fileAt('nope.ts')), 'not_found');
    failed(await review.handle(fileAt('src/a.ts', 'HEAD')), 'bad_request');
    assertEquals((await t.calls()).length, n);
    await t.policy('gh-push');
    assertEquals(
      result(await review.handle(fileAt('src/a.ts'))).reason,
      'no_grant',
    );
  } finally {
    await t.done();
  }
});

Deno.test('pr_pending_*: each runs its gh-pr-pending-review subcommand, --as human on bodies', async () => {
  const t = await setup();
  try {
    const base = { localFolder: LOCAL, root: ROOT };
    const msgs: [PrMessage, string[]][] = [
      [{ type: 'pr_pending_show', ...base }, ['show']],
      [
        {
          type: 'pr_pending_comment',
          ...base,
          path: 'src/a.ts',
          line: 4,
          side: 'LEFT',
          startLine: null,
          body: 'one',
        },
        ['--as', 'human', 'comment', 'src/a.ts', '4', 'LEFT', 'one'],
      ],
      [
        {
          type: 'pr_pending_comment',
          ...base,
          path: 'src/a.ts',
          line: 4,
          side: 'RIGHT',
          startLine: 2,
          body: '--as agent',
        },
        [
          '--as',
          'human',
          'comment',
          'src/a.ts',
          '4',
          'RIGHT',
          '--start',
          '2',
          '--as agent',
        ],
      ],
      [
        {
          type: 'pr_pending_reply',
          ...base,
          thread: 'PRRT_human',
          body: 'two',
        },
        ['--as', 'human', 'reply', 'PRRT_human', 'two'],
      ],
      [
        { type: 'pr_pending_edit', ...base, comment: 'PRRC_1', body: 'three' },
        ['--as', 'human', 'edit', 'PRRC_1', 'three'],
      ],
      [
        { type: 'pr_pending_delete', ...base, comment: 'PRRC_1' },
        ['delete', 'PRRC_1'],
      ],
      [
        { type: 'pr_pending_submit', ...base, body: '' },
        ['--as', 'human', 'submit'],
      ],
      [
        { type: 'pr_pending_submit', ...base, body: 'done' },
        ['--as', 'human', 'submit', '--body', 'done'],
      ],
      [{ type: 'pr_pending_discard', ...base }, ['discard']],
    ];
    await t.policy('gh-pr-read,gh-pr-reply');
    for (const [msg] of msgs) {
      failed(
        await t.review().handle(msg),
        'bad_request',
        'Needs --bridge-allow gh-pr-pending-review on this repo',
      );
    }
    assertEquals(await t.calls(), []);
    await t.policy('gh-pr-read,gh-pr-pending-review');
    const review = t.review();
    result(await review.handle(files));
    result(await review.handle(at('pr_threads')));
    await t.write(
      'gh-pr-pending-review.out',
      JSON.stringify({ review: 'PRR_1', thread: 'PRRT_n', comment: 'PRRC_1' }),
    );
    for (const [msg, args] of msgs) {
      result(await review.handle(msg));
      const calls = await t.calls();
      assertEquals(calls[calls.length - 1].slice(6), [
        'devc-bridge',
        'gh-pr-pending-review',
        '--repo',
        TARGET,
        ...args,
      ], msg.type);
    }
    // The bridge's JSON passes through, checked.
    await t.write(
      'gh-pr-pending-review.out',
      JSON.stringify({ review: { id: 'PRR_1', comments: 2 } }),
    );
    assertEquals(result(await review.handle(msgs[0][0])), {
      available: true,
      review: { id: 'PRR_1', comments: 2 },
    });
    await t.write('gh-pr-pending-review.out', '{"review":null}');
    assertEquals(result(await review.handle(msgs[0][0])), {
      available: true,
      review: null,
    });
    await t.write(
      'gh-pr-pending-review.out',
      JSON.stringify({
        review: 'PRR_1',
        url: 'https://github.com/o/app/pull/7#r',
      }),
    );
    assertEquals(result(await review.handle(msgs[7][0])), {
      available: true,
      review: 'PRR_1',
      url: 'https://github.com/o/app/pull/7#r',
    });
    for (
      const bad of [
        '{"review":"bad id!"}',
        '{"review":{"id":"PRR_1","comments":-1}}',
        '{"review":"PRR_1","url":"javascript:alert(1)"}',
        '[]',
      ]
    ) {
      await t.write('gh-pr-pending-review.out', bad);
      assertEquals(
        result(await review.handle(msgs[0][0])).message,
        'unexpected bridge output',
        bad,
      );
    }
    // Refused here, before the bridge: bad bodies, unlisted files and threads, bad ids.
    const n = (await t.calls()).length;
    failed(
      await review.handle({ ...msgs[1][0], body: '  ' } as PrMessage),
      'bad_request',
    );
    failed(
      await review.handle({ ...msgs[1][0], path: 'nope.ts' } as PrMessage),
      'not_found',
    );
    failed(
      await review.handle({ ...msgs[2][0], startLine: 4 } as PrMessage),
      'bad_request',
    );
    failed(
      await review.handle({ ...msgs[3][0], thread: 'PRRT_gone' } as PrMessage),
      'not_found',
    );
    failed(
      await review.handle({ ...msgs[4][0], comment: 'a b' } as PrMessage),
      'bad_request',
    );
    failed(
      await review.handle({ ...msgs[7][0], body: 'a\u0007' } as PrMessage),
      'bad_request',
    );
    assertEquals((await t.calls()).length, n);
  } finally {
    await t.done();
  }
});
