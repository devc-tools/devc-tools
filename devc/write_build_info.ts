// `deno task build:info`: records this checkout's `git describe` in BUILD_INFO_FILE for
// `deno task build` to embed, so the compiled binary's `--version` can say what it was built
// from (see version_info.ts). Always writes the file — `deno compile --include` fails on a
// missing one — with no `describe` when git cannot say.

import { BUILD_INFO_FILE, gitDescribe } from './version_info.ts';

const describe = gitDescribe(import.meta.dirname!);
Deno.writeTextFileSync(
  new URL(`./${BUILD_INFO_FILE}`, import.meta.url),
  JSON.stringify(describe ? { describe } : {}) + '\n',
);
