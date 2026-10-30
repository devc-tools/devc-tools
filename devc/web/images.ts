// Images given to an agent from `devc web`: pasted or dropped on a pane tile, written into the
// pane's environment (`attach_image`), and their paths pasted into the pane for the agent to
// attach. See `.plans/devc-web-screenshots.md`. The writes are `EnvFiles.writeImage`.

import type { Environment } from './environment.ts';
import { FilesError } from './files.ts';

/** How an image reached the page; the first word of its file name. */
export const IMAGE_SOURCES = ['paste', 'drop'] as const;
export type ImageSource = typeof IMAGE_SOURCES[number];

/** The image types that can be attached. */
export const IMAGE_MIMES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;
export type ImageMime = typeof IMAGE_MIMES[number];

/** The largest image attached, in bytes. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** How long an attached image is kept: older ones are removed at the next attach. */
export const IMAGE_TTL_DAYS = 7;

/** The folder images go in, under the environment user's home. */
export function imageDir(home: string): string {
  return `${home.replace(/\/+$/, '')}/.cache/devc/images`;
}

/** Each type's extension. */
export const IMAGE_EXTENSIONS: Record<ImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** The names of attached images: only these are ever pruned. */
export const IMAGE_NAME =
  /^(paste|drop)-\d{8}-\d{6}-[0-9a-f]{6}\.(png|jpg|gif|webp)$/;

function ascii(bytes: Uint8Array, at: number, s: string): boolean {
  if (bytes.length < at + s.length) return false;
  for (let i = 0; i < s.length; i++) {
    if (bytes[at + i] !== s.charCodeAt(i)) return false;
  }
  return true;
}

/** The image type `bytes` start with, or null for anything else. */
export function imageType(bytes: Uint8Array): ImageMime | null {
  if (ascii(bytes, 0, '\x89PNG\r\n\x1a\n')) return 'image/png';
  if (ascii(bytes, 0, '\xff\xd8\xff')) return 'image/jpeg';
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) {
    return 'image/gif';
  }
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'image/webp';
  return null;
}

/** `<source>-<YYYYMMDD>-<HHMMSS>-<hex6>.<ext>`, in `now`'s local time. */
export function imageFileName(
  source: ImageSource,
  now: Date,
  ext: string,
): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const date = `${p(now.getFullYear(), 4)}${p(now.getMonth() + 1)}${
    p(now.getDate())
  }`;
  const time = `${p(now.getHours())}${p(now.getMinutes())}${
    p(now.getSeconds())
  }`;
  const hex = [...crypto.getRandomValues(new Uint8Array(3))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${source}-${date}-${time}-${hex}.${ext}`;
}

/** What {@link attachImage} writes with: an environment's home and files. */
export type ImageEnv = Pick<Environment, 'home' | 'files'>;

/**
 * Writes an `attach_image`'s image into `env`'s {@link imageDir}, as a new
 * {@link imageFileName}. Throws {@link FilesError} `bad_request` (not base64, or not the image
 * `mime` names) or `too_large`, the write's own errors, or an `Error` when there is no home.
 */
export async function attachImage(
  env: ImageEnv,
  msg: { source: ImageSource; mime: ImageMime; data: string },
  now = new Date(),
): Promise<{ path: string; size: number }> {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.fromBase64(msg.data);
  } catch {
    throw new FilesError('bad_request', 'not valid base64');
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new FilesError('too_large', 'images up to 20 MB can be attached');
  }
  if (imageType(bytes) !== msg.mime) {
    throw new FilesError('bad_request', 'not a PNG, JPEG, GIF or WebP image');
  }
  const home = await env.home();
  if (home === null) {
    throw new Error('the environment has no home folder to put the image in');
  }
  const dir = imageDir(home);
  const path = `${dir}/${
    imageFileName(msg.source, now, IMAGE_EXTENSIONS[msg.mime])
  }`;
  await env.files.writeImage(dir, path, bytes);
  return { path, size: bytes.length };
}
