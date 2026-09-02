export interface AttachArgs {
  /** The path argument, if given. Callers should default to `Deno.cwd()` when absent. */
  target?: string;
  rebuild: boolean;
  /** When true, keep attach/build output on screen (skip the first-prompt clear). */
  noClear: boolean;
  /**
   * `--cwd` value exactly as written, unresolved: a container-absolute path, or a host path
   * that `main.ts` translates through the container's mount table. Absent when not given.
   */
  cwd?: string;
}

/**
 * Parses `devc attach` / `devc claude` / `devc copilot` / `devc pi` arguments.
 *
 * Unlike the other parsers here this one cannot use a plain
 * `args.find((a) => !a.startsWith('--'))` for the positional path: `--cwd` takes a value, and
 * a space-separated `--cwd /some/path` would otherwise make `/some/path` look like the
 * positional target and silently attach to the wrong project. Both spellings are accepted —
 * `--cwd <path>` and `--cwd=<path>` — because users will try both.
 */
export function parseAttachArgs(args: string[]): AttachArgs {
  const rebuild = args.includes('--build');
  const noClear = args.includes('--no-clear');

  let target: string | undefined;
  let cwd: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--cwd') {
      const value = args[i + 1];
      // A trailing `--cwd` with no value, or one followed by another flag, leaves `cwd`
      // unset rather than throwing — and must not swallow that flag.
      if (value !== undefined && !value.startsWith('--')) {
        if (value !== '') cwd = value;
        i++;
      }
      continue;
    }
    if (arg.startsWith('--cwd=')) {
      const value = arg.slice('--cwd='.length);
      if (value !== '') cwd = value;
      continue;
    }
    if (arg.startsWith('--')) continue;
    target ??= arg;
  }

  // The key is omitted rather than set to `undefined` when `--cwd` was not given, so the
  // result stays structurally identical to what this parser has always returned.
  return cwd === undefined
    ? { target, rebuild, noClear }
    : { target, rebuild, noClear, cwd };
}

export interface UpArgs {
  /** The path argument, if given. Callers should default to `Deno.cwd()` when absent. */
  target?: string;
  /**
   * Print the merged effective config and exit, starting nothing.
   *
   * The effective config is generated into `~/.cache/devc/projects/<key>/`, not the project, so
   * this is how you read what devc will actually run — before the first `up`, and without
   * hunting for a cache path.
   */
  printConfig: boolean;
  json: boolean;
}

/** Parses `devc up` arguments. */
export function parseUpArgs(args: string[]): UpArgs {
  const printConfig = args.includes('--print-config');
  const json = args.includes('--json');
  const target = args.find((a) => !a.startsWith('--'));
  return { target, printConfig, json };
}

export interface BuildArgs {
  /** The path argument, if given. Callers should default to `Deno.cwd()` when absent. */
  target?: string;
  /** Drop the Docker layer cache for the image build (`--build-no-cache`). */
  noCache: boolean;
  json: boolean;
}

/** Parses `devc build` arguments. */
export function parseBuildArgs(args: string[]): BuildArgs {
  const noCache = args.includes('--no-cache');
  const json = args.includes('--json');
  const target = args.find((a) => !a.startsWith('--'));
  return { target, noCache, json };
}
