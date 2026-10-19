import { test } from 'node:test';
import { deepStrictEqual as assertEquals } from 'node:assert/strict';
import {
  appArgs,
  clampDrawer,
  debugReason,
  devcMayNavigate,
  devcOrigin,
  devcPermission,
  DRAWER_MIN,
  externalUrl,
  fromView,
  layout,
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
