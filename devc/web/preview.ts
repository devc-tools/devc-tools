// "Open in browser" for `devc web`: an HTML file (repo or container) served to a browser tab at
// `/preview/<nonce>/<path>`, with the files beside it, so its relative CSS, images and scripts
// load. The nonce is minted per source (a repo root, or a container's filesystem) by
// `preview_file` / `preview_container_file`, and is the only credential: the tab has no token.
//
// The page in that tab is the file's own, scripts included, so every response carries CSP
// `sandbox` without `allow-same-origin`: the document gets an opaque origin, and can't read the
// devc web page's storage, reach its window or open `/ws` as it.

import { extname } from 'jsr:@std/path';
import { FilesError } from './files.ts';

/** The largest file one preview request serves. */
export const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;

/** The most previews remembered; minting one more forgets the oldest. */
export const MAX_PREVIEWS = 64;

/** Reads `path` (relative to a repo root, or absolute in a container) as at most `max` bytes. */
export type PreviewRead = (path: string, max: number) => Promise<Uint8Array>;

const PREVIEW_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

/** The `Content-Type` a preview serves `path` with: by extension, else bytes. */
export function previewType(path: string): string {
  return PREVIEW_TYPES[extname(path).toLowerCase()] ??
    'application/octet-stream';
}

/** Headers for every preview response, a 404 included. */
export function previewHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads',
  };
}

/** The URL path that previews `path` under `nonce`, each segment percent-encoded. */
export function previewPath(nonce: string, path: string): string {
  const segments = path.split('/').filter((s) => s !== '');
  return `/preview/${nonce}/${segments.map(encodeURIComponent).join('/')}`;
}

/**
 * `pathname` as `{nonce, path}` (`path` without a leading `/`, decoded) when it is a preview
 * request, else null. A `..` or `.` segment, an empty one or an undecodable one makes it null.
 */
export function parsePreviewPath(
  pathname: string,
): { nonce: string; path: string } | null {
  const m = /^\/preview\/([0-9a-f]{32,})\/(.+)$/.exec(pathname);
  if (!m) return null;
  let segments: string[];
  try {
    segments = m[2].split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
  if (
    segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('/'))
  ) {
    return null;
  }
  return { nonce: m[1], path: segments.join('/') };
}

function mintNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The server's previews: `mint(key, read)` names a source (the same `key` keeps its nonce) and
 * `serve(pathname)` answers a request for a path under `/preview/`.
 */
export function previews(max = MAX_PREVIEWS) {
  const byNonce = new Map<string, PreviewRead>();
  const byKey = new Map<string, string>();
  return {
    /** The nonce for source `key`, read with `read`; minted the first time. */
    mint(key: string, read: PreviewRead): string {
      const known = byKey.get(key);
      if (known !== undefined) {
        // Refreshed: the newest source is the last one forgotten.
        byKey.delete(key);
        byKey.set(key, known);
        byNonce.set(known, read);
        return known;
      }
      const nonce = mintNonce();
      byKey.set(key, nonce);
      byNonce.set(nonce, read);
      while (byKey.size > max) {
        const [oldKey, oldNonce] = byKey.entries().next().value!;
        byKey.delete(oldKey);
        byNonce.delete(oldNonce);
      }
      return nonce;
    },

    async serve(pathname: string, head = false): Promise<Response> {
      const parsed = parsePreviewPath(pathname);
      const read = parsed && byNonce.get(parsed.nonce);
      if (!parsed || !read) return notFound('no such preview');
      let bytes: Uint8Array;
      try {
        bytes = await read(parsed.path, MAX_PREVIEW_BYTES);
      } catch (e) {
        if (e instanceof FilesError && e.code === 'too_large') {
          return text(413, e.message);
        }
        if (e instanceof FilesError && e.code === 'forbidden') {
          return text(403, e.message);
        }
        return notFound(e instanceof FilesError ? e.message : 'not found');
      }
      if (bytes.length > MAX_PREVIEW_BYTES) {
        return text(413, `${parsed.path} is over ${MAX_PREVIEW_BYTES} bytes`);
      }
      // Deno's own reads are ArrayBuffer-backed; the lib type is wider than what they return.
      return new Response(head ? null : bytes as Uint8Array<ArrayBuffer>, {
        headers: {
          'Content-Type': previewType(parsed.path),
          ...previewHeaders(),
        },
      });
    },
  };
}

function text(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...previewHeaders(),
    },
  });
}

function notFound(message: string): Response {
  return text(404, message);
}
