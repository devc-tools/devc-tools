import { assertEquals } from 'jsr:@std/assert';
import {
  bridgeStatusItems,
  formatIn,
  parseBridgeStatus,
  parseUsage,
  usageItems,
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

const NOW = 1_760_000_000;
const win = (label: string, pct: number, resetsAt: number | null) => ({
  id: label,
  label,
  usedPercentage: pct,
  resetsAt,
});
const usage = (
  observedAt: number,
  windows: ReturnType<typeof win>[],
  agent = 'claude',
) => ({
  agent,
  observedAt,
  windows,
});

Deno.test('parseUsage keeps valid sources and windows, drops the rest', () => {
  assertEquals(
    parseUsage({
      type: 'usage',
      sources: [
        {
          agent: 'claude',
          observedAt: NOW,
          windows: [win('5h', 42, NOW + 60), { id: 'x' }, win('7d', 1, null)],
        },
        { agent: '', observedAt: NOW, windows: [] },
        null,
      ],
    }),
    [usage(NOW, [win('5h', 42, NOW + 60), win('7d', 1, null)])],
  );
  assertEquals(parseUsage({ type: 'usage', sources: [] }), []);
  assertEquals(parseUsage({ type: 'usage' }), null);
  assertEquals(parseUsage(null), null);
});

Deno.test('formatIn', () => {
  assertEquals(
    [-1, 12 * 60, 2 * 3600, 2 * 3600 + 5 * 60, 3 * 86400 + 4 * 3600, 3 * 86400]
      .map(
        formatIn,
      ),
    ['0m', '12m', '2h', '2h5m', '3d4h', '3d'],
  );
});

Deno.test('usageItems: the 5h window in the strip, every window in the tooltip', () => {
  const items = usageItems(
    [
      usage(NOW - 240, [
        win('7d', 18, NOW + 6 * 86400 + 4 * 3600),
        win('5h', 33.4, NOW + 3 * 3600 + 10 * 60),
        win('7d opus', 4, null),
      ]),
    ],
    NOW,
  );
  assertEquals(items.map((i) => [i.key, i.state, i.text]), [
    ['usage:claude', 'usage', '33%/3h10m'],
  ]);
  assertEquals(items[0].title, '7d 18%/6d4h\n5h 33%/3h10m\n7d opus 4%/?');
});

Deno.test('usageItems: a source without a 5h window shows its first window', () => {
  const [item] = usageItems(
    [usage(NOW, [win('1mo', 30, null), win('1d', 5, NOW + 60)])],
    NOW,
  );
  assertEquals([item.state, item.text], ['usage', '30%/?']);
  assertEquals(item.title, '1mo 30%/?\n1d 5%/1m');
});

Deno.test('usageItems: a passed reset shows the window as —, never the old percentage', () => {
  const [item] = usageItems(
    [usage(NOW, [win('5h', 97, NOW - 60), win('7d', 40, NOW + 60)])],
    NOW,
  );
  assertEquals([item.state, item.text], ['reset', '—']);
  assertEquals(item.title, '5h —\n7d 40%/1m');
  const [other] = usageItems(
    [usage(NOW, [win('5h', 20, NOW + 60), win('7d', 97, NOW - 60)])],
    NOW,
  );
  assertEquals([other.state, other.text], ['usage', '20%/1m']);
  assertEquals(other.title, '5h 20%/1m\n7d —');
});

Deno.test('usageItems: high from any window, even one the strip does not show', () => {
  const [item] = usageItems(
    [usage(NOW - 7200, [win('5h', 10, NOW + 60), win('7d', 95, NOW + 600)])],
    NOW,
  );
  assertEquals([item.state, item.text], ['high', '10%/1m']);
  const [stale] = usageItems(
    [usage(NOW - 16 * 60, [win('5h', 10, NOW + 60)])],
    NOW,
  );
  assertEquals([stale.state, stale.text], ['stale', '10%/1m']);
});

Deno.test('usageItems: agent named when several, none for empty sources', () => {
  const items = usageItems(
    [
      usage(NOW, [win('5h', 95, NOW + 60), win('7d', 20, null)]),
      usage(NOW - 16 * 60, [win('1mo', 30, NOW + 86400)], 'copilot'),
      usage(NOW, [], 'pi'),
    ],
    NOW,
  );
  assertEquals(items.map((i) => [i.state, i.text, i.title]), [
    ['high', 'claude 95%/1m', 'claude\n5h 95%/1m\n7d 20%/?'],
    ['stale', 'copilot 30%/1d', 'copilot\n1mo 30%/1d'],
  ]);
  assertEquals(usageItems([], NOW), []);
  assertEquals(usageItems([usage(NOW, [])], NOW), []);
});
