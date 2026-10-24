// The view registry of `devc web`'s `/sidebar` and `/main` pages (`web/views.ts`): who gets which
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
