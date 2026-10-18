import { assertEquals } from 'jsr:@std/assert';
import {
  fileRefFromState,
  foldTree,
  paneRefFromState,
  parseSavedLayout,
  previewFromState,
  sameFile,
  tileContent,
  tileTitle,
  treeSignature,
} from '../web/static/lib/layout_state.js';

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
