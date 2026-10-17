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

Deno.test('usageItems: one terse item per source, windows in the source order', () => {
  const items = usageItems(
    [usage(NOW - 240, [win('5h', 77.4, NOW + 3600), win('7d', 11, null)])],
    NOW,
  );
  assertEquals(items.map((i) => [i.state, i.text]), [['usage', '77/11%']]);
  assertEquals(
    items[0].title,
    '1h/?',
  );
});

Deno.test('usageItems: a passed reset shows the window as —, never the old percentage', () => {
  const [item] = usageItems(
    [usage(NOW - 7200, [win('5h', 97, NOW - 60), win('7d', 40, NOW + 60)])],
    NOW,
  );
  assertEquals([item.state, item.text], ['stale', '—/40%']);
  assertEquals(
    item.title,
    '—/1m',
  );
  const [all] = usageItems([usage(NOW, [win('5h', 97, NOW - 60)])], NOW);
  assertEquals([all.state, all.text], ['reset', '—%']);
});

Deno.test('usageItems: high near the limit, stale when old, agent named when several', () => {
  assertEquals(
    usageItems(
      [
        usage(NOW, [win('5h', 95, NOW + 60), win('7d', 20, null)]),
        usage(NOW - 16 * 60, [win('1mo', 30, NOW + 86400)], 'copilot'),
      ],
      NOW,
    ).map((i) => [i.state, i.text]),
    [['high', 'claude 95/20%'], ['stale', 'copilot 30%']],
  );
  assertEquals(usageItems([], NOW), []);
  assertEquals(usageItems([usage(NOW, [])], NOW), []);
});
