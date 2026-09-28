// Each tool's `deno task build:info`: records this checkout's `git describe` in the file named by
// the one argument (the tool's BUILD_INFO_FILE) for `deno task build` to embed, so the compiled
// binary's `--version` can say what it was built from (see version_info.ts). Always writes the
// file — `deno compile --include` fails on a missing one — with no `describe` when git cannot say.
//
//   deno run --allow-run=git --allow-read --allow-write=build_info.json \
//     ../version-info/write_build_info.ts build_info.json

import { gitDescribe } from './version_info.ts';

const [out] = Deno.args;
if (!out) {
  console.error('usage: write_build_info.ts <output file>');
  Deno.exit(2);
}
const describe = gitDescribe(import.meta.dirname!);
Deno.writeTextFileSync(
  out,
  JSON.stringify(describe ? { describe } : {}) + '\n',
);
