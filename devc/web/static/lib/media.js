// Pure helpers for file tiles that show a file as media (an image, or an HTML page in a sandboxed
// frame) rather than as text, shared with the Deno tests (`devc/tests/web_media_test.ts`).

const IMAGE = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const HTML = /\.(?:html?|xhtml)$/i;

/**
 * What kind of media a file can be shown as, by its extension (any case): `null` for neither.
 *
 * @param {string} path
 * @returns {'image' | 'html' | null}
 */
export function mediaKind(path) {
  if (IMAGE.test(path)) return 'image';
  if (HTML.test(path)) return 'html';
  return null;
}

/**
 * How a file opens when nothing says otherwise: an image as media, except an SVG, which is
 * source people edit; anything else as text.
 *
 * @param {string} path
 * @returns {'text' | 'media'}
 */
export function defaultView(path) {
  return mediaKind(path) === 'image' && !/\.svg$/i.test(path)
    ? 'media'
    : 'text';
}

/**
 * How a file tile shows its file: its own `view`, else the default. A file that is no kind of
 * media is always text.
 *
 * @param {{path: string, view?: 'text' | 'media'}} file
 * @returns {'text' | 'media'}
 */
export function fileView(file) {
  if (mediaKind(file.path) === null) return 'text';
  return file.view ?? defaultView(file.path);
}
