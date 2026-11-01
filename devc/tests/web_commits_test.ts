import { assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import { commitRows, commitTitle } from '../web/static/lib/commits.js';

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
