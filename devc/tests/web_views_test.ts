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

const IN_USE = { inUse: ['card\n/w\n/w'], pinned: [] };

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
