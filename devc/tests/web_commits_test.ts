import { assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import {
  commitFileRows,
  commitFilesKey,
  commitFileTitle,
  commitRows,
  commitTitle,
  fileStat,
  hasUncommitted,
  keepList,
  MAX_COMMIT_FILES,
  uncommittedCount,
} from '../web/static/lib/commits.js';
import { statusLetter } from '../web/static/lib/pr_tree.js';
import { MAX_COMMIT_FILES as SERVER_MAX } from '../web/git_commit.ts';

const commit = (name: string, merge = false) => ({
  hash: name.repeat(40),
  subject: `subject ${name}`,
  author: 'Ann',
  time: 1_700_000_000,
  merge,
});

const history = (over: Record<string, unknown> = {}) => ({
  branch: 'main',
  compare: 'origin/main',
  incoming: [],
  incomingTotal: 0,
  local: [],
  localTotal: 0,
  pushed: [],
  morePushed: false,
  ...over,
});

const shape = (rows: ReturnType<typeof commitRows>) =>
  rows.map((r) => r.kind === 'commit' ? `${r.state}:${r.short}` : r.text);

Deno.test('commitRows orders to pull, local, then pushed under their lines', () => {
  assertEquals(
    shape(commitRows(history({
      incoming: [commit('a')],
      incomingTotal: 1,
      local: [commit('b'), commit('c')],
      localTotal: 2,
      pushed: [commit('d')],
    }))),
    [
      'To pull · 1 commit on origin/main',
      'incoming:aaaaaaa',
      'Local only · 2 commits',
      'local:bbbbbbb',
      'local:ccccccc',
      'Pushed · origin/main',
      'pushed:ddddddd',
    ],
  );
});

Deno.test('commitRows: fully pushed has only the pushed line', () => {
  assertEquals(shape(commitRows(history({ pushed: [commit('d')] }))), [
    'Pushed · origin/main',
    'pushed:ddddddd',
  ]);
});

Deno.test('commitRows: a repo with no remote branch says so', () => {
  assertEquals(
    shape(commitRows(history({
      compare: null,
      local: [commit('a')],
      localTotal: 1,
    }))),
    ['Local only · 1 commit, no remote branch', 'local:aaaaaaa'],
  );
});

Deno.test('commitRows says what a long list left out', () => {
  assertEquals(
    shape(commitRows(history({
      incoming: [commit('a')],
      incomingTotal: 3,
      local: [commit('b')],
      localTotal: 5,
      pushed: [commit('c')],
      morePushed: true,
    }))).filter((t) => !/:/.test(t) && !/·/.test(t)),
    ['and 2 more', 'and 4 more', 'latest 1 shown'],
  );
});

Deno.test('commitRows of no commits is empty', () => {
  assertEquals(commitRows(history()), []);
});

Deno.test('commitTitle has the hash, author, merge note and subject', () => {
  const t = commitTitle(commit('a', true));
  assertStringIncludes(t, 'aaaaaaaaaaaa\nAnn · ');
  assertStringIncludes(t, '\nMerge commit\nsubject a');
});

const file = (path: string, over: Record<string, unknown> = {}) => ({
  path,
  previousPath: null,
  status: 'modified' as const,
  additions: 1,
  deletions: 2,
  binary: false,
  ...over,
});

Deno.test('commitFileRows: loading, error, empty, files and a cut-short list', () => {
  assertEquals(commitFileRows(undefined), [
    { kind: 'note', note: 'loading', text: 'Loading…' },
  ]);
  const base = { loading: false, files: null, truncated: false, error: null };
  assertEquals(commitFileRows({ ...base, loading: true }), [
    { kind: 'note', note: 'loading', text: 'Loading…' },
  ]);
  assertEquals(commitFileRows({ ...base, error: 'gone' }), [
    { kind: 'note', note: 'error', text: "Couldn't list files: gone" },
  ]);
  assertEquals(commitFileRows({ ...base, files: [] }), [
    { kind: 'note', note: 'empty', text: 'No files changed' },
  ]);
  const renamed = file('src/new.ts', {
    status: 'renamed',
    previousPath: 'src/old.ts',
  });
  const rows = commitFileRows({
    ...base,
    files: [file('README.md'), renamed],
    truncated: true,
  });
  assertEquals(rows, [
    {
      kind: 'file',
      file: file('README.md'),
      name: 'README.md',
      dir: '',
      title: 'README.md',
    },
    {
      kind: 'file',
      file: renamed,
      name: 'new.ts',
      dir: 'src',
      title: 'src/old.ts → src/new.ts',
    },
    { kind: 'note', note: 'more', text: `first ${SERVER_MAX} files shown` },
  ]);
  assertEquals(MAX_COMMIT_FILES, SERVER_MAX);
  assertEquals(commitFileTitle(file('a/b')), 'a/b');
});

Deno.test('keepList keeps the newest lists, a re-read one moved to the end', () => {
  const lists = new Map<string, number>();
  for (let i = 0; i < 4; i++) keepList(lists, `k${i}`, i, 3);
  assertEquals([...lists.keys()], ['k1', 'k2', 'k3']);
  keepList(lists, 'k1', 10, 3);
  keepList(lists, 'k4', 4, 3);
  assertEquals([...lists.entries()], [['k3', 3], ['k1', 10], ['k4', 4]]);
  assertEquals(commitFilesKey('/r', 'ab'), '/r\nab');
});

Deno.test('the Uncommitted row: when it shows, its count, and its files', () => {
  const none = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  assertEquals(hasUncommitted(undefined), false);
  assertEquals(hasUncommitted(none), false);
  assertEquals(hasUncommitted({ ...none, untracked: 1 }), true);
  assertEquals(hasUncommitted({ ...none, conflicted: 2 }), true);

  const file = (path: string, more = {}) => ({
    path,
    previousPath: null,
    status: 'modified' as const,
    additions: 3,
    deletions: 1,
    binary: false,
    ...more,
  });
  const list = { loading: false, truncated: false, error: null };
  assertEquals(uncommittedCount(undefined), '');
  assertEquals(uncommittedCount({ ...list, files: null, loading: true }), '');
  assertEquals(uncommittedCount({ ...list, files: [file('a')] }), '1 file');
  assertEquals(
    uncommittedCount({ ...list, files: [file('a'), file('b')] }),
    '2 files',
  );
  assertEquals(
    uncommittedCount({ ...list, files: [file('a')], truncated: true }),
    '1+ files',
  );

  assertEquals(fileStat(file('a')), '+3 −1');
  assertEquals(
    fileStat(
      file('n', {
        status: 'added',
        untracked: true,
        additions: 0,
        deletions: 0,
      }),
    ),
    'new',
  );
  assertEquals(fileStat(file('b', { binary: true })), 'binary');
  assertEquals(statusLetter('conflicted'), 'U');
  assertEquals(statusLetter('added'), 'A');
});
