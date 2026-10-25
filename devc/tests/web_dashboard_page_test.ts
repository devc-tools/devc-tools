import { assertEquals } from 'jsr:@std/assert';
import {
  isDashboardFile,
  parseDashboard,
  reopensDashboard,
} from '../web/static/lib/dashboard.js';

const dash = { localFolder: '/src/app', root: '/src/app', path: 'dash.html' };

Deno.test('parseDashboard: the file, or null for none or a malformed one', () => {
  assertEquals(
    parseDashboard({ type: 'dashboard', file: { ...dash, x: 1 } }),
    dash,
  );
  assertEquals(parseDashboard({ type: 'dashboard', file: null }), null);
  assertEquals(
    parseDashboard({ type: 'dashboard', file: { ...dash, path: '' } }),
    null,
  );
  assertEquals(parseDashboard({ type: 'dashboard' }), null);
  assertEquals(parseDashboard(null), null);
});

Deno.test('isDashboardFile: same file, never a container file', () => {
  assertEquals(isDashboardFile(dash, { ...dash }), true);
  assertEquals(isDashboardFile(dash, { ...dash, path: 'other.md' }), false);
  assertEquals(isDashboardFile(dash, { ...dash, container: true }), false);
  assertEquals(isDashboardFile(null, dash), false);
});

Deno.test('reopensDashboard: only when a close empties the area and the dashboard was not in it', () => {
  const dashTile = { file: { ...dash, view: 'media' } };
  const other = { file: { ...dash, path: 'notes.md' } };
  const term = { file: null };
  assertEquals(reopensDashboard(dash, [other, term], 0), true);
  assertEquals(reopensDashboard(dash, [dashTile], 0), false);
  assertEquals(reopensDashboard(dash, [other, dashTile], 0), false);
  assertEquals(reopensDashboard(dash, [other], 1), false);
  assertEquals(reopensDashboard(dash, [], 0), false);
  assertEquals(reopensDashboard(null, [other], 0), false);
});
