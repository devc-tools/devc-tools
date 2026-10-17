import { assertEquals } from 'jsr:@std/assert';
import {
  paneRefFromState,
  parseSavedLayout,
  tileTitle,
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
