import { assertEquals } from 'jsr:@std/assert';
import {
  bridgeStatusItems,
  formatAge,
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
const fmt = (at: number) => `T${at}`;
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

Deno.test('formatAge and formatIn', () => {
  assertEquals(
    [-5, 0, 59, 60, 4 * 60 + 30, 3 * 3600 + 1, 2 * 86400].map(formatAge),
    [
      'just now',
      'just now',
      'just now',
      '1 min ago',
      '4 min ago',
      '3 h ago',
      '2 d ago',
    ],
  );
  assertEquals(
    [-1, 12 * 60, 2 * 3600, 2 * 3600 + 5 * 60, 3 * 86400 + 4 * 3600, 3 * 86400]
      .map(
        formatIn,
      ),
    ['in 0 min', 'in 12 min', 'in 2 h', 'in 2 h 5 min', 'in 3 d 4 h', 'in 3 d'],
  );
});

Deno.test('usageItems: windows in the source order, with reset time and age', () => {
  const items = usageItems(
    [usage(NOW - 240, [win('5h', 42.4, NOW + 3600), win('7d', 18, null)])],
    NOW,
    fmt,
  );
  assertEquals(items.map((i) => [i.state, i.text]), [
    ['usage', '5h 42%'],
    ['usage', '7d 18%'],
  ]);
  assertEquals(
    items[0].title,
    `claude 5h usage: 42% used, resets T${
      NOW + 3600
    } (in 1 h); as of 4 min ago`,
  );
  assertEquals(items[1].title, 'claude 7d usage: 18% used; as of 4 min ago');
});

Deno.test('usageItems: a passed reset shows the window as reset, never the old percentage', () => {
  const [item] = usageItems(
    [usage(NOW - 7200, [win('5h', 97, NOW - 60)])],
    NOW,
    fmt,
  );
  assertEquals([item.state, item.text], ['reset', '5h —']);
  assertEquals(
    item.title,
    `claude 5h usage: reset at T${NOW - 60}, no newer report (as of 2 h ago)`,
  );
});

Deno.test('usageItems: high near the limit, stale when old, agent named when several', () => {
  assertEquals(
    usageItems(
      [
        usage(NOW, [win('5h', 95, NOW + 60)]),
        usage(NOW - 16 * 60, [win('1mo', 30, NOW + 86400)], 'copilot'),
      ],
      NOW,
      fmt,
    ).map((i) => [i.state, i.text]),
    [['high', 'claude 5h 95%'], ['stale', 'copilot 1mo 30%']],
  );
  assertEquals(usageItems([], NOW, fmt), []);
});

Deno.test('usageItems: labels are kept verbatim for the page to insert as text', () => {
  const [item] = usageItems([usage(NOW, [win('<b>x', 1, null)])], NOW, fmt);
  assertEquals(item.text, '<b>x 1%');
});
