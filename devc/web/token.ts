// `devc web`'s token, kept in `~/.config/devc/web-token` so the printed URL survives a restart
// (and, in live mode, every server swap). `--new-token` replaces it.

import { dirname } from 'jsr:@std/path';
import { CONFIG_DIR } from '@devc-tools/core/default_config.ts';
import { mintToken } from './server.ts';

export const WEB_TOKEN_PATH = `${CONFIG_DIR}/web-token`;

/** Whether `s` has the shape {@link mintToken} produces: 64 lowercase hex characters. */
export function tokenWellFormed(s: string | undefined): s is string {
  return s !== undefined && /^[0-9a-f]{64}$/.test(s);
}

/**
 * The token in `path`, or a fresh one written there (mode `0600`) when the file is missing,
 * unreadable or malformed, or `renew` is set.
 */
export async function loadToken(
  path: string,
  renew: boolean,
): Promise<string> {
  if (!renew) {
    try {
      const saved = (await Deno.readTextFile(path)).replace(/\n$/, '');
      if (tokenWellFormed(saved)) return saved;
    } catch { /* missing or unreadable: replaced below */ }
  }
  const token = mintToken();
  await Deno.mkdir(dirname(path), { recursive: true });
  // A temp file created 0600 and renamed over the old one: the token is never readable by
  // others, even for a moment, and a reader never sees half a token.
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await Deno.writeTextFile(tmp, `${token}\n`, { mode: 0o600 });
    await Deno.chmod(tmp, 0o600);
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
  return token;
}
