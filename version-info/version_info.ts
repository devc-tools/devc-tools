// `--version` for builds that are not a release, shared by devc and both devc-bridge binaries,
// so a from-source run or a local `deno task build` says how far it is from the release it
// shares VERSION with:
//
//   devc 0.3.0                              release build (`build:release`, what install.sh ships)
//   devc 0.3.0+6.g0222e50.dirty (source)    `deno task run` / `devc2`: 6 commits past v0.3.0
//   devc 0.3.0+6.g0222e50 (local build)     `deno task build`, stamped when it was compiled
//
// The suffix is semver build metadata from `git describe`. Nothing rewrites VERSION: release.yml
// requires a release binary to print exactly `<tool> <tag>`, and a release build never embeds a
// build-info file, so it takes the plain branch in versionLine.

/** The file each tool's `deno task build:info` writes next to its entry point. Gitignored. */
export const BUILD_INFO_FILE = 'build_info.json';

/**
 * `git describe` for the checkout holding `dir`, or undefined when git or the repo is missing —
 * or when git may not be run: the devc-bridge client has no `--allow-run`, and asking would
 * make `deno run` prompt.
 */
export function gitDescribe(dir: string): string | undefined {
  if (
    Deno.permissions.querySync({ name: 'run', command: 'git' }).state !==
      'granted'
  ) {
    return undefined;
  }
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

/**
 * What `<tool> --version` prints. `buildInfo` is the tool's BUILD_INFO_FILE, resolved against
 * its own entry point's `import.meta.url` — where `deno compile --include` puts it.
 */
export function versionLine(
  tool: string,
  version: string,
  buildInfo: URL,
): string {
  if (Deno.build.standalone) {
    let describe: unknown;
    try {
      describe = JSON.parse(Deno.readTextFileSync(buildInfo))?.describe;
    } catch {
      // Not embedded: a release build.
      return `${tool} ${version}`;
    }
    const suffix = typeof describe === 'string'
      ? buildSuffix(describe, version)
      : '';
    return `${tool} ${version}${suffix} (local build)`;
  }
  const describe = gitDescribe(import.meta.dirname!);
  const suffix = describe ? buildSuffix(describe, version) : '';
  return `${tool} ${version}${suffix} (source)`;
}
