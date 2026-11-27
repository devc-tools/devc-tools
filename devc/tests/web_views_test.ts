// The view registry of `devc web`'s `/sidebar`, `/main` and `/containers` pages (`web/views.ts`): who gets which
// relayed message, the last state, and its timeout. Pure; no sockets.
import { assertEquals } from 'jsr:@std/assert';
import { VIEW_IDLE_MS, ViewRegistry } from '../web/views.ts';

const STATE = { tiles: [{ id: 't1' }], tree: null, focused: 't1' };

function setup() {
  let now = 1_000;
  const reg = new ViewRegistry<string>({ now: () => now });
  return { reg, advance: (ms: number) => now += ms };
}

/** Deliveries as `to:type` strings, sorted. */
function who(out: { to: string; msg: Record<string, unknown> }[]): string[] {
  return out.map((d) => `${d.to}:${d.msg.type}`).sort();
}

Deno.test('views: view_state reaches the sidebars of its own view only', () => {
  const { reg } = setup();
  reg.join('main1', 'v1', 'tiles');
  reg.join('side1', 'v1', 'sidebar');
  reg.join('side1b', 'v1', 'sidebar');
  reg.join('main2', 'v2', 'tiles');
  reg.join('side2', 'v2', 'sidebar');
  const out = reg.state('main1', 'v1', STATE);
  assertEquals(who(out), ['side1:view_state', 'side1b:view_state']);
  assertEquals(out[0].msg, { type: 'view_state', view: 'v1', state: STATE });
});

Deno.test('views: intents go to the other role in the same view', () => {
  const { reg } = setup();
  reg.join('main1', 'v1', 'tiles');
  reg.join('main1b', 'v1', 'tiles');
  reg.join('side1', 'v1', 'sidebar');
  reg.join('main2', 'v2', 'tiles');
  reg.join('side2', 'v2', 'sidebar');
  const vi = reg.viewIntent('side1', 'v1', 'reveal', ['t1']);
  assertEquals(who(vi), ['main1:view_intent', 'main1b:view_intent']);
  assertEquals(vi[0].msg, {
    type: 'view_intent',
    view: 'v1',
    name: 'reveal',
    args: ['t1'],
  });
  const si = reg.sidebarIntent('main2', 'v2', 'revealInContainers', [{
    localFolder: '/w',
    pane_id: 'p',
  }]);
  assertEquals(who(si), ['side2:sidebar_intent']);
  assertEquals(si[0].msg.name, 'revealInContainers');
});

Deno.test('views: the wrong role, or a view not joined, relays nothing', () => {
  const { reg } = setup();
  reg.join('main1', 'v1', 'tiles');
  reg.join('side1', 'v1', 'sidebar');
  assertEquals(reg.state('side1', 'v1', STATE), []);
  assertEquals(reg.viewIntent('main1', 'v1', 'close', ['t1']), []);
  assertEquals(
    reg.sidebarIntent('side1', 'v1', 'prViewed', [{}, 'VIEWED']),
    [],
  );
  // Joined v1, naming v2; never joined at all.
  reg.join('side2', 'v2', 'sidebar');
  assertEquals(reg.state('main1', 'v2', STATE), []);
  assertEquals(reg.viewIntent('stranger', 'v1', 'close', ['t1']), []);
  // The ignored state was not kept: a late sidebar gets nothing.
  assertEquals(reg.join('side1c', 'v1', 'sidebar'), []);
});

Deno.test('views: a late sidebar joiner gets the last state; a tiles joiner does not', () => {
  const { reg } = setup();
  reg.join('main1', 'v1', 'tiles');
  assertEquals(reg.join('early', 'v1', 'sidebar'), []);
  reg.state('main1', 'v1', STATE);
  const late = reg.join('late', 'v1', 'sidebar');
  assertEquals(late, [{
    to: 'late',
    msg: { type: 'view_state', view: 'v1', state: STATE },
  }]);
  assertEquals(reg.join('main1b', 'v1', 'tiles'), []);
});

Deno.test('views: a second join replaces the first; leaving stops relays', () => {
  const { reg } = setup();
  reg.join('main1', 'v1', 'tiles');
  reg.join('side', 'v1', 'sidebar');
  reg.join('side', 'v2', 'sidebar');
  assertEquals(reg.state('main1', 'v1', STATE), []);
  reg.join('main2', 'v2', 'tiles');
  assertEquals(who(reg.state('main2', 'v2', STATE)), ['side:view_state']);
  reg.leave('side');
  assertEquals(reg.state('main2', 'v2', STATE), []);
  reg.leave('nobody');
});

Deno.test('views: a memberless view keeps its state for the idle time, then drops it', () => {
  const { reg, advance } = setup();
  reg.join('main1', 'v1', 'tiles');
  reg.state('main1', 'v1', STATE);
  reg.leave('main1');
  // A reloading main page: back within the idle time, the sidebar still gets the state.
  advance(VIEW_IDLE_MS - 1);
  assertEquals(reg.views(), ['v1']);
  assertEquals(reg.join('side', 'v1', 'sidebar').length, 1);
  reg.leave('side');
  advance(VIEW_IDLE_MS);
  assertEquals(reg.views(), []);
  assertEquals(reg.join('side', 'v1', 'sidebar'), []);
});

Deno.test('views: a tiles joiner is sent nothing; intents are not replayed', () => {
  const { reg } = setup();
  reg.join('main1', 'v1', 'tiles');
  reg.join('side', 'v1', 'sidebar');
  reg.viewIntent('side', 'v1', 'close', ['t1']);
  // A reloaded main page.
  reg.leave('main1');
  assertEquals(reg.join('main1', 'v1', 'tiles'), []);
});

const IN_USE = { inUse: ['card\n/w\n/w'], pinned: [], filter: 'api' };

Deno.test("views: a Containers section gets the state with In use's cards", () => {
  const { reg } = setup();
  reg.join('main1', 'v1', 'tiles');
  reg.join('side1', 'v1', 'sidebar');
  reg.join('cont1', 'v1', 'containers');
  reg.join('cont2', 'v2', 'containers');
  // Before any In use cards: the tiling area's state alone, to the sidebar and Containers.
  const first = reg.state('main1', 'v1', STATE);
  assertEquals(who(first), ['cont1:view_state', 'side1:view_state']);
  // A sidebar's cards: to the Containers sections only, with the last state.
  const cards = reg.state('side1', 'v1', IN_USE);
  assertEquals(who(cards), ['cont1:view_state']);
  assertEquals(cards[0].msg, {
    type: 'view_state',
    view: 'v1',
    state: { ...STATE, ...IN_USE },
  });
  // The next tiling state carries them on to Containers, not to the sidebar.
  const next = reg.state('main1', 'v1', { ...STATE, focused: null });
  const byTo = Object.fromEntries(next.map((d) => [d.to, d.msg.state]));
  assertEquals(byTo.side1, { ...STATE, focused: null });
  assertEquals(byTo.cont1, { ...STATE, focused: null, ...IN_USE });
});

Deno.test("views: a late Containers joiner gets In use's cards, with no tiling state yet", () => {
  const { reg } = setup();
  reg.join('cont0', 'v1', 'containers');
  assertEquals(reg.join('cont0', 'v1', 'containers'), []);
  reg.join('side1', 'v1', 'sidebar');
  reg.state('side1', 'v1', IN_USE);
  assertEquals(reg.join('cont1', 'v1', 'containers'), [{
    to: 'cont1',
    msg: {
      type: 'view_state',
      view: 'v1',
      state: { tiles: [], tree: null, focused: null, ...IN_USE },
    },
  }]);
  // A sidebar joiner still waits for a tiling state.
  assertEquals(reg.join('side2', 'v1', 'sidebar'), []);
});

Deno.test("views: In use's cards from anyone but a sidebar, or a tiling state without tiles, are ignored", () => {
  const { reg } = setup();
  reg.join('main1', 'v1', 'tiles');
  reg.join('side1', 'v1', 'sidebar');
  reg.join('cont1', 'v1', 'containers');
  assertEquals(reg.state('cont1', 'v1', STATE), []);
  assertEquals(reg.state('cont1', 'v1', IN_USE), []);
  assertEquals(reg.state('main1', 'v1', IN_USE), []);
  // A tiling area's own `inUse` is not kept: In use's cards are the sidebar's.
  const out = reg.state('main1', 'v1', { ...STATE, ...IN_USE });
  assertEquals(out.map((d) => d.msg.state), [STATE, STATE]);
});

Deno.test("views: a sidebar's filter goes on to Containers; none is ''", () => {
  const { reg } = setup();
  reg.join('side1', 'v1', 'sidebar');
  reg.join('cont1', 'v1', 'containers');
  const filtered = reg.state('side1', 'v1', IN_USE);
  assertEquals((filtered[0].msg.state as { filter: string }).filter, 'api');
  // An older sidebar sends none: the last one is not kept.
  const none = reg.state('side1', 'v1', { inUse: [], pinned: [] });
  assertEquals((none[0].msg.state as { filter: string }).filter, '');
});

Deno.test('views: containers_intent goes from sidebars to Containers, inuse_intent back', () => {
  const { reg } = setup();
  reg.join('main1', 'v1', 'tiles');
  reg.join('side1', 'v1', 'sidebar');
  reg.join('cont1', 'v1', 'containers');
  reg.join('cont1b', 'v1', 'containers');
  reg.join('side2', 'v2', 'sidebar');
  reg.join('cont2', 'v2', 'containers');
  const ref = { localFolder: '/w', pane_id: 'p' };
  const ci = reg.containersIntent('side1', 'v1', 'reveal', [ref]);
  assertEquals(who(ci), [
    'cont1:containers_intent',
    'cont1b:containers_intent',
  ]);
  assertEquals(ci[0].msg, {
    type: 'containers_intent',
    view: 'v1',
    name: 'reveal',
    args: [ref],
  });
  const ii = reg.inUseIntent('cont2', 'v2', 'pin', ['k', true]);
  assertEquals(who(ii), ['side2:inuse_intent']);
  assertEquals(ii[0].msg, {
    type: 'inuse_intent',
    view: 'v2',
    name: 'pin',
    args: ['k', true],
  });
  // The wrong role, or the wrong view, relays nothing.
  assertEquals(reg.containersIntent('main1', 'v1', 'reveal', [ref]), []);
  assertEquals(reg.containersIntent('cont1', 'v1', 'setFold', []), []);
  assertEquals(reg.inUseIntent('side1', 'v1', 'revealInUse', ['k']), []);
  assertEquals(reg.inUseIntent('main1', 'v1', 'pin', ['k', true]), []);
  assertEquals(reg.inUseIntent('cont1', 'v2', 'pin', ['k', true]), []);
  // A Containers section's ViewIntents reach the tiling area, as a sidebar's do.
  assertEquals(who(reg.viewIntent('cont1', 'v1', 'openPane', [ref])), [
    'main1:view_intent',
  ]);
});

// ---------------------------------------------------------------------------------------------
// Several tiling areas per view: devc-desktop's tile windows (`main=` in a `/main` page's hash).
// ---------------------------------------------------------------------------------------------

const W = 'wabc12345';
const PRIMARY = {
  tiles: [{ id: 't1' }],
  tree: {
    kind: 'stack',
    id: 's1',
    children: [{ kind: 'tile', id: 't1', active: true }],
  },
  focused: 't1',
  outline: { tile: 't1', items: [] },
};
const EXTRA = {
  tiles: [{ id: 't1' }, { id: 't2' }],
  tree: {
    kind: 'stack',
    id: 's1',
    children: [
      { kind: 'tile', id: 't1', active: true },
      { kind: 'tile', id: 't2', active: false },
    ],
  },
  focused: 't2',
  outline: null,
};

function twoMains() {
  const { reg } = setup();
  reg.join('primary', 'v', 'tiles');
  reg.join('extra', 'v', 'tiles', W);
  reg.join('side', 'v', 'sidebar');
  reg.state('primary', 'v', PRIMARY);
  return { reg };
}

Deno.test('views: one main relays its state verbatim', () => {
  const { reg } = setup();
  reg.join('primary', 'v', 'tiles');
  reg.join('side', 'v', 'sidebar');
  const out = reg.state('primary', 'v', PRIMARY);
  assertEquals(out[0].msg.state, PRIMARY);
});

Deno.test("views: two mains merge, an extra main's ids prefixed, the target's focus", () => {
  const { reg } = twoMains();
  const out = reg.state('extra', 'v', EXTRA);
  assertEquals(who(out), ['side:view_state']);
  const state = out[0].msg.state as Record<string, unknown>;
  assertEquals(state.tiles, [
    { id: 't1' },
    { id: `${W}:t1`, window: W },
    { id: `${W}:t2`, window: W },
  ]);
  assertEquals(state.tree, {
    kind: 'row',
    id: 'windows',
    children: [PRIMARY.tree, {
      kind: 'stack',
      id: `${W}:s1`,
      children: [
        { kind: 'tile', id: `${W}:t1`, active: true },
        { kind: 'tile', id: `${W}:t2`, active: false },
      ],
    }],
  });
  // The primary is the target until another main sends view_focus.
  assertEquals(state.focused, 't1');
  assertEquals(state.outline, PRIMARY.outline);
  const focused = reg.focus('extra', 'v');
  assertEquals(who(focused), ['side:view_state']);
  const after = focused[0].msg.state as Record<string, unknown>;
  assertEquals(after.focused, `${W}:t2`);
  assertEquals(after.outline, null);
  // Focusing the target again changes nothing; a sidebar's view_focus is ignored.
  assertEquals(reg.focus('extra', 'v'), []);
  assertEquals(reg.focus('side', 'v'), []);
});

Deno.test("views: the target's leaving falls back to the primary, its tiles gone", () => {
  const { reg } = twoMains();
  reg.state('extra', 'v', EXTRA);
  reg.focus('extra', 'v');
  const out = reg.leave('extra');
  assertEquals(who(out), ['side:view_state']);
  assertEquals(out[0].msg.state, PRIMARY);
  assertEquals(who(reg.viewIntent('side', 'v', 'openFile', [{}, 'stack'])), [
    'primary:view_intent',
  ]);
});

Deno.test('views: intents route by tile id, opens to the target, prViewed to all', () => {
  const { reg } = twoMains();
  reg.state('extra', 'v', EXTRA);
  const close = reg.viewIntent('side', 'v', 'close', [`${W}:t1`]);
  assertEquals(who(close), ['extra:view_intent']);
  assertEquals(close[0].msg.args, ['t1']);
  const own = reg.viewIntent('side', 'v', 'close', ['t1']);
  assertEquals(who(own), ['primary:view_intent']);
  assertEquals(own[0].msg.args, ['t1']);
  // An unknown main's prefix is the primary's id, unchanged.
  const stray = reg.viewIntent('side', 'v', 'reveal', ['nope:t1']);
  assertEquals(who(stray), ['primary:view_intent']);
  assertEquals(stray[0].msg.args, ['nope:t1']);
  assertEquals(reg.viewIntent('side', 'v', 'close', ['windows']), []);
  const line = reg.viewIntent('side', 'v', 'revealLine', [`${W}:t2`, 4, 9]);
  assertEquals(line[0].msg.args, ['t2', 4, 9]);
  // Opens go to the target.
  assertEquals(who(reg.viewIntent('side', 'v', 'openFile', [{}, 'stack'])), [
    'primary:view_intent',
  ]);
  reg.focus('extra', 'v');
  assertEquals(who(reg.viewIntent('side', 'v', 'openDiff', [{}, 'stack'])), [
    'extra:view_intent',
  ]);
  const ref = { localFolder: '/w', pane_id: 'p' };
  assertEquals(who(reg.viewIntent('side', 'v', 'openPane', [ref])), [
    'extra:view_intent',
  ]);
  // openPane's `at` decides when given.
  const at = reg.viewIntent('side', 'v', 'openPane', [ref, {
    where: 'right',
    at: 't1',
  }]);
  assertEquals(who(at), ['primary:view_intent']);
  const atExtra = reg.viewIntent('side', 'v', 'openPane', [ref, {
    where: 'right',
    at: `${W}:t2`,
  }]);
  assertEquals(who(atExtra), ['extra:view_intent']);
  assertEquals(atExtra[0].msg.args, [ref, { where: 'right', at: 't2' }]);
  assertEquals(
    who(reg.viewIntent('side', 'v', 'prViewed', [{}, 'VIEWED'])),
    ['extra:view_intent', 'primary:view_intent'],
  );
});

Deno.test("views: a Containers section gets the merged state; the primary's outlives its page", () => {
  const { reg } = twoMains();
  reg.join('cont', 'v', 'containers');
  const out = reg.state('extra', 'v', EXTRA);
  const byTo = Object.fromEntries(out.map((d) => [d.to, d.msg.state]));
  assertEquals((byTo.cont as { tiles: unknown[] }).tiles.length, 3);
  // A reloading primary: its state stays for a late sidebar.
  reg.leave('primary');
  const late = reg.join('late', 'v', 'sidebar');
  assertEquals(
    (late[0].msg.state as { tiles: unknown[] }).tiles.length,
    3,
  );
});
