import { assertEquals } from 'jsr:@std/assert';
import { join } from 'jsr:@std/path';
import {
  type DashboardFile,
  dashboardMessage,
  readDashboard,
  writeDashboard,
} from '../web/dashboard.ts';

const page: DashboardFile = {
  localFolder: '/src/cockpit',
  root: '/src/cockpit',
  path: 'dashboard.html',
};

async function inTempDir(fn: (path: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(join(dir, 'nested', 'dashboard.json'));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('readDashboard: a missing or corrupt file is no dashboard', async () => {
  await inTempDir(async (path) => {
    assertEquals(await readDashboard(path), null);
    await Deno.mkdir(join(path, '..'), { recursive: true });
    await Deno.writeTextFile(path, '{nope');
    assertEquals(await readDashboard(path), null);
  });
});

Deno.test('readDashboard: malformed files are no dashboard; extra keys are dropped', async () => {
  await inTempDir(async (path) => {
    await Deno.mkdir(join(path, '..'), { recursive: true });
    for (
      const file of [
        null,
        { ...page, localFolder: 'relative' },
        { ...page, root: '' },
        { ...page, path: '' },
        { ...page, path: '/abs.html' },
      ]
    ) {
      await Deno.writeTextFile(path, JSON.stringify({ version: 1, file }));
      assertEquals(await readDashboard(path), null, JSON.stringify(file));
    }
    await Deno.writeTextFile(
      path,
      JSON.stringify({ version: 1, file: { ...page, extra: 1 } }),
    );
    assertEquals(await readDashboard(path), page);
  });
});

Deno.test('writeDashboard: round-trips, clears, makes the folder, leaves no temp file', async () => {
  await inTempDir(async (path) => {
    await writeDashboard(page, path);
    assertEquals(await readDashboard(path), page);
    await writeDashboard(null, path);
    assertEquals(await readDashboard(path), null);
    const names = [];
    for await (const e of Deno.readDir(join(path, '..'))) names.push(e.name);
    assertEquals(names, ['dashboard.json']);
  });
});

Deno.test('dashboardMessage', () => {
  assertEquals(dashboardMessage(page), { type: 'dashboard', file: page });
  assertEquals(dashboardMessage(null), { type: 'dashboard', file: null });
});
