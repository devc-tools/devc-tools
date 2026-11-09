import { assertEquals } from 'jsr:@std/assert';
import {
  diffKey,
  diffRefFromState,
  diffSource,
  fileRefFromState,
  foldTree,
  hostSlotFromState,
  paneRefFromState,
  parseSavedLayout,
  previewFromState,
  sameDiff,
  sameFile,
  sameFileView,
  tileContent,
  tileTitle,
  treeSignature,
  withView,
} from '../web/static/lib/layout_state.js';
import {
  hostGoneFromHash,
  hostOpenFromHash,
  hostPlacementFromHash,
  hostSlotFromHash,
  withoutHostSlot,
} from '../web/static/lib/view.js';

Deno.test('fileRefFromState accepts a full file reference', () => {
  assertEquals(
    fileRefFromState({
      localFolder: '/src/app',
      root: '/src/lib',
      path: 'src/a.ts',
      extra: 1,
    }),
    { localFolder: '/src/app', root: '/src/lib', path: 'src/a.ts' },
  );
});

Deno.test('fileRefFromState returns null for missing, empty or non-string fields', () => {
  const full = { localFolder: '/a', root: '/a', path: 'x' };
  for (const key of ['localFolder', 'root', 'path']) {
    assertEquals(fileRefFromState({ ...full, [key]: undefined }), null);
    assertEquals(fileRefFromState({ ...full, [key]: '' }), null);
    assertEquals(fileRefFromState({ ...full, [key]: 1 }), null);
  }
  assertEquals(fileRefFromState({ localFolder: '/a', pane_id: 'w1:p1' }), null);
  assertEquals(fileRefFromState(null), null);
  assertEquals(fileRefFromState([full]), null);
});

Deno.test("fileRefFromState keeps a container file's flag, and only a true one", () => {
  const full = { localFolder: '/a', root: '/', path: 'etc/hosts' };
  assertEquals(fileRefFromState({ ...full, container: true }), {
    ...full,
    container: true,
  });
  assertEquals(fileRefFromState({ ...full, container: 'yes' }), full);
});

Deno.test('sameFile compares every field, the container flag included', () => {
  const a = { localFolder: '/a', root: '/a', path: 'x' };
  assertEquals(sameFile(a, { ...a }), true);
  assertEquals(sameFile(a, { ...a, localFolder: '/b' }), false);
  assertEquals(sameFile(a, { ...a, root: '/b' }), false);
  assertEquals(sameFile(a, { ...a, path: 'y' }), false);
  const c = { localFolder: '/a', root: '/', path: 'x' };
  assertEquals(sameFile(c, { ...c, container: true }), false);
  assertEquals(
    sameFile({ ...c, container: true }, { ...c, container: true }),
    true,
  );
});

Deno.test('tileContent picks the component type from the ref', () => {
  const file = { localFolder: '/a', root: '/r', path: 'x.ts' };
  assertEquals(tileContent({ file }), { type: 'file', state: file });
  const inContainer = { ...file, root: '/', container: true as const };
  assertEquals(tileContent({ file: inContainer }, true), {
    type: 'file',
    state: { ...inContainer, preview: true },
  });
  assertEquals(
    tileContent({ localFolder: '/a', pane_id: 'w1:p1' }),
    { type: 'pane', state: { localFolder: '/a', pane_id: 'w1:p1' } },
  );
  assertEquals(tileContent(null), { type: 'pane', state: {} });
});

Deno.test('paneRefFromState accepts a full pane reference', () => {
  assertEquals(
    paneRefFromState({ localFolder: '/src/app', pane_id: 'w1:p1', extra: 1 }),
    { localFolder: '/src/app', pane_id: 'w1:p1' },
  );
});

Deno.test('paneRefFromState returns null for missing or non-string fields', () => {
  assertEquals(paneRefFromState({}), null);
  assertEquals(paneRefFromState({ localFolder: '/src/app' }), null);
  assertEquals(paneRefFromState({ pane_id: 'w1:p1' }), null);
  assertEquals(paneRefFromState({ localFolder: 1, pane_id: 'w1:p1' }), null);
  assertEquals(paneRefFromState({ localFolder: '/a', pane_id: '' }), null);
  assertEquals(paneRefFromState(null), null);
  assertEquals(paneRefFromState(undefined), null);
  assertEquals(paneRefFromState('w1:p1'), null);
  assertEquals(paneRefFromState(['/a', 'w1:p1']), null);
});

Deno.test('tileTitle joins container and pane titles', () => {
  assertEquals(tileTitle('alpha', 'claude'), 'alpha · claude');
  assertEquals(tileTitle('alpha', ''), 'alpha');
  assertEquals(tileTitle('', 'claude'), 'claude');
  assertEquals(tileTitle('', ''), '');
});

Deno.test('parseSavedLayout rejects invalid JSON and a missing root', () => {
  assertEquals(parseSavedLayout(null), null);
  assertEquals(parseSavedLayout('not json'), null);
  assertEquals(parseSavedLayout('[]'), null);
  assertEquals(parseSavedLayout('{}'), null);
  assertEquals(parseSavedLayout('{"root":null}'), null);
  assertEquals(parseSavedLayout('{"root":[1]}'), null);
});

Deno.test('parseSavedLayout returns a valid saved layout', () => {
  const saved = {
    root: {
      type: 'row',
      content: [{
        type: 'stack',
        content: [{
          type: 'component',
          componentType: 'pane',
          componentState: { localFolder: '/src/app', pane_id: 'w1:p1' },
          title: 'app · claude',
        }],
      }],
    },
  };
  assertEquals(parseSavedLayout(JSON.stringify(saved)), saved);
});

const tile = (id: string, active = true) => ({
  kind: 'tile' as const,
  id,
  active,
});
const node = (
  kind: 'row' | 'column' | 'stack',
  id: string,
  ...children: ReturnType<typeof foldTree>[]
) => ({ kind, id, children: children as NonNullable<typeof children[0]>[] });

Deno.test('foldTree keeps a lone tile and drops nothing from null', () => {
  assertEquals(foldTree(null), null);
  assertEquals(foldTree(tile('t1')), tile('t1'));
});

Deno.test('foldTree replaces single-child rows, columns and stacks by the child', () => {
  assertEquals(foldTree(node('stack', 's1', tile('t1'))), tile('t1'));
  assertEquals(
    foldTree(node('row', 'r1', node('stack', 's1', tile('t1')))),
    tile('t1'),
  );
  assertEquals(
    foldTree(
      node('column', 'c1', node('row', 'r1', node('stack', 's1', tile('t1')))),
    ),
    tile('t1'),
  );
});

Deno.test('foldTree keeps nodes with several children and drops empty ones', () => {
  const tree = node(
    'row',
    'r1',
    node('stack', 's1', tile('t1'), tile('t2', false)),
    node('stack', 's2', tile('t3')),
    node('stack', 's3'),
  );
  assertEquals(
    foldTree(tree),
    node(
      'row',
      'r1',
      node('stack', 's1', tile('t1'), tile('t2', false)),
      tile('t3'),
    ),
  );
  assertEquals(foldTree(node('row', 'r1', node('stack', 's1'))), null);
});

Deno.test('treeSignature follows shape, ids and active flags only', () => {
  const a = node('row', 'r1', tile('t1'), tile('t2'));
  assertEquals(
    treeSignature(a),
    treeSignature(node('row', 'r1', tile('t1'), tile('t2'))),
  );
  assertEquals(treeSignature(null), '');
  const different = [
    node('row', 'r1', tile('t2'), tile('t1')),
    node('row', 'r1', tile('t1'), tile('t2', false)),
    node('column', 'r1', tile('t1'), tile('t2')),
    node('row', 'r2', tile('t1'), tile('t2')),
    node('row', 'r1', tile('t1')),
    node('row', 'r1', tile('t1'), tile('t2'), tile('t3')),
  ];
  for (const d of different) {
    assertEquals(treeSignature(d) === treeSignature(a), false);
  }
});

Deno.test('previewFromState: only preview: true counts', () => {
  assertEquals(
    previewFromState({ localFolder: '/a', pane_id: 'p', preview: true }),
    true,
  );
  for (
    const s of [
      { localFolder: '/a', pane_id: 'p' },
      { preview: 'true' },
      { preview: 1 },
      null,
      [],
      'x',
    ]
  ) {
    assertEquals(previewFromState(s), false, JSON.stringify(s));
  }
});

Deno.test('tileContent: a preview carries preview: true, and the refs still parse', () => {
  const pane = tileContent({ localFolder: '/a', pane_id: 'p' }, true);
  assertEquals(pane, {
    type: 'pane',
    state: { localFolder: '/a', pane_id: 'p', preview: true },
  });
  assertEquals(paneRefFromState(pane.state), {
    localFolder: '/a',
    pane_id: 'p',
  });
  assertEquals(previewFromState(pane.state), true);
  const file = tileContent({
    file: { localFolder: '/a', root: '/a', path: 'x' },
  }, true);
  assertEquals(file.state.preview, true);
  assertEquals(fileRefFromState(file.state), {
    localFolder: '/a',
    root: '/a',
    path: 'x',
  });
  assertEquals(tileContent(null, true), {
    type: 'pane',
    state: { preview: true },
  });
  assertEquals(
    tileContent({ localFolder: '/a', pane_id: 'p' }).state.preview,
    undefined,
  );
});

Deno.test('fileRefFromState keeps a view only when it differs from the default', () => {
  const at = (path: string) => ({ localFolder: '/a', root: '/a', path });
  // Saved before views existed: unchanged.
  assertEquals(fileRefFromState(at('x.png')), at('x.png'));
  assertEquals(fileRefFromState(at('x.svg')), at('x.svg'));
  assertEquals(fileRefFromState({ ...at('x.svg'), view: 'media' }), {
    ...at('x.svg'),
    view: 'media',
  });
  assertEquals(fileRefFromState({ ...at('x.png'), view: 'text' }), {
    ...at('x.png'),
    view: 'text',
  });
  // The default, a view a non-media file can't have, and junk are all dropped.
  assertEquals(
    fileRefFromState({ ...at('x.png'), view: 'media' }),
    at('x.png'),
  );
  assertEquals(fileRefFromState({ ...at('x.svg'), view: 'text' }), at('x.svg'));
  assertEquals(fileRefFromState({ ...at('x.ts'), view: 'media' }), at('x.ts'));
  assertEquals(fileRefFromState({ ...at('x.svg'), view: 'big' }), at('x.svg'));
});

Deno.test('tileContent round-trips a file view through fileRefFromState', () => {
  const base = { localFolder: '/a', root: '/r', path: 'p/x.html' };
  for (
    const file of [
      base,
      withView(base, 'media'),
      { ...base, path: 'x.gif' },
      withView({ ...base, path: 'x.gif' }, 'text'),
    ]
  ) {
    const { state } = tileContent({ file }, true);
    assertEquals(fileRefFromState(state), file);
  }
  assertEquals(
    tileContent({ file: { ...base, view: 'text' } }).state,
    base,
  );
  assertEquals(
    tileContent({ file: { ...base, view: 'media' } }).state,
    { ...base, view: 'media' },
  );
});

Deno.test('sameFileView tells a file as text from the same file as media', () => {
  const svg = { localFolder: '/a', root: '/a', path: 'i.svg' };
  const asMedia = withView(svg, 'media');
  assertEquals(sameFile(svg, asMedia), true);
  assertEquals(sameFileView(svg, asMedia), false);
  assertEquals(sameFileView(svg, withView(svg, 'text')), true);
  // An explicit default view is the default.
  const png = { localFolder: '/a', root: '/a', path: 'i.png' };
  assertEquals(sameFileView(png, { ...png, view: 'media' }), true);
  assertEquals(sameFileView(png, { ...png, view: 'text' }), false);
});

Deno.test('a diff ref keeps uncommitted changes through a saved layout', () => {
  const pr = { localFolder: '/a', root: '/a/r', path: 'x.ts' };
  const changes = { ...pr, changes: 'HEAD' };
  const commit = { ...pr, sha: 'ab'.repeat(20) };
  assertEquals(diffSource(changes), 'changes');

  const state = tileContent({ diff: changes }, true);
  assertEquals(state, { type: 'diff', state: { ...changes, preview: true } });
  assertEquals(
    diffRefFromState(JSON.parse(JSON.stringify(state.state))),
    changes,
  );

  // Both sources at once, or an empty or non-string ref, drops the tile.
  assertEquals(diffRefFromState({ ...commit, changes: 'HEAD' }), null);
  for (const bad of ['', 42, null]) {
    assertEquals(diffRefFromState({ ...pr, changes: bad }), null);
  }

  assertEquals(sameDiff(changes, { ...changes }), true);
  assertEquals(sameDiff(changes, pr), false);
  assertEquals(sameDiff(changes, commit), false);
  assertEquals(diffKey(changes) === diffKey(pr), false);
  assertEquals(diffKey(changes) === diffKey(commit), false);
});

Deno.test('a diff ref keeps its side of the index through a saved layout', () => {
  const changes = {
    localFolder: '/a',
    root: '/a/r',
    path: 'x.ts',
    changes: 'HEAD',
  };
  const staged = { ...changes, stage: 'staged' as const };
  const unstaged = { ...changes, stage: 'unstaged' as const };
  assertEquals(diffSource(staged), 'changes');
  for (const ref of [staged, unstaged]) {
    const state = tileContent({ diff: ref }, false);
    assertEquals(state, { type: 'diff', state: ref });
    assertEquals(
      diffRefFromState(JSON.parse(JSON.stringify(state.state))),
      ref,
    );
  }
  // A stage without changes, or any other value, drops the tile.
  const { changes: _c, ...noChanges } = staged;
  assertEquals(diffRefFromState(noChanges), null);
  for (const bad of ['both', '', 1]) {
    assertEquals(diffRefFromState({ ...changes, stage: bad }), null);
  }
  assertEquals(sameDiff(staged, unstaged), false);
  assertEquals(sameDiff(staged, changes), false);
  assertEquals(sameDiff(unstaged, changes), false);
  assertEquals(sameDiff(staged, { ...staged }), true);
  assertEquals(new Set([staged, unstaged, changes].map(diffKey)).size, 3);
});

Deno.test('a diff ref keeps a commit sha through a saved layout, and tells commits apart', () => {
  const pr = { localFolder: '/a', root: '/a/r', path: 'x.ts' };
  const sha = 'ab'.repeat(20);
  const commit = { ...pr, sha };
  assertEquals(diffSource(pr), 'pr');
  assertEquals(diffSource(commit), 'commit');

  // Saved and restored: the PR ref as before, the commit's with its sha.
  const prState = tileContent({ diff: pr }, true);
  assertEquals(prState, {
    type: 'diff',
    state: { ...pr, preview: true },
  });
  assertEquals(diffRefFromState(prState.state), pr);
  const commitState = tileContent({ diff: commit });
  assertEquals(commitState, { type: 'diff', state: commit });
  assertEquals(diffRefFromState(commitState.state), commit);
  assertEquals(
    diffRefFromState(JSON.parse(JSON.stringify(commitState.state))),
    commit,
  );

  // A malformed sha drops the tile, as a missing path does.
  for (const bad of ['abc1234', 'AB'.repeat(20), 42, '', `${sha}~1`]) {
    assertEquals(diffRefFromState({ ...pr, sha: bad }), null);
  }
  assertEquals(
    diffRefFromState({ ...pr, sha: 'cd'.repeat(32) })?.sha,
    'cd'.repeat(32),
  );

  assertEquals(sameDiff(pr, { ...pr }), true);
  assertEquals(sameDiff(commit, { ...commit }), true);
  assertEquals(sameDiff(pr, commit), false);
  assertEquals(sameDiff(commit, { ...commit, sha: 'cd'.repeat(20) }), false);
  assertEquals(diffKey(pr) === diffKey(commit), false);
  assertEquals(
    diffKey(commit) === diffKey({ ...commit, sha: 'cd'.repeat(20) }),
    false,
  );
});

const SLOT = '0123456789abcdef0123456789abcdef';

Deno.test('hostSlotFromState accepts only 32 lowercase hex characters', () => {
  assertEquals(hostSlotFromState({ hostSlot: SLOT }), SLOT);
  assertEquals(hostSlotFromState({ hostSlot: SLOT.toUpperCase() }), null);
  assertEquals(hostSlotFromState({ hostSlot: SLOT.slice(1) }), null);
  assertEquals(hostSlotFromState({ hostSlot: `${SLOT}0` }), null);
  assertEquals(hostSlotFromState({ hostSlot: 7 }), null);
  assertEquals(hostSlotFromState({}), null);
  assertEquals(hostSlotFromState(null), null);
  assertEquals(hostSlotFromState([SLOT]), null);
});

Deno.test('tileContent: a host tile is type host with its slot, never a preview', () => {
  assertEquals(tileContent({ host: SLOT }), {
    type: 'host',
    state: { hostSlot: SLOT },
  });
  assertEquals(tileContent({ host: SLOT }, true), {
    type: 'host',
    state: { hostSlot: SLOT },
  });
});

Deno.test('a host tile round-trips through a saved layout', () => {
  const { type, state } = tileContent({ host: SLOT });
  const saved = {
    root: {
      type: 'stack',
      content: [{
        type: 'component',
        componentType: type,
        componentState: state,
      }],
    },
  };
  const back = parseSavedLayout(JSON.stringify(saved));
  assertEquals(back, saved);
  const item = (back?.root as { content: { componentState: unknown }[] })
    .content[0];
  assertEquals(hostSlotFromState(item.componentState), SLOT);
});

Deno.test('parseSavedLayout drops host tiles with a malformed slot, and what they leave empty', () => {
  const pane = {
    type: 'component',
    componentType: 'pane',
    componentState: { localFolder: '/a', pane_id: 'p1' },
  };
  const bad = {
    type: 'component',
    componentType: 'host',
    componentState: { hostSlot: 'x' },
  };
  const good = {
    type: 'component',
    componentType: 'host',
    componentState: { hostSlot: SLOT },
  };
  const saved = {
    root: {
      type: 'row',
      content: [
        { type: 'stack', activeItemIndex: 2, content: [pane, good, bad] },
        { type: 'stack', content: [bad] },
      ],
    },
  };
  assertEquals(parseSavedLayout(JSON.stringify(saved)), {
    root: {
      type: 'row',
      content: [{ type: 'stack', activeItemIndex: 1, content: [pane, good] }],
    },
  });
  // Nothing left: no layout.
  assertEquals(
    parseSavedLayout(
      JSON.stringify({ root: { type: 'stack', content: [bad] } }),
    ),
    null,
  );
});

Deno.test('hostSlotFromHash reads host-slot; withoutHostSlot takes it out and keeps the rest', () => {
  assertEquals(
    hostSlotFromHash(`#view=v1&host-slot=${SLOT}&sidebar=shown`),
    SLOT,
  );
  assertEquals(hostSlotFromHash(`host-slot=${SLOT}`), SLOT);
  assertEquals(hostSlotFromHash('#host-slot=nothex'), null);
  assertEquals(hostSlotFromHash('#view=v1'), null);
  assertEquals(
    withoutHostSlot(`#view=v1&host-slot=${SLOT}&sidebar=shown`),
    '#view=v1&sidebar=shown',
  );
  assertEquals(withoutHostSlot(`#host-slot=${SLOT}`), '');
});

Deno.test('hostPlacementFromHash: beside a well-formed slot, right, below or stack only', () => {
  const at = 'fedcba9876543210fedcba9876543210';
  assertEquals(
    hostPlacementFromHash(`#host-slot=${SLOT}&host-at=${at}&host-where=below`),
    { at, where: 'below' },
  );
  assertEquals(hostPlacementFromHash(`#host-slot=${SLOT}`), null);
  assertEquals(hostPlacementFromHash(`#host-at=${at}&host-where=left`), null);
  assertEquals(hostPlacementFromHash(`#host-at=nothex&host-where=right`), null);
  assertEquals(
    withoutHostSlot(
      `#view=v1&host-slot=${SLOT}&host-at=${at}&host-where=stack`,
    ),
    '#view=v1',
  );
});

Deno.test('hostOpenFromHash: an absolute path, a line and column; withoutHostSlot drops all three', () => {
  const hash =
    '#view=v1&open-host-file=%2Fsrc%2Fapi%2FREADME.md&open-line=3&open-column=7';
  assertEquals(hostOpenFromHash(hash), {
    path: '/src/api/README.md',
    line: 3,
    column: 7,
  });
  assertEquals(withoutHostSlot(hash), '#view=v1');
  assertEquals(hostOpenFromHash('#open-host-file=%2Fa%20b.txt'), {
    path: '/a b.txt',
  });
  // A column needs a line; a bad number is left out.
  assertEquals(hostOpenFromHash('#open-host-file=%2Fa&open-column=4'), {
    path: '/a',
  });
  assertEquals(hostOpenFromHash('#open-host-file=%2Fa&open-line=0'), {
    path: '/a',
  });
  assertEquals(hostOpenFromHash('#open-host-file=README.md'), null);
  assertEquals(hostOpenFromHash('#view=v1'), null);
});

Deno.test('hostGoneFromHash reads host-gone; withoutHostSlot takes it out too', () => {
  assertEquals(hostGoneFromHash(`#view=v1&host-gone=${SLOT}`), SLOT);
  assertEquals(hostGoneFromHash('#host-gone=xyz'), null);
  assertEquals(hostGoneFromHash('#view=v1'), null);
  assertEquals(withoutHostSlot(`#view=v1&host-gone=${SLOT}`), '#view=v1');
});
