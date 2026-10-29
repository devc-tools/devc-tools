import { assertEquals, assertNotEquals } from 'jsr:@std/assert';
import {
  CONTAINERS_INTENT_NAMES,
  containersExternalFromHash,
  DRAG_MIME,
  emptyViewState,
  encodeDrag,
  fileKey,
  focusedTile,
  INUSE_INTENT_NAMES,
  inUseState,
  layoutSignature,
  layoutTiles,
  nodeById,
  nodeTiles,
  parseDrag,
  previewTileNear,
  relayedIntent,
  relayedState,
  scopeFromSearch,
  SIDEBAR_INTENT_NAMES,
  statusExternalFromHash,
  tileMarks,
  tileShowingDiff,
  tileShowingFile,
  tileShowingPane,
  VIEW_INTENT_NAMES,
  viewIdFromHash,
  zenFromSearch,
} from '../web/static/lib/view.js';

type TileState = import('../web/static/lib/view.js').TileState;
type ViewState = import('../web/static/lib/view.js').ViewState;

function tile(id: string, over: Partial<TileState> = {}): TileState {
  return {
    id,
    kind: 'pane',
    ref: null,
    file: null,
    diff: null,
    preview: false,
    focusSeq: 0,
    title: '',
    dirty: false,
    saveable: false,
    url: null,
    ...over,
  };
}

const pane = (pane_id: string) => ({ localFolder: '/src/app', pane_id });
const file = (path: string) => ({
  localFolder: '/src/app',
  root: '/src/app',
  path,
});

// row(stack(t1, t2*), stack(t3*)): t2 is its stack's front tab, t1 behind it.
const STATE: ViewState = {
  tiles: [
    tile('t1', { ref: pane('p1'), focusSeq: 3 }),
    tile('t2', { ref: pane('p1'), focusSeq: 5, preview: true }),
    tile('t3', { kind: 'file', file: file('a.ts'), title: 'a.ts' }),
  ],
  tree: {
    kind: 'row',
    id: 'n1',
    children: [
      {
        kind: 'stack',
        id: 'n2',
        children: [
          { kind: 'tile', id: 't1', active: false },
          { kind: 'tile', id: 't2', active: true },
        ],
      },
      {
        kind: 'stack',
        id: 'n3',
        children: [{ kind: 'tile', id: 't3', active: true }],
      },
    ],
  },
  focused: 't3',
};

Deno.test('layoutTiles lists the tiles in layout order, front tabs marked', () => {
  assertEquals(
    layoutTiles(STATE).map(({ tile, active }) => [tile.id, active]),
    [['t1', false], ['t2', true], ['t3', true]],
  );
  assertEquals(layoutTiles({ tiles: [], tree: null, focused: null }), []);
});

Deno.test('focusedTile is the tile a sidebar click opens into', () => {
  assertEquals(focusedTile(STATE)?.id, 't3');
  assertEquals(focusedTile({ ...STATE, focused: null }), null);
});

Deno.test('tileShowingPane picks the most recently focused tile showing the pane', () => {
  assertEquals(tileShowingPane(STATE, pane('p1'))?.id, 't2');
  assertEquals(tileShowingPane(STATE, pane('p9')), null);
});

Deno.test('tileShowingFile matches the file shown the same way', () => {
  assertEquals(tileShowingFile(STATE, file('a.ts'))?.id, 't3');
  assertEquals(tileShowingFile(STATE, file('b.ts')), null);
});

Deno.test('tileShowingDiff matches a PR file by repo and path', () => {
  const diff = { localFolder: '/src/app', root: '/src/app', path: 'a.ts' };
  const state = {
    ...STATE,
    tiles: [...STATE.tiles, tile('t4', { kind: 'diff', diff })],
  };
  assertEquals(tileShowingDiff(state, diff)?.id, 't4');
  assertEquals(tileShowingDiff(STATE, diff), null);
});

Deno.test("previewTileNear finds the preview tile in a tile's stack", () => {
  assertEquals(previewTileNear(STATE, 't1')?.id, 't2');
  assertEquals(previewTileNear(STATE, 't3'), null);
  assertEquals(previewTileNear(STATE, null), null);
});

Deno.test('nodeById and nodeTiles find a stack and the tiles under it', () => {
  const stack = nodeById(STATE, 'n2');
  assertEquals(stack?.kind, 'stack');
  assertEquals(nodeTiles(STATE, stack!).map((t) => t.id), ['t1', 't2']);
  assertEquals(nodeById(STATE, 't1'), null);
});

Deno.test('layoutSignature changes with what tiles show, not with focus or marks', () => {
  const base = layoutSignature(STATE);
  assertEquals(layoutSignature({ ...STATE, focused: 't1' }), base);
  const marked = {
    ...STATE,
    tiles: STATE.tiles.map((t) => t.id === 't3' ? { ...t, dirty: true } : t),
  };
  assertEquals(layoutSignature(marked), base);
  assertNotEquals(tileMarks(marked), tileMarks(STATE));
  const kept = {
    ...STATE,
    tiles: STATE.tiles.map((t) => t.id === 't2' ? { ...t, preview: false } : t),
  };
  assertNotEquals(layoutSignature(kept), base);
});

Deno.test('fileKey tells a file as media from the same file as text', () => {
  const html = file('index.html');
  assertNotEquals(fileKey(html), fileKey({ ...html, view: 'media' }));
  assertEquals(fileKey(file('a.ts')), fileKey(file('a.ts')));
});

Deno.test('viewIdFromHash: the hash view, else default', () => {
  assertEquals(viewIdFromHash('#token=abc&view=v1'), 'v1');
  assertEquals(viewIdFromHash('view=a_B-9'), 'a_B-9');
  assertEquals(viewIdFromHash('#token=abc'), 'default');
  assertEquals(viewIdFromHash('#view='), 'default');
  assertEquals(viewIdFromHash('#view=a%20b'), 'default');
  assertEquals(viewIdFromHash(`#view=${'x'.repeat(65)}`), 'default');
  assertEquals(viewIdFromHash(''), 'default');
});

Deno.test('relayedIntent and relayedState: only their view, known names', () => {
  assertEquals(
    relayedIntent(
      { type: 'view_intent', view: 'v', name: 'reveal', args: ['t1'] },
      'view_intent',
      'v',
      VIEW_INTENT_NAMES,
    ),
    { name: 'reveal', args: ['t1'] },
  );
  assertEquals(
    relayedIntent(
      { type: 'view_intent', view: 'w', name: 'reveal', args: ['t1'] },
      'view_intent',
      'v',
      VIEW_INTENT_NAMES,
    ),
    null,
  );
  assertEquals(
    relayedIntent(
      { type: 'sidebar_intent', view: 'v', name: 'state', args: [] },
      'sidebar_intent',
      'v',
      SIDEBAR_INTENT_NAMES,
    ),
    null,
  );
  assertEquals(
    relayedIntent(
      { type: 'sidebar_intent', view: 'v', name: 'prViewed', args: 'off' },
      'sidebar_intent',
      'v',
      SIDEBAR_INTENT_NAMES,
    ),
    null,
  );
  assertEquals(
    relayedState({
      type: 'view_state',
      view: 'v',
      state: { tiles: [], tree: null },
    }, 'v'),
    emptyViewState(),
  );
  assertEquals(
    relayedState(
      { type: 'view_state', view: 'w', state: emptyViewState() },
      'v',
    ),
    null,
  );
  assertEquals(relayedState({ type: 'view_state', view: 'v' }, 'v'), null);
});

Deno.test('the Containers contracts: their intent names, and view_state.inUse', () => {
  assertEquals([...CONTAINERS_INTENT_NAMES], ['reveal', 'setFold']);
  assertEquals([...INUSE_INTENT_NAMES], ['revealInUse', 'pin']);
  assertEquals(
    relayedIntent(
      { type: 'containers_intent', view: 'v', name: 'setFold', args: ['pr'] },
      'containers_intent',
      'v',
      CONTAINERS_INTENT_NAMES,
    ),
    { name: 'setFold', args: ['pr'] },
  );
  assertEquals(
    relayedIntent(
      { type: 'inuse_intent', view: 'v', name: 'reveal', args: [] },
      'inuse_intent',
      'v',
      INUSE_INTENT_NAMES,
    ),
    null,
  );
  assertEquals(
    relayedIntent(
      { type: 'inuse_intent', view: 'v', name: 'pin', args: ['k', true] },
      'containers_intent',
      'v',
      CONTAINERS_INTENT_NAMES,
    ),
    null,
  );
  // In use's cards and pins come with the state, strings only; without them, none.
  assertEquals(
    relayedState({
      type: 'view_state',
      view: 'v',
      state: { tiles: [], tree: null, inUse: ['a', 1, 'b'], pinned: ['b'] },
    }, 'v'),
    { ...emptyViewState(), inUse: ['a', 'b'], pinned: ['b'] },
  );
  assertEquals(
    relayedState({
      type: 'view_state',
      view: 'v',
      state: { tiles: [], tree: null, inUse: 'a' },
    }, 'v'),
    emptyViewState(),
  );
  assertEquals(inUseState(new Set(['b', 'a']), ['a']), {
    inUse: ['a', 'b'],
    pinned: ['a'],
  });
});

Deno.test('encodeDrag and parseDrag: a pane or a file round-trips; junk is null', () => {
  assertEquals(DRAG_MIME, 'application/x-devc-web-tile');
  const pane = { localFolder: '/w', pane_id: 'p1' };
  assertEquals(parseDrag(encodeDrag(pane)), pane);
  const file = {
    file: { localFolder: '/w', root: '/workspaces/r', path: 'a.ts' },
  };
  assertEquals(parseDrag(encodeDrag(file)), file);
  const media = {
    file: {
      localFolder: '/w',
      root: '/',
      path: 'x.png',
      container: true as const,
      view: 'text' as const,
    },
  };
  assertEquals(parseDrag(encodeDrag(media)), media);
  for (
    const junk of [
      '',
      'not json',
      'null',
      '[]',
      '"/w"',
      '{}',
      '{"localFolder":"/w"}',
      '{"localFolder":"","pane_id":"p"}',
      '{"localFolder":"/w","pane_id":3}',
      '{"file":null}',
      '{"file":{"localFolder":"/w","root":"/r"}}',
      'https://example.com/',
    ]
  ) assertEquals(parseDrag(junk), null, junk);
});

Deno.test('zenFromSearch: on/off from ?zen= (an old scope is on), else null', () => {
  assertEquals(zenFromSearch('?zen=on'), true);
  assertEquals(zenFromSearch('?zen=off'), false);
  assertEquals(zenFromSearch('?zen=container'), true);
  assertEquals(zenFromSearch('zen=repo&x=1'), true);
  for (const s of ['', '?', '?zen=', '?zen=terminal', '?zen=REPO', '?x=repo']) {
    assertEquals(zenFromSearch(s), null, s);
  }
});

Deno.test('scopeFromSearch: ?scope=, else an old ?zen= scope, else null', () => {
  assertEquals(scopeFromSearch('?scope=all'), 'all');
  assertEquals(scopeFromSearch('scope=container&x=1'), 'container');
  assertEquals(scopeFromSearch('?scope=repo&zen=container'), 'repo');
  assertEquals(scopeFromSearch('?zen=container'), 'container');
  assertEquals(scopeFromSearch('?zen=repo'), 'repo');
  for (
    const s of [
      '',
      '?',
      '?scope=',
      '?scope=ALL',
      '?zen=on',
      '?zen=off',
      '?x=repo',
    ]
  ) {
    assertEquals(scopeFromSearch(s), null, s);
  }
});

Deno.test('statusExternalFromHash: only status=external', () => {
  assertEquals(
    statusExternalFromHash('#token=abc&view=devcd&status=external'),
    true,
  );
  assertEquals(statusExternalFromHash('#token=abc&view=devcd'), false);
  assertEquals(statusExternalFromHash('#status=inline'), false);
  assertEquals(statusExternalFromHash(''), false);
});

Deno.test('containersExternalFromHash: only containers=external', () => {
  assertEquals(
    containersExternalFromHash('#token=abc&view=devcd&containers=external'),
    true,
  );
  assertEquals(containersExternalFromHash('containers=external'), true);
  assertEquals(containersExternalFromHash('#token=abc&view=devcd'), false);
  assertEquals(containersExternalFromHash('#containers=inline'), false);
  assertEquals(containersExternalFromHash(''), false);
});
