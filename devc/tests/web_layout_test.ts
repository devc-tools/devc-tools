import { assertEquals } from 'jsr:@std/assert';
import {
  foldTree,
  paneRefFromState,
  parseSavedLayout,
  tileTitle,
  treeSignature,
} from '../web/static/lib/layout_state.js';

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
