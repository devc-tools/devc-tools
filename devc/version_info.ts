// `devc --version`: VERSION plus, for a from-source run or a local `deno task build`, its
// `git describe` distance from the release — see ../version-info/version_info.ts.

import { VERSION } from './help.ts';
import {
  BUILD_INFO_FILE,
  versionLine as line,
} from '../version-info/version_info.ts';

/** What `devc --version` prints. */
export function versionLine(): string {
  return line(
    'devc',
    VERSION,
    new URL(`./${BUILD_INFO_FILE}`, import.meta.url),
  );
}
