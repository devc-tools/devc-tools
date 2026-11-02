import { assertEquals } from 'jsr:@std/assert';
import {
  draftKey,
  draftRefFromState,
  isNewFileShortcut,
  nextDraftName,
  suggestedDraftPath,
} from '../web/static/lib/drafts.js';
import {
  fileRefFromState,
  tileContent,
} from '../web/static/lib/layout_state.js';

const key = (over: Record<string, unknown> = {}) => ({
  code: 'KeyN',
  key: 'n',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

Deno.test('draftRefFromState: only a named draft is one', () => {
  assertEquals(draftRefFromState({ draft: 'a', name: 'Untitled-1' }), {
    id: 'a',
    name: 'Untitled-1',
  });
  for (
    const state of [null, [], {}, { draft: 'a' }, { name: 'b' }, {
      draft: '',
      name: 'b',
    }, { draft: 1, name: 'b' }]
  ) {
    assertEquals(draftRefFromState(state), null);
  }
});

Deno.test('tileContent: a draft is a file tile naming no file', () => {
  const { type, state } = tileContent({
    draft: { id: 'a', name: 'Untitled-2' },
  });
  assertEquals(type, 'file');
  assertEquals(state, { draft: 'a', name: 'Untitled-2' });
  assertEquals(fileRefFromState(state), null);
  assertEquals(draftRefFromState(state), { id: 'a', name: 'Untitled-2' });
});

Deno.test('nextDraftName: the lowest free number', () => {
  assertEquals(nextDraftName([]), 'Untitled-1');
  assertEquals(nextDraftName(['Untitled-1', 'Untitled-3']), 'Untitled-2');
});

Deno.test('draftKey: each draft has its own', () => {
  assertEquals(draftKey('a') === draftKey('b'), false);
});

Deno.test('isNewFileShortcut: Cmd+N on a Mac', () => {
  assertEquals(isNewFileShortcut(key({ metaKey: true }), true), true);
  assertEquals(isNewFileShortcut(key({ ctrlKey: true }), true), false);
  assertEquals(isNewFileShortcut(key({ metaKey: true }), false), false);
  assertEquals(
    isNewFileShortcut(key({ metaKey: true, shiftKey: true }), true),
    false,
  );
});

Deno.test('isNewFileShortcut: Alt+Shift+N anywhere, for a browser tab', () => {
  for (const isMac of [true, false]) {
    assertEquals(
      isNewFileShortcut(key({ altKey: true, shiftKey: true, key: 'Ñ' }), isMac),
      true,
    );
  }
});

Deno.test('isNewFileShortcut: leaves the pinned file and a terminal their keys', () => {
  assertEquals(
    isNewFileShortcut(key({ metaKey: true, altKey: true }), true),
    false,
  );
  assertEquals(
    isNewFileShortcut(key({ ctrlKey: true, altKey: true }), false),
    false,
  );
  assertEquals(isNewFileShortcut(key({ ctrlKey: true }), false), false);
  assertEquals(isNewFileShortcut(key(), false), false);
});

Deno.test('isNewFileShortcut: a synthesized key press has no code', () => {
  assertEquals(
    isNewFileShortcut(key({ code: '', metaKey: true }), true),
    true,
  );
  assertEquals(
    isNewFileShortcut(key({ code: 'KeyM', key: 'm', metaKey: true }), true),
    false,
  );
});

Deno.test('suggestedDraftPath: beside the file it opened near', () => {
  assertEquals(
    suggestedDraftPath('Untitled-1', 'src/a/b.ts'),
    'src/a/Untitled-1',
  );
  assertEquals(suggestedDraftPath('Untitled-1', 'b.ts'), 'Untitled-1');
  assertEquals(suggestedDraftPath('Untitled-1', null), 'Untitled-1');
});
