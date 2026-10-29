import { test } from 'node:test';
import { deepStrictEqual as assertEquals } from 'node:assert/strict';
import {
  actionCard,
  type ActionState,
  appArgs,
  armed,
  badgeText,
  canPush,
  cdTarget,
  clampDrawer,
  CONTAINERS_DEFAULT_SHARE,
  debugReason,
  devcMayNavigate,
  devcOrigin,
  devcPermission,
  devcToken,
  dragColumn,
  dragContainers,
  DRAWER_MIN,
  externalUrl,
  FOOTER_HEIGHT,
  fromView,
  HOST_PEEK,
  hostFolder,
  type Layout,
  layout,
  MAIN_MIN,
  MAX_LABEL,
  MAX_REQUESTS,
  MENU_ITEMS_MAX,
  MENU_MARGIN,
  menuLabel,
  menuRequest,
  PANE_MIN,
  placeMenu,
  planWarnings,
  pushOutcome,
  pushPlanFrom,
  RAIL,
  type Rect,
  requestsAnswer,
  shellIdle,
  shellQuote,
  showText,
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  TITLEBAR_HEIGHT,
} from '../src/main/policy.ts';

const TOKEN = 'ab'.repeat(32);
const PAGE = `http://127.0.0.1:48228/#token=${TOKEN}`;
const ORIGIN = devcOrigin(PAGE);

test('devcOrigin: the ready URL without its path or token', () => {
  assertEquals(ORIGIN, 'http://127.0.0.1:48228');
});

test("devcMayNavigate: devc web's own origin only", () => {
  for (
    const ok of [
      PAGE,
      'http://127.0.0.1:48228/safe/#token=x',
      'http://127.0.0.1:48228/?reload=1',
    ]
  ) {
    assertEquals(devcMayNavigate(ok, ORIGIN), true, ok);
  }
  for (
    const bad of [
      'http://127.0.0.1:48229/',
      'http://localhost:48228/',
      'https://127.0.0.1:48228/',
      'https://example.com/',
      'file:///Applications/devcd.app/Contents/Resources/app.asar/build/renderer/host.html',
      'javascript:alert(1)',
      'about:blank',
      'not a url',
    ]
  ) {
    assertEquals(devcMayNavigate(bad, ORIGIN), false, bad);
  }
});

test('externalUrl: http and https go to the system browser, nothing else', () => {
  assertEquals(
    externalUrl('https://example.com/a?b#c'),
    'https://example.com/a?b#c',
  );
  assertEquals(
    externalUrl('http://127.0.0.1:48228/preview/x'),
    'http://127.0.0.1:48228/preview/x',
  );
  for (
    const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'about:blank',
      'vscode://file/x',
      'ssh://host',
      'data:text/html,x',
      '',
    ]
  ) {
    assertEquals(externalUrl(bad), null, bad);
  }
});

test('devcPermission: copying, and nothing else', () => {
  assertEquals(devcPermission('clipboard-sanitized-write'), true);
  for (
    const p of [
      'clipboard-read',
      'fullscreen',
      'automatic-fullscreen',
      'media',
      'notifications',
      'pointerLock',
      'openExternal',
      'geolocation',
      'background-sync',
      'unknown',
    ]
  ) {
    assertEquals(devcPermission(p), false, p);
  }
});

test('debugReason: any debugging switch, on the command line or in Node flags', () => {
  const none = () => false;
  assertEquals(debugReason(none, []), null);
  assertEquals(debugReason(none, ['--max-old-space-size=4096']), null);
  const port = (s: string) => s === 'remote-debugging-port';
  assertEquals(
    debugReason(port, [])?.includes('--remote-debugging-port'),
    true,
  );
  assertEquals(debugReason(none, ['--inspect'])?.includes('--inspect'), true);
  assertEquals(
    debugReason(none, ['--inspect-brk=9229'])?.includes('--inspect-brk'),
    true,
  );
  assertEquals(debugReason(none, ['--inspectx']), null);
});

test("appArgs: a terminal launch's arguments, less Chromium's own switches", () => {
  assertEquals(appArgs(['/app/devc-desktop'], true), []);
  assertEquals(
    appArgs(['/app/devc-desktop', '--live-yolo', '--source', '/src'], true),
    ['--live-yolo', '--source', '/src'],
  );
  // From source: `electron .` puts the app path second.
  assertEquals(appArgs(['electron', '.', '--live'], false), ['--live']);
  assertEquals(
    appArgs([
      '/app/devc-desktop',
      '--remote-debugging-port=9333',
      '--inspect',
      '--no-sandbox',
      '--disable-gpu',
      '--enable-logging',
      '--ozone-platform=x11',
      '-psn_0_12345',
      '--live',
    ], true),
    ['--live'],
  );
});

test('clampDrawer: at least 120 px, at most 85% of the height', () => {
  assertEquals(clampDrawer(50, 1000), DRAWER_MIN);
  assertEquals(clampDrawer(400, 1000), 400);
  assertEquals(clampDrawer(990, 1000), 850);
  assertEquals(clampDrawer(500, 100), DRAWER_MIN);
});

/** No two rectangles of `l` overlap, and each is inside the window. */
function disjoint(l: Layout, width: number, height: number): void {
  const rs = Object.values(l).filter((r): r is Rect => r !== null);
  for (const r of rs) {
    assertEquals(r.width >= 0 && r.height >= 0, true, JSON.stringify(r));
    assertEquals(r.x >= 0 && r.y >= 0, true, JSON.stringify(r));
    assertEquals(r.x + r.width <= width, true, JSON.stringify(r));
    assertEquals(r.y + r.height <= height, true, JSON.stringify(r));
  }
  for (const [i, a] of rs.entries()) {
    for (const b of rs.slice(i + 1)) {
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width &&
        a.y < b.y + b.height && b.y < a.y + a.height &&
        a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0;
      assertEquals(overlap, false, `${JSON.stringify(a)} ${JSON.stringify(b)}`);
    }
  }
}

const open = {
  width: 1400,
  height: 932,
  sidebarWidth: 340,
  containers: { height: 400 },
  drawer: 300,
  peek: false,
  footer: false,
};

test('layout: every pane open: the column, the rail, /main and the drawer under it', () => {
  const l = layout(open);
  assertEquals(l.bar, { x: 0, y: 0, width: 1400, height: TITLEBAR_HEIGHT });
  assertEquals(l.sidebar, { x: 0, y: 32, width: 340, height: 500 });
  assertEquals(l.containers, { x: 0, y: 532, width: 340, height: 400 });
  assertEquals(l.rail, { x: 340, y: 32, width: RAIL, height: 900 });
  assertEquals(l.main, { x: 346, y: 32, width: 1054, height: 600 });
  // The drawer spans /main's width only.
  assertEquals(l.host, { x: 346, y: 632, width: 1054, height: 300 });
  disjoint(l, 1400, 932);
});

test('layout: the host status strip across the whole window, under the column and the drawer', () => {
  const l = layout({ ...open, footer: true });
  assertEquals(l.footer, {
    x: 0,
    y: 932 - FOOTER_HEIGHT,
    width: 1400,
    height: FOOTER_HEIGHT,
  });
  assertEquals(l.containers!.y + l.containers!.height, l.footer!.y);
  assertEquals(l.host!.y + l.host!.height, l.footer!.y);
  assertEquals(l.rail.height, 900 - FOOTER_HEIGHT);
  disjoint(l, 1400, 932);
  assertEquals(layout(open).footer, null);
  // A window shorter than the title bar has no room for it.
  disjoint(layout({ ...open, footer: true, height: 20 }), 1400, 20);
});

test('layout: the Containers pane hidden, /sidebar takes the column', () => {
  const l = layout({ ...open, containers: null });
  assertEquals(l.containers, null);
  assertEquals(l.sidebar, { x: 0, y: 32, width: 340, height: 900 });
  disjoint(l, 1400, 932);
  // Its default height: a share of the column.
  assertEquals(
    layout({ ...open, containers: { height: null } }).containers!.height,
    Math.round(900 * CONTAINERS_DEFAULT_SHARE),
  );
});

test('layout: the drawer closed, or only its strip while requests wait', () => {
  const closed = layout({ ...open, drawer: null });
  assertEquals(closed.host, null);
  assertEquals(closed.main, { x: 346, y: 32, width: 1054, height: 900 });
  disjoint(closed, 1400, 932);
  const peek = layout({ ...open, drawer: null, peek: true });
  assertEquals(peek.host, {
    x: 346,
    y: 932 - HOST_PEEK,
    width: 1054,
    height: HOST_PEEK,
  });
  assertEquals(peek.main.y + peek.main.height, peek.host!.y);
  // An open drawer ignores `peek`, and is clamped as before.
  assertEquals(layout({ ...open, peek: true }).host, layout(open).host);
  assertEquals(layout({ ...open, drawer: 5000 }).host!.height, 765);
});

test('layout: minimums, and a window too small for them all', () => {
  // The column and the panes keep their minimums while there is room.
  const narrow = layout({
    ...open,
    sidebarWidth: 10,
    containers: { height: 10 },
  });
  assertEquals(narrow.sidebar.width, SIDEBAR_MIN);
  assertEquals(narrow.containers!.height, PANE_MIN);
  const tall = layout({ ...open, containers: { height: 5000 } });
  assertEquals(tall.sidebar.height, PANE_MIN);
  // A wide column gives way to /main's minimum.
  const wide = layout({ ...open, sidebarWidth: 5000 });
  assertEquals(wide.main.width, MAIN_MIN);
  disjoint(wide, 1400, 932);
  // Too small for everything: /main keeps its width first, then the rail, then the column.
  for (const [w, h] of [[500, 200], [MAIN_MIN + 3, 150], [300, 40], [0, 0]]) {
    const l = layout({ ...open, width: w, height: h });
    disjoint(l, w, h);
    assertEquals(l.main.width, Math.max(0, w - l.sidebar.width - l.rail.width));
    assertEquals(l.main.width >= Math.min(MAIN_MIN, w), true, `${w}`);
  }
  assertEquals(layout({ ...open, width: 500, height: 200 }).sidebar.width, 134);
  assertEquals(layout({ ...open, width: MAIN_MIN + 3 }).rail.width, 3);
});

test('dragColumn and dragContainers keep what layout keeps', () => {
  assertEquals(dragColumn(null, 10, 1400), SIDEBAR_DEFAULT + 10);
  assertEquals(dragColumn(300, -500, 1400), SIDEBAR_MIN);
  assertEquals(dragColumn(300, 5000, 1400), 1400 - MAIN_MIN - RAIL);
  // Dragging the strip down shrinks the pane.
  assertEquals(dragContainers(400, 50, 900), 350);
  assertEquals(dragContainers(400, 500, 900), PANE_MIN);
  assertEquals(dragContainers(400, -900, 900), 900 - PANE_MIN);
  assertEquals(dragContainers(null, 0, 900), Math.round(900 * 0.45));
});

test('menuRequest: labels as text, dividers, and a point inside the pane', () => {
  const pane = { width: 300, height: 400 };
  assertEquals(
    menuRequest({
      items: [{ label: 'Stop', danger: false }, null, {
        label: 'Remove\u202e',
        danger: true,
      }],
      x: 10,
      y: 20,
    }, pane),
    {
      items: [{ label: 'Stop', danger: false }, null, {
        label: 'Remove\ufffd',
        danger: true,
      }],
      x: 10,
      y: 20,
    },
  );
  const item = { label: 'a', danger: false };
  assertEquals(menuRequest({ items: [item], x: 301, y: 0 }, pane), null);
  assertEquals(menuRequest({ items: [item], x: -1, y: 0 }, pane), null);
  assertEquals(menuRequest({ items: [], x: 0, y: 0 }, pane), null);
  assertEquals(menuRequest({ items: [{ label: '' }], x: 0, y: 0 }, pane), null);
  assertEquals(menuRequest({ items: ['a'], x: 0, y: 0 }, pane), null);
  assertEquals(
    menuRequest(
      { items: Array(MENU_ITEMS_MAX + 1).fill(item), x: 0, y: 0 },
      pane,
    ),
    null,
  );
  assertEquals(
    menuRequest({ items: [{ label: 'x'.repeat(500) }], x: 0, y: 0 }, pane)!
      .items[0]!.label.length,
    120,
  );
});

test('placeMenu: flips and shifts against the window edges only', () => {
  const win = { width: 1000, height: 800 };
  const size = { width: 184, height: 284 };
  const w = 200;
  const h = 300;
  // Top left: at the point (less the margin its shadow takes).
  assertEquals(placeMenu({ x: 20, y: 30 }, size, win), {
    x: 20 - MENU_MARGIN,
    y: 30 - MENU_MARGIN,
    width: w,
    height: h,
  });
  // Top right: opens leftwards.
  assertEquals(
    placeMenu({ x: 990, y: 30 }, size, win).x,
    990 - w + MENU_MARGIN,
  );
  // Bottom left: opens upwards.
  assertEquals(
    placeMenu({ x: 20, y: 790 }, size, win).y,
    790 - h + MENU_MARGIN,
  );
  // Bottom right: both.
  const br = placeMenu({ x: 990, y: 790 }, size, win);
  assertEquals([br.x, br.y], [990 - w + MENU_MARGIN, 790 - h + MENU_MARGIN]);
  // At a corner it can't open away from: kept inside the window.
  assertEquals(placeMenu({ x: 0, y: 0 }, size, win).x, 0);
  assertEquals(
    placeMenu({ x: 150, y: 100 }, { ...size, width: 990 }, win).x,
    0,
  );
  // Taller than the window: the whole height, from the top; its page scrolls.
  const tall = placeMenu({ x: 20, y: 400 }, { width: 184, height: 2000 }, win);
  assertEquals([tall.y, tall.height], [0, 800]);
  for (const r of [br, tall]) {
    assertEquals(
      r.x + r.width <= win.width && r.y + r.height <= win.height,
      true,
    );
  }
});

test("fromView: only the view's own main frame, at its bundled page", () => {
  const url = 'file:///app/build/renderer/host.html';
  const wc = {};
  const frame = { url };
  const view = { webContents: wc, mainFrame: frame };
  assertEquals(fromView({ sender: wc, senderFrame: frame }, view, url), true);
  assertEquals(
    fromView({ sender: wc, senderFrame: { url: `${url}#x` } }, view, url),
    false,
  );
  frame.url = `${url}#reloaded`;
  assertEquals(fromView({ sender: wc, senderFrame: frame }, view, url), true);
  // Another view (devc web), a subframe, no frame, or the view after navigating away.
  assertEquals(fromView({ sender: {}, senderFrame: frame }, view, url), false);
  assertEquals(
    fromView({ sender: wc, senderFrame: { url } }, view, url),
    false,
  );
  assertEquals(fromView({ sender: wc, senderFrame: null }, view, url), false);
  frame.url = 'http://127.0.0.1:48228/';
  assertEquals(fromView({ sender: wc, senderFrame: frame }, view, url), false);
});

test('devcToken: the 64-hex token after #token=, else null', () => {
  assertEquals(devcToken(PAGE), TOKEN);
  assertEquals(devcToken('http://127.0.0.1:48228/'), null);
  assertEquals(devcToken('http://127.0.0.1:48228/#token=abc'), null);
});

/** A fake filesystem: `links` maps a path to its realpath; `dirs` are the directories. */
function fakeFs(links: Record<string, string>, dirs: string[]) {
  return {
    realpath: (p: string) =>
      p in links
        ? Promise.resolve(links[p])
        : Promise.reject(new Error('ENOENT')),
    stat: (p: string) =>
      dirs.includes(p) || p in links
        ? Promise.resolve({ isDirectory: () => dirs.includes(p) })
        : Promise.reject(new Error('ENOENT')),
  };
}

test('cdTarget: the verified realpath, or the reason as a label', async () => {
  const fs = fakeFs({
    '/h/foo': '/h/foo',
    '/h/foo/sub': '/h/foo/sub',
    '/h/foo/evil': '/etc',
    '/h/foobar': '/h/foobar',
    '/h/foo/file': '/h/foo/file',
    '/h/foo/rtl': '/h/foo/a‮b',
    '/h/foo/long': `/h/foo/${'x'.repeat(250)}`,
    '/h/foo/ok256': `/h/foo/${'x'.repeat(249)}`,
    '/h/foo/link': '/h/foo/sub',
  }, [
    '/h/foo',
    '/h/foo/sub',
    '/etc',
    '/h/foobar',
    '/h/foo/a‮b',
    `/h/foo/${'x'.repeat(250)}`,
    `/h/foo/${'x'.repeat(249)}`,
  ]);
  const ans = (folder: unknown, mount: unknown = '/h/foo') => ({
    ok: true,
    folder,
    mount,
    container: 'c',
    containerFolder: '/workspaces/foo',
  });
  const label = async (a: unknown) => {
    const r = await cdTarget(a, fs);
    return r.ok ? `ok ${r.path}` : r.label;
  };
  assertEquals(
    await label({ ok: false, reason: 'no_active_pane' }),
    'No active terminal in devc web',
  );
  assertEquals(
    await label({ ok: false, reason: 'no_session' }),
    "Its container isn't running",
  );
  assertEquals(
    await label({ ok: false, reason: 'no_cwd' }),
    "The terminal's folder isn't known",
  );
  assertEquals(
    await label({ ok: false, reason: 'not_mounted' }),
    "The terminal's folder isn't mounted from this machine",
  );
  for (const bad of [null, 'x', { ok: false, reason: 'nope' }, { ok: false }]) {
    assertEquals(await label(bad), 'devc web gave no folder');
  }
  for (
    const bad of [ans('rel'), ans('/h/foo/sub', 'rel'), ans(42), ans('/a\0b')]
  ) {
    assertEquals(await label(bad), 'devc web gave no folder');
  }
  assertEquals(
    await label(ans('/h/foo/x'.repeat(600))),
    'devc web gave no folder',
  );
  assertEquals(
    await label(ans('/nope')),
    "The folder doesn't exist on this machine",
  );
  assertEquals(
    await label(ans('/h/foo/evil')),
    'The folder is outside its mount',
  );
  assertEquals(
    await label(ans('/h/foobar')),
    'The folder is outside its mount',
  );
  assertEquals(await label(ans('/h/foo/file')), 'Not a folder');
  assertEquals(
    await label(ans('/h/foo/rtl')),
    "The folder's name can't be shown safely",
  );
  assertEquals(
    await label(ans('/h/foo/long')),
    "The folder's name can't be shown safely",
  );
  assertEquals(
    await label(ans('/h/foo/ok256')),
    `ok /h/foo/${'x'.repeat(249)}`,
  );
  assertEquals(await label(ans('/h/foo')), 'ok /h/foo');
  assertEquals(await label(ans('/h/foo/sub')), 'ok /h/foo/sub');
  // The realpath is what's shown and typed, never the name devc web gave.
  assertEquals(await label(ans('/h/foo/link')), 'ok /h/foo/sub');
  assertEquals(await cdTarget(ans('/h/foo/link'), fs), {
    ok: true,
    path: '/h/foo/sub',
    mount: '/h/foo',
  });
});

test('shellQuote, menuLabel, shellIdle', () => {
  assertEquals(shellQuote("/a/it's"), "'/a/it'\\''s'");
  assertEquals(shellQuote('/a b/$(x)'), "'/a b/$(x)'");
  const t = (path: string, mount = '/m') => ({ path, mount });
  assertEquals(menuLabel(t('/a&b', '/a&b'), '/home/me', 'linux'), 'cd /a&&b');
  assertEquals(menuLabel(t('/a&b', '/a&b'), '/home/me', 'win32'), 'cd /a&&b');
  assertEquals(menuLabel(t('/a&b', '/a&b'), '/home/me', 'darwin'), 'cd /a&b');
  assertEquals(
    menuLabel(
      t('/home/me/src/foo/sub', '/home/me/src/foo'),
      '/home/me',
      'linux',
    ),
    'cd ~/src/foo/sub',
  );
  assertEquals(
    menuLabel(t('/home/meow', '/home/meow'), '/home/me', 'linux'),
    'cd /home/meow',
  );
  assertEquals(
    menuLabel(t('/m/x', '/m'), '/home/me', 'linux', ' (busy: vim)'),
    'cd /m/x (busy: vim)',
  );
  // Too long: the mount's part shortens, the part below it never does.
  const deep = `/home/me/${'d'.repeat(80)}/repo`;
  assertEquals(
    menuLabel(t(`${deep}/sub`, deep), '/home/me', 'linux'),
    'cd …/repo/sub',
  );
  assertEquals(menuLabel(t(deep, deep), '/home/me', 'linux'), 'cd …/repo');
  assertEquals(
    menuLabel(t(`${deep}/sub`, deep), '/home/me', 'linux', ' (busy: sleep)'),
    'cd …/repo/sub (busy: sleep)',
  );
  assertEquals(menuLabel(t(`/m/${'x'.repeat(80)}`), '/home/me', 'linux'), null);
  assertEquals(
    menuLabel(t(`/m/${'x'.repeat(74)}`), '/', 'linux')?.length,
    MAX_LABEL,
  );
  assertEquals(shellIdle('-zsh', '/bin/zsh'), true);
  assertEquals(shellIdle('zsh', '/bin/zsh'), true);
  assertEquals(shellIdle('/bin/bash', '/bin/bash'), true);
  assertEquals(shellIdle('vim', '/bin/zsh'), false);
  assertEquals(shellIdle('sleep', '/usr/bin/bash'), false);
});

// ---- host actions ----

const req = (o: Record<string, unknown> = {}) => ({
  id: '0123456789abcdef',
  kind: 'push',
  localFolder: '/Users/me/src/app',
  folder: '/Users/me/src/app',
  at: 1,
  ...o,
});

test('requestsAnswer: well-formed requests only', () => {
  const good = {
    seq: 3,
    requests: [req(), req({ id: 'ab', kind: 'start', folder: null })],
  };
  assertEquals(requestsAnswer(good), good);
  assertEquals(requestsAnswer({ seq: 0, requests: [] }), {
    seq: 0,
    requests: [],
  });
  for (
    const bad of [
      null,
      'x',
      [],
      { seq: -1, requests: [] },
      { seq: 1.5, requests: [] },
      { seq: 1 },
      { seq: 1, requests: {} },
      // Oversized: more than the server ever keeps.
      {
        seq: 1,
        requests: Array.from(
          { length: MAX_REQUESTS + 1 },
          (_, i) => req({ id: i.toString(16) }),
        ),
      },
      { seq: 1, requests: [req({ id: 'XYZ' })] },
      { seq: 1, requests: [req({ id: '' })] },
      { seq: 1, requests: [req(), req()] },
      { seq: 1, requests: [req({ kind: 'rm' })] },
      { seq: 1, requests: [req({ folder: null })] },
      { seq: 1, requests: [req({ kind: 'stop' })] },
      { seq: 1, requests: [req({ localFolder: 'rel' })] },
      { seq: 1, requests: [req({ folder: `/${'x'.repeat(300)}` })] },
      // A control character, a bidi override, a zero-width space in a folder.
      { seq: 1, requests: [req({ folder: '/src/a\nb' })] },
      { seq: 1, requests: [req({ localFolder: '/src/a\u202eb' })] },
      { seq: 1, requests: [req({ folder: '/src/a\u200bb' })] },
      { seq: 1, requests: [req({ at: 'now' })] },
    ]
  ) {
    assertEquals(requestsAnswer(bad), null, JSON.stringify(bad)?.slice(0, 80));
  }
});

test('hostFolder: the realpath of a showable directory, or why not', async () => {
  const fs = fakeFs(
    {
      '/src/app': '/src/app',
      '/src/link': '/etc',
      '/src/file': '/src/file',
      '/src/x\u202ey': '/src/x\u202ey',
    },
    ['/src/app', '/etc', '/src/x\u202ey'],
  );
  assertEquals(await hostFolder('/src/app', fs), {
    ok: true,
    path: '/src/app',
  });
  // No mount to stay inside here: a symlink resolves, and the card shows where it goes.
  assertEquals(await hostFolder('/src/link', fs), { ok: true, path: '/etc' });
  assertEquals(await hostFolder('/src/file', fs), {
    ok: false,
    label: 'Not a folder',
  });
  assertEquals(await hostFolder('/nope', fs), {
    ok: false,
    label: "The folder doesn't exist on this machine",
  });
  assertEquals((await hostFolder('/src/x\u202ey', fs)).ok, false);
  assertEquals((await hostFolder('rel', fs)).ok, false);
  assertEquals((await hostFolder(null, fs)).ok, false);
});

const SHA = 'a'.repeat(40);
const plan = (o: Record<string, unknown> = {}) => ({
  ok: true,
  folder: '/src/app',
  remote: 'https://github.com/me/app.git',
  branch: 'feature',
  sha: SHA,
  remoteSha: null,
  commits: [{ sha: SHA, subject: 'Add a thing', author: 'Me' }],
  totalCommits: 1,
  defaultBranch: false,
  guarded: [],
  lfs: false,
  fastForward: true,
  upToDate: false,
  ...o,
});

test("pushPlanFrom: devc git push-plan's JSON, checked", () => {
  const p = pushPlanFrom(JSON.stringify(plan()));
  assertEquals(p, plan());
  assertEquals(canPush(p), true);
  assertEquals(planWarnings(p), []);
  assertEquals(pushPlanFrom('{"ok":false,"problem":"no upstream"}'), {
    ok: false,
    problem: 'no upstream',
  });
  for (
    const bad of [
      'not json',
      '[]',
      '{"ok":"yes"}',
      JSON.stringify(plan({ sha: 'main' })),
      JSON.stringify(plan({ commits: 'x' })),
      JSON.stringify(
        plan({ commits: [{ sha: SHA, subject: 1, author: 'a' }] }),
      ),
      JSON.stringify(plan({ totalCommits: 0 })),
      JSON.stringify(plan({ guarded: [1] })),
      JSON.stringify(plan({ lfs: 'no' })),
    ]
  ) {
    assertEquals(pushPlanFrom(bad).ok, false, bad.slice(0, 60));
  }
  const risky = pushPlanFrom(
    JSON.stringify(plan({
      defaultBranch: true,
      branch: 'main',
      guarded: ['.github/workflows/ci.yml'],
    })),
  );
  assertEquals(canPush(risky), true);
  assertEquals(planWarnings(risky), [
    'Pushes the default branch (main)',
    'Changes workflows: .github/workflows/ci.yml',
  ]);
  for (const o of [{ lfs: true }, { fastForward: false }, { upToDate: true }]) {
    assertEquals(canPush(pushPlanFrom(JSON.stringify(plan(o)))), false);
  }
});

test('showText, armed, badgeText, pushOutcome', () => {
  assertEquals(showText('fix: a\u202egnp.exe'), 'fix: a\ufffdgnp.exe');
  assertEquals(showText('a\nb\u0007'), 'a\ufffdb\ufffd');
  assertEquals(showText('abcdef', 4), 'abc…');
  assertEquals(armed(1000, 1999), false);
  assertEquals(armed(1000, 2000), true);
  assertEquals([badgeText(0), badgeText(1), badgeText(2)], [
    '',
    '1 request',
    '2 requests',
  ]);
  assertEquals(pushOutcome('0', 'pushed: x'), { ok: true, text: 'pushed: x' });
  assertEquals(pushOutcome('2', 'the branch moved: …').ok, false);
  assertEquals(pushOutcome('4', undefined).ok, false);
});

test('actionCard: what the column shows, and when it can be confirmed', () => {
  const state = (o: Partial<ActionState>): ActionState => ({
    req: req() as ActionState['req'],
    phase: 'ready',
    target: { ok: true, path: '/src/app' },
    plan: pushPlanFrom(JSON.stringify(plan({
      commits: [{ sha: SHA, subject: 'evil\u202etxt', author: 'A' }],
      totalCommits: 3,
    }))),
    lines: [],
    outcome: null,
    ...o,
  });
  const card = actionCard(state({}), 'deno run devc/main.ts');
  assertEquals(card.confirm, 'Push');
  assertEquals(card.plan?.sha, SHA.slice(0, 12));
  assertEquals(card.plan?.commits[0].subject, 'evil\ufffdtxt');
  assertEquals(card.plan?.more, 2);
  // devc2: every push says devc comes from the checkout.
  assertEquals(card.notes.some((n) => n.includes('from the checkout')), true);
  assertEquals(actionCard(state({}), null).notes, []);
  assertEquals(actionCard(state({ phase: 'planning' }), null).confirm, null);
  assertEquals(actionCard(state({ phase: 'running' }), null).confirm, null);
  const refused = actionCard(
    state({
      phase: 'refused',
      target: { ok: false, label: 'Not a folder' },
      plan: null,
    }),
    null,
  );
  assertEquals([refused.refusal, refused.confirm], ['Not a folder', null]);
  const lfs = state({
    plan: pushPlanFrom(JSON.stringify(plan({ lfs: true }))),
  });
  assertEquals(actionCard(lfs, null).confirm, null);
  const start = actionCard(
    state({
      req: req({ kind: 'start', folder: null }) as ActionState['req'],
      plan: null,
    }),
    'devc2',
  );
  assertEquals(start.confirm, 'Start container');
  assertEquals(start.notes, [
    "Runs its devcontainer.json's initializeCommand on this machine",
  ]);
});
