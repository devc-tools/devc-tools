import { assertEquals } from 'jsr:@std/assert';
import { isVisible, revealed, visibleFolders } from '../web/visible_repos.ts';

const report = (all: boolean, ...folders: string[]) => ({
  all,
  folders: new Set(folders),
});

Deno.test('visibleFolders: every folder with no client saying, or one saying all', () => {
  assertEquals(visibleFolders([]), null);
  assertEquals(visibleFolders([{ desktop: false }]), null);
  assertEquals(
    visibleFolders([
      { desktop: false, report: report(false, '/a') },
      { desktop: false, report: report(true) },
    ]),
    null,
  );
});

Deno.test('visibleFolders: the union of what the clients say; a silent page shows nothing', () => {
  assertEquals(
    visibleFolders([
      { desktop: false, report: report(false, '/a') },
      { desktop: false, report: report(false, '/b', '/a') },
      // `/main` or the host status page: never says.
      { desktop: false },
    ]),
    new Set(['/a', '/b']),
  );
  // Projects folded and nothing in use.
  assertEquals(
    visibleFolders([{ desktop: false, report: report(false) }]),
    new Set(),
  );
});

Deno.test('visibleFolders: a desktop pane that never says shows every folder', () => {
  assertEquals(
    visibleFolders([
      { desktop: false, report: report(false, '/a') },
      { desktop: true },
    ]),
    null,
  );
  assertEquals(
    visibleFolders([
      { desktop: false, report: report(false, '/a') },
      { desktop: true, report: report(false) },
    ]),
    new Set(['/a']),
  );
});

Deno.test('revealed: the folders hidden before and shown now', () => {
  const folders = ['/a', '/b', '/c'];
  assertEquals(revealed(new Set(['/a']), null, folders), ['/b', '/c']);
  assertEquals(revealed(new Set(['/a']), new Set(['/a', '/b']), folders), [
    '/b',
  ]);
  assertEquals(revealed(null, new Set(['/a']), folders), []);
  assertEquals(isVisible(null, '/x'), true);
  assertEquals(isVisible(new Set(['/a']), '/x'), false);
});
