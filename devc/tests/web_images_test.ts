import { assert, assertEquals, assertRejects } from 'jsr:@std/assert';
import {
  attachImage,
  IMAGE_NAME,
  type ImageEnv,
  imageFileName,
  imageType,
  MAX_IMAGE_BYTES,
} from '../web/images.ts';
import { FilesError } from '../web/files.ts';
import type { EnvFiles } from '../web/environment.ts';

const bytes = (...xs: (number | string)[]) =>
  new Uint8Array(
    xs.flatMap((x) =>
      typeof x === 'number' ? [x] : [...x].map((c) => c.charCodeAt(0))
    ),
  );

const PNG = bytes(0x89, 'PNG\r\n', 0x1a, '\n', 'rest');
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 'rest');

Deno.test('imageType knows the four signatures and nothing else', () => {
  assertEquals(imageType(PNG), 'image/png');
  assertEquals(imageType(JPEG), 'image/jpeg');
  assertEquals(imageType(bytes('GIF87a;')), 'image/gif');
  assertEquals(imageType(bytes('GIF89a;')), 'image/gif');
  assertEquals(imageType(bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 ')), 'image/webp');
  assertEquals(imageType(bytes(0x89, 'PN')), null);
  assertEquals(imageType(bytes('BM', 0, 0, 0, 0, 0, 0)), null);
  assertEquals(imageType(bytes('RIFF', 0, 0, 0, 0, 'WAVEfmt ')), null);
  assertEquals(imageType(new Uint8Array()), null);
});

Deno.test('imageFileName is <source>-<local date>-<local time>-<hex6>.<ext>', () => {
  const name = imageFileName('paste', new Date(2026, 9, 29, 15, 4, 5), 'png');
  assert(/^paste-20261029-150405-[0-9a-f]{6}\.png$/.test(name), name);
  assert(IMAGE_NAME.test(name));
  const drop = imageFileName('drop', new Date(2026, 0, 2, 3, 4, 5), 'jpg');
  assert(/^drop-20260102-030405-[0-9a-f]{6}\.jpg$/.test(drop), drop);
  for (
    const other of [
      'paste-20261029-150405-a1b2c3.png.bak',
      'capture-20261029-150405-a1b2c3.png',
      'paste-20261029-150405-A1B2C3.png',
      'notes.png',
    ]
  ) {
    assert(!IMAGE_NAME.test(other), other);
  }
});

/** An environment whose home is `home` and whose `writeImage` records its calls. */
function fakeEnv(home: string | null) {
  const writes: { dir: string; file: string; bytes: Uint8Array }[] = [];
  const env: ImageEnv = {
    home: () => Promise.resolve(home),
    files: {
      writeImage: (dir: string, file: string, bytes: Uint8Array) => {
        writes.push({ dir, file, bytes });
        return Promise.resolve();
      },
    } as unknown as EnvFiles,
  };
  return { env, writes };
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

Deno.test('attachImage writes the image under ~/.cache/devc/images and answers its path', async () => {
  const { env, writes } = fakeEnv('/home/vscode');
  const r = await attachImage(env, {
    source: 'paste',
    mime: 'image/png',
    data: b64(PNG),
  }, new Date(2026, 9, 29, 15, 4, 5));
  assert(
    /^\/home\/vscode\/\.cache\/devc\/images\/paste-20261029-150405-[0-9a-f]{6}\.png$/
      .test(r.path),
    r.path,
  );
  assertEquals(r.size, PNG.length);
  assertEquals(writes, [{
    dir: '/home/vscode/.cache/devc/images',
    file: r.path,
    bytes: PNG,
  }]);
  const jpg = await attachImage(env, {
    source: 'drop',
    mime: 'image/jpeg',
    data: b64(JPEG),
  });
  assert(/\/drop-\d{8}-\d{6}-[0-9a-f]{6}\.jpg$/.test(jpg.path), jpg.path);
});

Deno.test('attachImage refuses bad base64, a mislabeled or unknown image, and a big one', async () => {
  const { env, writes } = fakeEnv('/home/vscode');
  const refused = async (
    msg: Parameters<typeof attachImage>[1],
    code: string,
  ) => {
    const err = await assertRejects(() => attachImage(env, msg), FilesError);
    assertEquals(err.code, code, JSON.stringify(msg).slice(0, 80));
  };
  await refused(
    { source: 'paste', mime: 'image/png', data: '%%%' },
    'bad_request',
  );
  await refused(
    { source: 'paste', mime: 'image/png', data: b64(JPEG) },
    'bad_request',
  );
  await refused(
    { source: 'paste', mime: 'image/png', data: b64(bytes('BM', 0, 0)) },
    'bad_request',
  );
  const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
  big.set(PNG);
  await refused(
    { source: 'drop', mime: 'image/png', data: big.toBase64() },
    'too_large',
  );
  assertEquals(writes, []);
});

Deno.test('attachImage needs a home folder', async () => {
  const { env, writes } = fakeEnv(null);
  const err = await assertRejects(() =>
    attachImage(env, { source: 'paste', mime: 'image/png', data: b64(PNG) })
  );
  assert(!(err instanceof FilesError));
  assertEquals(
    (err as Error).message,
    'the environment has no home folder to put the image in',
  );
  assertEquals(writes, []);
});
