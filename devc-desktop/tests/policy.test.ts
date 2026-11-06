import { test } from 'node:test';
import { deepStrictEqual as assertEquals } from 'node:assert/strict';
import {
  actionCard,
  type ActionState,
  ambiguousPress,
  appArgs,
  armed,
  badgeText,
  canPush,
  cdTarget,
  cellOf,
  clampDrawer,
  CONTAINERS_DEFAULT_SHARE,
  COVER_MS,
  type CoverChange,
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
  HOST_THEMES,
  hostFolder,
  hostMenuEntries,
  hostPermission,
  hostShortcut,
  hostTerminalOptions,
  hostTheme,
  hostThemeOf,
  isShellId,
  type Layout,
  layout,
  MAIN_MIN,
  MAX_LABEL,
  MAX_REQUESTS,
  MENU_ITEMS_MAX,
  MENU_MARGIN,
  menuLabel,
  menuRequest,
  openFileRequest,
  PANE_MIN,
  paneRequest,
  parseSlotLine,
  placeMenu,
  placeSlot,
  planWarnings,
  pushOutcome,
  pushPlanFrom,
  RAIL,
  recentChanges,
  type Rect,
  REQUEST_KINDS_PARAM,
  requestsAnswer,
  shellQuote,
  showText,
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  swatchBitmap,
  swatchTone,
  TERMINAL_NOTE,
  terminalCommand,
  termSize,
  TITLEBAR_HEIGHT,
} from '../src/main/policy.ts';
import { terminalTheme, themeNamed } from 'devc-web/lib/themes.js';

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

test('hostPermission: copying, never reading the clipboard', () => {
  assertEquals(hostPermission('clipboard-sanitized-write'), true);
  for (
    const p of ['clipboard-read', 'fullscreen', 'media', 'notifications']
  ) {
    assertEquals(hostPermission(p), false, p);
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
  column: true,
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

test('layout: a folded Containers section: the pane down to its heading, /sidebar takes the rest', () => {
  const l = layout({ ...open, containers: { height: 400, folded: 30 } });
  assertEquals(l.containers, { x: 0, y: 902, width: 340, height: 30 });
  assertEquals(l.sidebar, { x: 0, y: 32, width: 340, height: 870 });
  disjoint(l, 1400, 932);
  // Never past the column.
  assertEquals(
    layout({ ...open, containers: { height: null, folded: 5000 } }).containers!
      .height,
    900,
  );
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

test("layout: the column hidden: no rail, /main from the window's edge", () => {
  const l = layout({ ...open, column: false });
  assertEquals(l.sidebar, null);
  assertEquals(l.containers, null);
  assertEquals(l.rail.width, 0);
  assertEquals(l.main, { x: 0, y: 32, width: 1400, height: 600 });
  assertEquals(l.host, { x: 0, y: 632, width: 1400, height: 300 });
  disjoint(l, 1400, 932);
  // A folded Containers section has no pane either.
  assertEquals(
    layout({ ...open, column: false, containers: { height: 400, folded: 30 } })
      .containers,
    null,
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
  assertEquals(narrow.sidebar!.width, SIDEBAR_MIN);
  assertEquals(narrow.containers!.height, PANE_MIN);
  const tall = layout({ ...open, containers: { height: 5000 } });
  assertEquals(tall.sidebar!.height, PANE_MIN);
  // A wide column gives way to /main's minimum.
  const wide = layout({ ...open, sidebarWidth: 5000 });
  assertEquals(wide.main.width, MAIN_MIN);
  disjoint(wide, 1400, 932);
  // Too small for everything: /main keeps its width first, then the rail, then the column.
  for (const [w, h] of [[500, 200], [MAIN_MIN + 3, 150], [300, 40], [0, 0]]) {
    const l = layout({ ...open, width: w, height: h });
    disjoint(l, w, h);
    assertEquals(
      l.main.width,
      Math.max(0, w - l.sidebar!.width - l.rail.width),
    );
    assertEquals(l.main.width >= Math.min(MAIN_MIN, w), true, `${w}`);
  }
  assertEquals(
    layout({ ...open, width: 500, height: 200 }).sidebar!.width,
    134,
  );
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

test('shellQuote, menuLabel', () => {
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

test('requestsAnswer and paneRequest: a terminal names its repo folder', () => {
  const terminal = req({ kind: 'terminal' });
  assertEquals(requestsAnswer({ seq: 1, requests: [terminal] }), {
    seq: 1,
    requests: [terminal],
  });
  assertEquals(
    requestsAnswer({
      seq: 1,
      requests: [req({ kind: 'terminal', folder: null })],
    }),
    null,
  );
  assertEquals(paneRequest('x', 'terminal', '/src/app', '/src/app/lib', 5), {
    id: 'x',
    kind: 'terminal',
    localFolder: '/src/app',
    folder: '/src/app/lib',
    at: 5,
  });
  assertEquals(paneRequest('x', 'terminal', '/src/app', null, 5), null);
  assertEquals(
    paneRequest('x', 'terminal', '/src/app', '/src/a\u202eb', 5),
    null,
  );
  // What the app asks devc web for: every kind it understands.
  assertEquals(REQUEST_KINDS_PARAM, 'push,start,stop,down,terminal');
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
  const terminal = actionCard(
    state({
      req: req({ kind: 'terminal', folder: '/src/app' }) as ActionState['req'],
      plan: null,
    }),
    'devc2',
  );
  assertEquals(
    [terminal.title, terminal.confirm, terminal.plan, terminal.folder],
    ['Open host terminal', 'Open', null, '/src/app'],
  );
  assertEquals(terminal.notes, [TERMINAL_NOTE]);
  assertEquals(
    TERMINAL_NOTE,
    'Your shell starts here: its prompt and tools like direnv may run what this folder holds',
  );
  const off = actionCard(
    state({
      req: req({ kind: 'terminal' }) as ActionState['req'],
      phase: 'refused',
      target: { ok: false, label: 'The host terminal needs Herdr: x' },
      plan: null,
    }),
    null,
  );
  assertEquals(
    [off.refusal, off.confirm],
    ['The host terminal needs Herdr: x', null],
  );
});

test('isShellId: Herdr pane ids, nothing longer or odder', () => {
  assertEquals(isShellId('w1:p1'), true);
  assertEquals(isShellId('w12:p3'), true);
  for (const id of ['', 'a'.repeat(65), 'a/b', 'a b', 1, null, undefined]) {
    assertEquals(isShellId(id), false);
  }
});

test('terminalCommand: only what Herdr takes, rebuilt', () => {
  assertEquals(terminalCommand({ type: 'terminal.input', bytes: 'aGk=' }), {
    type: 'terminal.input',
    bytes: 'aGk=',
  });
  assertEquals(
    terminalCommand({ type: 'terminal.input', bytes: 'hi there' }),
    null,
  );
  assertEquals(
    terminalCommand({ type: 'terminal.resize', cols: 80, rows: 24, x: 1 }),
    { type: 'terminal.resize', cols: 80, rows: 24 },
  );
  assertEquals(
    terminalCommand({ type: 'terminal.resize', cols: 0, rows: 24 }),
    null,
  );
  assertEquals(
    terminalCommand({ type: 'terminal.scroll', direction: 'up', lines: 3 }),
    { type: 'terminal.scroll', direction: 'up', lines: 3 },
  );
  assertEquals(
    terminalCommand({ type: 'terminal.scroll', direction: 'left', lines: 3 }),
    null,
  );
  assertEquals(
    terminalCommand({
      type: 'terminal.mouse',
      action: 'drag',
      button: 'left',
      column: 4,
      row: 2,
    }),
    {
      type: 'terminal.mouse',
      action: 'drag',
      button: 'left',
      column: 4,
      row: 2,
    },
  );
  assertEquals(
    terminalCommand({
      type: 'terminal.mouse',
      action: 'down',
      column: -1,
      row: 2,
    }),
    null,
  );
  assertEquals(terminalCommand({ type: 'terminal.release' }), null);
  assertEquals(terminalCommand(null), null);
  assertEquals(cellOf({ column: 3, row: 4 }), { column: 3, row: 4 });
  assertEquals(cellOf({ column: 3.5, row: 4 }), null);
  assertEquals(termSize(120, 80), 120);
  assertEquals(termSize('120', 80), 80);
});

test('openFileRequest: an absolute path, no .., a line and a column', () => {
  assertEquals(openFileRequest({ path: '/src/a.ts', line: 3, column: 7 }), {
    path: '/src/a.ts',
    line: 3,
    column: 7,
  });
  assertEquals(openFileRequest({ path: '/src/a.ts', column: 7 }), {
    path: '/src/a.ts',
  });
  for (
    const path of ['a.ts', '/src/../etc/passwd', '/a\nb', '', 3, undefined]
  ) {
    assertEquals(openFileRequest({ path }), null);
  }
});

test('hostMenuEntries: the drawer and a host tile, the same list', () => {
  const want = [
    'split-right',
    'split-below',
    'new-tab',
    'separator',
    'cd',
    'separator',
    'move',
    'separator',
    'close',
    'close-terminal',
  ];
  assertEquals(hostMenuEntries('drawer'), want);
  assertEquals(hostMenuEntries('slot'), want);
});

test('hostShortcut: on a Mac, Cmd; elsewhere Ctrl+Shift, leaving Ctrl to the shell', () => {
  const key = (code: string, over: object = {}) => ({
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });
  const cmd = { metaKey: true };
  assertEquals(hostShortcut(key('KeyD', cmd), true), 'split-right');
  assertEquals(
    hostShortcut(key('KeyD', { ...cmd, shiftKey: true }), true),
    'split-below',
  );
  assertEquals(hostShortcut(key('KeyT', cmd), true), 'new-tab');
  assertEquals(hostShortcut(key('KeyW', cmd), true), 'close');
  assertEquals(hostShortcut(key('KeyD', { ctrlKey: true }), true), null);
  assertEquals(hostShortcut(key('KeyT', { ...cmd, altKey: true }), true), null);

  const both = { ctrlKey: true, shiftKey: true };
  assertEquals(hostShortcut(key('KeyD', both), false), 'split-right');
  assertEquals(
    hostShortcut(key('KeyD', { ...both, altKey: true }), false),
    'split-below',
  );
  assertEquals(hostShortcut(key('KeyT', both), false), 'new-tab');
  assertEquals(hostShortcut(key('KeyW', both), false), 'close');
  // Ctrl+D is the shell's end of input, Ctrl+W its word rub-out.
  assertEquals(hostShortcut(key('KeyD', { ctrlKey: true }), false), null);
  assertEquals(hostShortcut(key('KeyW', { ctrlKey: true }), false), null);
});

// ---- host tiles ------------------------------------------------------------------------------

const SLOT = '0123456789abcdef0123456789abcdef';

test('parseSlotLine: a rectangle or hidden, for a well-formed id only', () => {
  assertEquals(parseSlotLine(`devc-desktop:slot ${SLOT} 10 -20 300 200`), {
    id: SLOT,
    rect: { x: 10, y: -20, width: 300, height: 200 },
  });
  assertEquals(parseSlotLine(`devc-desktop:slot ${SLOT} hidden`), {
    id: SLOT,
    rect: null,
  });
  for (
    const bad of [
      `devc-desktop:slot ${SLOT.toUpperCase()} hidden`,
      `devc-desktop:slot ${SLOT.slice(1)} hidden`,
      `devc-desktop:slot ${SLOT}  10 20 300 200`,
      `devc-desktop:slot ${SLOT} 10 20 300 200 `,
      `devc-desktop:slot ${SLOT} 10 20 -300 200`,
      `devc-desktop:slot ${SLOT} 123456 20 300 200`,
      `devc-desktop:slot ${SLOT} 10 20 300`,
      `devc-desktop:slot ${SLOT} 1.5 20 300 200`,
      ` devc-desktop:slot ${SLOT} hidden`,
      `devc-desktop:slots ${SLOT} hidden`,
    ]
  ) assertEquals(parseSlotLine(bad), null, bad);
});

test('placeSlot: zoom, offset by the view, cut to it, and the 80×40 minimum', () => {
  const own = { x: 346, y: 32, width: 1000, height: 700 };
  assertEquals(placeSlot({ x: 10, y: 20, width: 300, height: 200 }, 1, own), {
    x: 356,
    y: 52,
    width: 300,
    height: 200,
  });
  assertEquals(placeSlot({ x: 10, y: 20, width: 300, height: 200 }, 1.5, own), {
    x: 361,
    y: 62,
    width: 450,
    height: 300,
  });
  // Past the view's edges: cut.
  assertEquals(placeSlot({ x: -50, y: 600, width: 300, height: 400 }, 1, own), {
    x: 346,
    y: 632,
    width: 250,
    height: 100,
  });
  // What is left is too small.
  assertEquals(
    placeSlot({ x: 950, y: 0, width: 300, height: 200 }, 1, own),
    null,
  );
  assertEquals(placeSlot({ x: 0, y: 0, width: 300, height: 39 }, 1, own), null);
  assertEquals(placeSlot({ x: 0, y: 0, width: 79, height: 300 }, 1, own), null);
  // A nonsense zoom counts as 1.
  assertEquals(
    placeSlot({ x: 0, y: 0, width: 100, height: 100 }, 0, own),
    { x: 346, y: 32, width: 100, height: 100 },
  );
});

test('ambiguousPress: a point newly covered or uncovered within 500 ms, either way', () => {
  const a = { x: 100, y: 100, width: 200, height: 200 };
  const b = { x: 400, y: 100, width: 200, height: 200 };
  const moved: CoverChange[] = [{ old: a, now: b, at: 1000 }];
  // Uncovered by the move, and newly covered.
  assertEquals(ambiguousPress(moved, { x: 150, y: 150 }, 1100), true);
  assertEquals(ambiguousPress(moved, { x: 450, y: 150 }, 1100), true);
  // Neither before nor after.
  assertEquals(ambiguousPress(moved, { x: 350, y: 150 }, 1100), false);
  // Too late.
  assertEquals(
    ambiguousPress(moved, { x: 450, y: 150 }, 1000 + COVER_MS + 1),
    false,
  );
  assertEquals(
    ambiguousPress(moved, { x: 450, y: 150 }, 1000 + COVER_MS),
    true,
  );
  // Covered before and after (a resize that keeps the point inside).
  const grown: CoverChange[] = [{
    old: a,
    now: { ...a, width: 300 },
    at: 1000,
  }];
  assertEquals(ambiguousPress(grown, { x: 150, y: 150 }, 1100), false);
  assertEquals(ambiguousPress(grown, { x: 350, y: 150 }, 1100), true);
  // Hidden and shown.
  const hidden: CoverChange[] = [{ old: a, now: null, at: 1000 }];
  assertEquals(ambiguousPress(hidden, { x: 150, y: 150 }, 1200), true);
  const shown: CoverChange[] = [{ old: null, now: a, at: 1000 }];
  assertEquals(ambiguousPress(shown, { x: 150, y: 150 }, 1200), true);
  assertEquals(ambiguousPress(shown, { x: 350, y: 150 }, 1200), false);
  // A later change extends it.
  const twice: CoverChange[] = [
    { old: null, now: a, at: 1000 },
    { old: a, now: null, at: 1400 },
  ];
  assertEquals(ambiguousPress(twice, { x: 150, y: 150 }, 1800), true);
});

test('recentChanges drops changes older than 500 ms', () => {
  const r = { x: 0, y: 0, width: 100, height: 100 };
  const changes: CoverChange[] = [
    { old: null, now: r, at: 100 },
    { old: r, now: null, at: 700 },
  ];
  assertEquals(recentChanges(changes, 1000), [changes[1]]);
  assertEquals(recentChanges(changes, 1300), []);
});

test('hostThemeOf: Same as Theme or a theme, green for anything else', () => {
  assertEquals(HOST_THEMES.map((c) => c.label), [
    'Same as Theme',
    'Slate',
    'Graphite',
    'Green',
    'Teal',
    'Blue',
    'Purple',
    'Amber',
    'Red',
  ]);
  assertEquals(hostThemeOf('blue').value, 'blue');
  assertEquals(hostThemeOf('none').value, 'none');
  assertEquals(hostThemeOf('pink').value, 'green');
  assertEquals(hostThemeOf(undefined).value, 'green');
  // The old host colors' saved values are the themes' names.
  for (const old of ['green', 'teal', 'blue', 'purple', 'amber', 'red']) {
    assertEquals(hostThemeOf(old).value, old);
  }
});

test("hostTheme: the choice, or devc web's theme for Same as Theme", () => {
  assertEquals(hostTheme(hostThemeOf('none'), themeNamed('teal')).name, 'teal');
  assertEquals(hostTheme(hostThemeOf('red'), themeNamed('teal')).name, 'red');
});

test("hostTerminalOptions: a container terminal's colors, and contrast in light mode", () => {
  const green = themeNamed('green');
  assertEquals(hostTerminalOptions(green, 'light'), {
    theme: terminalTheme(green, 'light'),
    minimumContrastRatio: 4.5,
  });
  assertEquals(hostTerminalOptions(green, 'dark'), {
    theme: { background: green.colors.termBg },
    minimumContrastRatio: 1,
  });
});

test('swatchBitmap: BGRA, opaque, an edge, and an inner square half the size', () => {
  const px = swatchBitmap(16, '#102030', { edge: '#405060', inner: '#708090' });
  assertEquals(px.length, 16 * 16 * 4);
  const at = (
    x: number,
    y: number,
  ) => [...px.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
  assertEquals(at(0, 0), [0x60, 0x50, 0x40, 255]); // the edge
  assertEquals(at(15, 7), [0x60, 0x50, 0x40, 255]);
  assertEquals(at(2, 2), [0x30, 0x20, 0x10, 255]); // the fill
  assertEquals(at(4, 4), [0x90, 0x80, 0x70, 255]); // the inner square, 4..11
  assertEquals(at(11, 11), [0x90, 0x80, 0x70, 255]);
  assertEquals(at(12, 12), [0x30, 0x20, 0x10, 255]);
  // No edge, no inner: all fill.
  const plain = swatchBitmap(4, '#ffffff');
  assertEquals([...plain], new Array(16).fill([255, 255, 255, 255]).flat());
});

test('swatchTone: same hue, brighter and more saturated; gray stays gray', () => {
  // The green host color (151°, 40%, 10%) → 151°, 60%, 45%.
  assertEquals(swatchTone('#10251b'), '#2fb776');
  assertEquals(swatchTone('#202020'), '#737373');
  assertEquals(swatchTone('#202020', 0.5), '#808080');
  // Hue kept: red stays red-dominant, blue blue-dominant.
  const [r, g, b] = [1, 3, 5].map((i) =>
    parseInt(swatchTone('#2b1517').slice(i, i + 2), 16)
  );
  assertEquals(r > g && r > b, true);
});
