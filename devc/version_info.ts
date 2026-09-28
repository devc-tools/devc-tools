// `devc --version` for builds that are not a release, so a from-source run or a local
// `deno task build` says how far it is from the release it shares VERSION with:
//
//   devc 0.3.0                              release build (`build:release`, what install.sh ships)
//   devc 0.3.0+6.g0222e50.dirty (source)    `deno task run` / `devc2`: 6 commits past v0.3.0
//   devc 0.3.0+6.g0222e50 (local build)     `deno task build`, stamped when it was compiled
//
// The suffix is semver build metadata from `git describe`. Nothing rewrites VERSION: release.yml
// requires a release binary to print exactly `devc <tag>`, and a release build never embeds
// BUILD_INFO_FILE, so it takes the plain branch below.

import { VERSION } from './help.ts';

/**
 * Written next to this module by `deno task build:info` and embedded by `deno task build`'s
 * `--include`. Gitignored; `build:release` never includes it.
 */
export const BUILD_INFO_FILE = 'build_info.json';

/** `git describe` for the checkout holding `dir`, or undefined when git or the repo is missing. */
export function gitDescribe(dir: string): string | undefined {
  try {
    const out = new Deno.Command('git', {
      args: [
        '-C',
        dir,
        'describe',
        '--tags',
        '--long',
        '--dirty',
        '--always',
        '--match',
        'v[0-9]*',
      ],
      stdout: 'piped',
      stderr: 'null',
    }).outputSync();
    const text = new TextDecoder().decode(out.stdout).trim();
    return out.success && text ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The build-metadata suffix for a `git describe --tags --long --dirty --always` result, relative
 * to `version`: empty when the checkout is exactly the clean `v<version>` tag.
 *
 * - `v0.3.0-6-g0222e50-dirty` → `+6.g0222e50.dirty`
 * - `v0.2.2-4-gabc1234` with version 0.3.0 → `+gabc1234` (a count past a *different* tag, e.g.
 *   after bump-version.sh and before tagging, would read as distance from this version)
 * - `0222e50` (no matching tag, `--always`) → `+g0222e50`
 */
export function buildSuffix(describe: string, version: string): string {
  const tagged = /^v(.+)-(\d+)-g([0-9a-f]+)(-dirty)?$/.exec(describe);
  if (tagged) {
    const [, tag, count, sha, dirty] = tagged;
    const parts = tag === version
      ? count === '0' ? [] : [count, `g${sha}`]
      : [`g${sha}`];
    if (dirty) {
      parts.push('dirty');
    }
    return parts.length ? `+${parts.join('.')}` : '';
  }
  const bare = /^([0-9a-f]+)(-dirty)?$/.exec(describe);
  if (bare) {
    return `+g${bare[1]}${bare[2] ? '.dirty' : ''}`;
  }
  return '';
}

/** What `devc --version` prints. */
export function versionLine(): string {
  if (Deno.build.standalone) {
    let describe: unknown;
    try {
      const info = JSON.parse(
        Deno.readTextFileSync(new URL(`./${BUILD_INFO_FILE}`, import.meta.url)),
      );
      describe = info?.describe;
    } catch {
      // Not embedded: a release build.
      return `devc ${VERSION}`;
    }
    const suffix = typeof describe === 'string'
      ? buildSuffix(describe, VERSION)
      : '';
    return `devc ${VERSION}${suffix} (local build)`;
  }
  const describe = gitDescribe(import.meta.dirname!);
  const suffix = describe ? buildSuffix(describe, VERSION) : '';
  return `devc ${VERSION}${suffix} (source)`;
}
