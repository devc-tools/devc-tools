import { test } from 'node:test';
import { deepStrictEqual as assertEquals } from 'node:assert/strict';
import {
  appArgs,
  cdTarget,
  clampDrawer,
  debugReason,
  devcMayNavigate,
  devcOrigin,
  devcPermission,
  devcToken,
  DRAWER_MIN,
  externalUrl,
  fromView,
  layout,
  MAX_LABEL,
  menuLabel,
  shellIdle,
  shellQuote,
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

test('layout: the drawer below devc web, never overlapping it', () => {
  assertEquals(layout(1200, 800, null), {
    main: { x: 0, y: 0, width: 1200, height: 800 },
    host: null,
  });
  const { main, host } = layout(1200, 800, 300);
  assertEquals(main, { x: 0, y: 0, width: 1200, height: 500 });
  assertEquals(host, { x: 0, y: 500, width: 1200, height: 300 });
  assertEquals(main.y + main.height, host!.y);
  assertEquals(layout(1200, 800, 5000).host!.height, 680);
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
