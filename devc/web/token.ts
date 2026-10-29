// `devc web`'s token: minted afresh by every run (`mintToken`) and held in memory, so the URL
// printed by one run never works for another. In live mode the supervisor hands it to each
// server it starts through the environment, never argv. `--desktop-channel` adds a second one,
// devc-desktop's, printed only on stdout (`desktopLine`).

import { CONFIG_DIR } from '@devc-tools/core/default_config.ts';

/** Where earlier versions kept the token; removed on start, never read. */
export const LEGACY_TOKEN_PATH = `${CONFIG_DIR}/web-token`;

/** Whether `s` has the shape `mintToken` produces: 64 lowercase hex characters. */
export function tokenWellFormed(s: string | undefined): s is string {
  return s !== undefined && /^[0-9a-f]{64}$/.test(s);
}

/**
 * The line `devc web --desktop-channel` prints on stdout after its URL line: devc-desktop's own
 * token (`desktopToken` in `startWeb`). Only stdout carries it; devc-desktop reads it there.
 */
export function desktopLine(token: string): string {
  return `devc web: desktop ${token}`;
}

/**
 * The first line of `stream`, at most 128 characters, without its newline: how `--live-yolo`'s
 * supervisor hands its child the desktop token (stdin, never the environment, which host
 * projects inherit). `undefined` when the stream ends first or the line is longer.
 */
export async function readTokenLine(
  stream: ReadableStream<Uint8Array>,
): Promise<string | undefined> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  try {
    while (!buf.includes('\n') && buf.length <= 128) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const nl = buf.indexOf('\n');
  return nl >= 0 && nl <= 128 ? buf.slice(0, nl) : undefined;
}
