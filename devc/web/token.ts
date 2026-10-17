// `devc web`'s token: minted afresh by every run (`mintToken`) and held in memory, so the URL
// printed by one run never works for another. In live mode the supervisor hands it to each
// server it starts through the environment, never argv.

import { CONFIG_DIR } from '@devc-tools/core/default_config.ts';

/** Where earlier versions kept the token; removed on start, never read. */
export const LEGACY_TOKEN_PATH = `${CONFIG_DIR}/web-token`;

/** Whether `s` has the shape `mintToken` produces: 64 lowercase hex characters. */
export function tokenWellFormed(s: string | undefined): s is string {
  return s !== undefined && /^[0-9a-f]{64}$/.test(s);
}
