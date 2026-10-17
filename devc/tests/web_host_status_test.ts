import { assertEquals } from 'jsr:@std/assert';
import {
  bridgeStatusItems,
  parseBridgeStatus,
} from '../web/static/lib/host_status.js';

Deno.test('parseBridgeStatus accepts the message and drops non-string markers', () => {
  assertEquals(
    parseBridgeStatus({
      type: 'bridge_status',
      running: true,
      active: ['caffeinate', 3, null],
    }),
    { running: true, active: ['caffeinate'] },
  );
});

Deno.test('parseBridgeStatus refuses a malformed message', () => {
  assertEquals(parseBridgeStatus({ type: 'bridge_status' }), null);
  assertEquals(parseBridgeStatus({ running: 'yes', active: [] }), null);
  assertEquals(parseBridgeStatus({ running: true, active: 'x' }), null);
  assertEquals(parseBridgeStatus(null), null);
});

Deno.test('bridgeStatusItems: running, nothing active', () => {
  assertEquals(
    bridgeStatusItems({ running: true, active: [] }).map((i) => i.text),
    ['bridge ●'],
  );
});

Deno.test('bridgeStatusItems: off', () => {
  const [item] = bridgeStatusItems({ running: false, active: [] });
  assertEquals([item.state, item.text], ['off', 'bridge ○ off']);
});

Deno.test('bridgeStatusItems: caffeinate is "awake", other markers verbatim', () => {
  assertEquals(
    bridgeStatusItems({
      running: true,
      active: ['caffeinate', '<b>x</b>'],
    }).map((i) => [i.state, i.text]),
    [['on', 'bridge ●'], ['awake', '☕ awake'], ['marker', '<b>x</b>']],
  );
});
