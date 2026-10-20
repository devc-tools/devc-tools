import { assertEquals } from 'jsr:@std/assert';
import { defaultView, fileView, mediaKind } from '../web/static/lib/media.js';

Deno.test('mediaKind: images and HTML by extension, any case', () => {
  for (
    const p of [
      'a.png',
      'b/c.JPG',
      'd.jpeg',
      'e.gif',
      'f.webp',
      'g.avif',
      'h.bmp',
      'favicon.ico',
      'icon.Svg',
    ]
  ) {
    assertEquals(mediaKind(p), 'image', p);
  }
  for (const p of ['index.html', 'a/b.HTM', '/srv/page.xhtml', '.html']) {
    assertEquals(mediaKind(p), 'html', p);
  }
  for (
    const p of ['notes.md', 'png', 'a.png.bak', 'a.xhtm', 'dir.html/x', 'a.ts']
  ) {
    assertEquals(mediaKind(p), null, p);
  }
});

Deno.test('defaultView: images other than SVG as media, the rest as text', () => {
  assertEquals(defaultView('a.png'), 'media');
  assertEquals(defaultView('a.GIF'), 'media');
  assertEquals(defaultView('a.svg'), 'text');
  assertEquals(defaultView('a.SVG'), 'text');
  assertEquals(defaultView('index.html'), 'text');
  assertEquals(defaultView('a.unknown'), 'text');
});

Deno.test('fileView: its own view, else the default; never media for other files', () => {
  assertEquals(fileView({ path: 'a.png' }), 'media');
  assertEquals(fileView({ path: 'a.png', view: 'text' }), 'text');
  assertEquals(fileView({ path: 'a.svg', view: 'media' }), 'media');
  assertEquals(fileView({ path: 'a.html', view: 'media' }), 'media');
  assertEquals(fileView({ path: 'a.ts', view: 'media' }), 'text');
});
