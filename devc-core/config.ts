// Global user configuration: the code/skills folder root lists at
// `${CONFIG_DIR}/config.jsonc` when that file exists, else `${CONFIG_DIR}/config.json` — one or
// the other, never merged. Both parse as JSONC (comments, trailing commas). Both sit in the same
// host-only folder, which no container mounts. See `.plans/design/devc-design.md` →
// "Global user configuration" and "First-run flow".
//
// Three rules the tests pin down:
//
//   1. **Store raw, expand on read.** Entries persist exactly as the user typed them
//      (`~/code`, `$WORK/repos`); expansion happens only when a consumer asks for a
//      filesystem path via the `*Expanded()` accessors. Round-tripping never rewrites
//      `~` to an absolute path.
//   2. **Never drop user data.** Unknown top-level keys are kept in `extra` and written
//      back verbatim on save.
//   3. **A `.jsonc` is never re-serialized.** A save splices only the arrays whose value
//      changed; every other byte — comments, formatting, unknown keys — stays as it was.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { CONFIG_DIR } from './default_config.ts';
import { isAlreadyExists, isNotFound } from './errors.ts';
import {
  elementIndent,
  ensureArray,
  findArraySpan,
  parseJsonc,
  replaceArrayElements,
  splitElements,
} from './jsonc_edit.ts';
import { logWarning } from './log.ts';

/** Absolute path of the plain global config file: the one the first-run flow creates. */
export const GLOBAL_CONFIG_PATH = `${CONFIG_DIR}/config.json`;

/** Absolute path of the JSONC global config file: used instead of `config.json` when it exists. */
export const GLOBAL_CONFIG_JSONC_PATH = `${CONFIG_DIR}/config.jsonc`;

/**
 * Both global config files, `config.jsonc` first: what a watch of the global config must react
 * to, since creating or deleting `config.jsonc` switches which one is read.
 */
export const GLOBAL_CONFIG_PATHS: readonly string[] = [
  GLOBAL_CONFIG_JSONC_PATH,
  GLOBAL_CONFIG_PATH,
];

/** Notices already printed this process (each prints at most once). */
const noticesShown = new Set<string>();

/** Print `message` to stderr unless the notice `key` was already printed by this process. */
function noticeOnce(key: string, message: string): void {
  if (noticesShown.has(key)) return;
  noticesShown.add(key);
  logWarning(message);
}

/** True when `path` exists (following symlinks). */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

/** A variable set to the empty string counts as unset. */
function envOrNull(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

/**
 * Expand a host path from the config: a leading `~` or `~/` (→ `$HOME`), and `$VAR` /
 * `${VAR}` anywhere. A `~` that is not the first character is a literal, exactly as in a
 * shell.
 *
 * An unset variable throws (naming the variable) rather than expanding to nothing: a typo
 * that silently became `/repos` would point at the wrong directory and report success.
 */
export function expandPath(value: string): string {
  const fail = (name: string): never => {
    throw new Error(`$${name} is not set`);
  };

  let out = value;
  if (out === '~' || out.startsWith('~/')) {
    out = (envOrNull('HOME') ?? fail('HOME')) + out.slice(1);
  }
  return out.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_, a, b) => {
      const name = a ?? b;
      return envOrNull(name) ?? fail(name);
    },
  );
}

/** Collapse `$HOME` → `~` so messages match what the user typed in their shell. */
export function displayPath(path: string): string {
  const home = process.env.HOME;
  if (home !== undefined && home !== '' && path.startsWith(home + '/')) {
    return '~' + path.slice(home.length);
  }
  return path;
}

/**
 * The loaded global config. `codeRoots` / `skillsRoots` are the **raw** lists (as stored);
 * the `*Expanded()` accessors apply `expandPath` to each entry (throwing on an unset var).
 */
export interface GlobalConfig {
  /** Raw code-folder roots, exactly as stored. */
  codeRoots: string[];
  /** Raw skills-folder roots, exactly as stored. */
  skillsRoots: string[];
  /** Raw remembered skills host paths from the last project configured, as stored. */
  recentSkills: string[];
  /** Unknown top-level keys, preserved so a rewrite never drops user data. */
  extra: Record<string, unknown>;
  /**
   * Absolute path of the config file actually read: `config.jsonc` or `config.json`, or the
   * `config.json` path when neither exists (so a save creates it).
   */
  path: string;
  /** `codeRoots` with `~` / `$VAR` expanded. */
  codeRootsExpanded(): string[];
  /** `skillsRoots` with `~` / `$VAR` expanded. */
  skillsRootsExpanded(): string[];
  /** `recentSkills` with `~` / `$VAR` expanded. */
  recentSkillsExpanded(): string[];
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function makeConfig(
  codeRoots: string[],
  skillsRoots: string[],
  recentSkills: string[],
  extra: Record<string, unknown>,
  path: string,
): GlobalConfig {
  return {
    codeRoots,
    skillsRoots,
    recentSkills,
    extra,
    path,
    codeRootsExpanded: () => codeRoots.map(expandPath),
    skillsRootsExpanded: () => skillsRoots.map(expandPath),
    recentSkillsExpanded: () => recentSkills.map(expandPath),
  };
}

/**
 * Which global config file is in use in `dir` (default `~/.config/devc`): `config.jsonc` when it
 * exists (anything `stat` follows, a symlink included), else `config.json` — whether or not that
 * exists. Decided on every call, so creating or deleting `config.jsonc` takes effect on the next
 * load. With both present, prints once per process that `config.json` is ignored.
 */
export async function resolveGlobalConfigPath(
  dir: string = CONFIG_DIR,
): Promise<string> {
  const jsonc = `${dir}/config.jsonc`;
  const json = `${dir}/config.json`;
  if (!(await exists(jsonc))) return json;
  if (await exists(json)) {
    noticeOnce(
      `ignored:${json}`,
      `devc: ${displayPath(json)} is ignored because ${
        displayPath(jsonc)
      } exists`,
    );
  }
  return jsonc;
}

/**
 * True when the global config exists: `path` when given, else either `config.jsonc` or
 * `config.json` in `dir`.
 */
export async function globalConfigExists(
  path?: string,
  dir: string = CONFIG_DIR,
): Promise<boolean> {
  if (path !== undefined) return await exists(path);
  return await exists(`${dir}/config.jsonc`) ||
    await exists(`${dir}/config.json`);
}

/** The parsed root object of `text`, or throws the reason it is not one. */
function parseConfigObject(text: string): Record<string, unknown> {
  const parsed = parseJsonc(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Read the global config: `path` when given (tests), else the file
 * {@link resolveGlobalConfigPath} picks. Either name parses as JSONC. A missing file is empty
 * lists, silently — the first-run flow creates it, and lifecycle commands do not need roots. A
 * file that exists but does not parse, or is not a JSON object, is empty lists too, with one
 * stderr notice per process: otherwise a typo would silently drop every key. Unknown keys are
 * captured in `extra` and preserved on the next save.
 */
export async function loadGlobalConfig(
  path?: string,
): Promise<GlobalConfig> {
  if (path === undefined) path = await resolveGlobalConfigPath();
  let raw: Record<string, unknown> = {};
  let text: string | null = null;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    // Missing (or unreadable): empty lists. First-run/`config` writes a fresh file.
  }
  if (text !== null) {
    try {
      raw = parseConfigObject(text);
    } catch (e) {
      noticeOnce(
        `invalid:${path}`,
        `devc: ${displayPath(path)}: not valid JSONC (${reason(e)}), ignored`,
      );
    }
  }

  const extra: Record<string, unknown> = {};
  let codeRoots: string[] = [];
  let skillsRoots: string[] = [];
  let recentSkills: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    switch (k) {
      case 'codeRoots':
        codeRoots = stringList(v);
        break;
      case 'skillsRoots':
        skillsRoots = stringList(v);
        break;
      case 'recentSkills':
        recentSkills = stringList(v);
        break;
      default:
        extra[k] = v;
    }
  }
  return makeConfig(codeRoots, skillsRoots, recentSkills, extra, path);
}

/** The array keys a save writes, in the order a fresh `config.json` lists them. */
const SAVED_ARRAYS = ['codeRoots', 'skillsRoots', 'recentSkills'] as const;

function sameStrings(a: unknown, b: readonly string[]): boolean {
  return Array.isArray(a) && a.length === b.length &&
    a.every((v, i) => v === b[i]);
}

/**
 * The text of an existing `.jsonc` with each of `codeRoots`, `skillsRoots` and `recentSkills`
 * whose value changed spliced in place, and nothing else touched (`extra` is already in the
 * file, byte for byte). A missing key is inserted as the first top-level key; a key whose value
 * is not an array is refused rather than duplicated.
 */
function spliceJsoncConfig(
  text: string,
  current: Record<string, unknown>,
  cfg: GlobalConfig,
): string {
  let out = text;
  for (const key of SAVED_ARRAYS) {
    const want = cfg[key];
    const have = current[key];
    if (sameStrings(have, want)) continue;
    // Absent and still empty: nothing changed (the load read it as `[]`).
    if (have === undefined && want.length === 0) continue;
    if (have !== undefined && !Array.isArray(have)) {
      throw new Error(
        `devc: ${
          displayPath(cfg.path)
        }: "${key}" is not an array, so it cannot be saved`,
      );
    }
    let span = findArraySpan(out, key);
    let indent: string;
    if (span === null) {
      out = ensureArray(out, key);
      span = findArraySpan(out, key);
      if (span === null) {
        throw new Error(`devc: could not locate the "${key}" array`);
      }
      indent = elementIndent(out, span);
    } else {
      // A one-line array (`["a"]`) has no element indent of its own to copy.
      const els = splitElements(out, span);
      const firstOnOwnLine = els.length > 0 &&
        /\n[ \t]*$/.test(out.slice(span.open, els[0].start));
      indent = els.length === 0 || firstOnOwnLine
        ? elementIndent(out, span)
        : elementIndent(out, { open: span.open, close: span.open + 1 });
    }
    out = replaceArrayElements(out, span, want, indent);
  }
  return out;
}

/**
 * Write the global config to `cfg.path`. Creates parent dirs as needed.
 *
 * - `config.json` (or any other name): pretty JSON with a trailing newline, `codeRoots`,
 *   `skillsRoots` and `recentSkills` first, then any preserved unknown keys.
 * - `config.jsonc`, when it exists: never re-serialized — only the arrays whose value changed
 *   are rewritten, between their brackets ({@link spliceJsoncConfig}); a save with nothing
 *   changed leaves the file byte-identical. One that no longer parses is refused rather than
 *   overwritten. A `.jsonc` that does not exist yet is written as pretty JSON.
 */
export async function saveGlobalConfig(cfg: GlobalConfig): Promise<void> {
  const dir = cfg.path.slice(0, Math.max(0, cfg.path.lastIndexOf('/')));
  if (dir !== '') {
    await mkdir(dir, { recursive: true }).catch((e) => {
      if (!isAlreadyExists(e)) throw e;
    });
  }
  if (cfg.path.endsWith('.jsonc')) {
    let text: string | null = null;
    try {
      text = await readFile(cfg.path, 'utf8');
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    if (text !== null) {
      let current: Record<string, unknown>;
      try {
        current = parseConfigObject(text);
      } catch (e) {
        throw new Error(
          `devc: ${displayPath(cfg.path)}: not valid JSONC (${
            reason(e)
          }), not saved`,
        );
      }
      const out = spliceJsoncConfig(text, current, cfg);
      if (out !== text) await writeFile(cfg.path, out);
      return;
    }
  }
  const out = {
    codeRoots: cfg.codeRoots,
    skillsRoots: cfg.skillsRoots,
    recentSkills: cfg.recentSkills,
    ...cfg.extra,
  };
  await writeFile(cfg.path, JSON.stringify(out, null, 2) + '\n');
}

/**
 * `webSource`: the `devc/` directory of a devc-tools checkout that `devc web --live` serves
 * when `--source` is not given (never without `--live`). Kept in `extra`, so every save preserves
 * it. Returns `null` when absent or empty; expands `~` / `$VAR` like the roots. Throws when it
 * is not a string, or not absolute once expanded.
 */
export function webSourceFromConfig(cfg: GlobalConfig): string | null {
  const raw = cfg.extra.webSource;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new Error(`${displayPath(cfg.path)}: "webSource" must be a string`);
  }
  const expanded = expandPath(raw);
  if (!expanded.startsWith('/')) {
    throw new Error(
      `${
        displayPath(cfg.path)
      }: "webSource" must be an absolute path (or start with ~), got '${raw}'`,
    );
  }
  return expanded;
}

/**
 * `bridgeDefaultAllow`: the devc-bridge capabilities `devc up` and `devc build` grant when
 * `--bridge-allow` is not given. Kept in `extra`, so every save — the wizard's included, which
 * has no UI for it — preserves it verbatim. Returned **raw** (`undefined` when absent): the CLI
 * validates it, and only when it is about to use it, so a bad value never breaks another command.
 * Read from this file only, never from a devc config layer: no container mounts `config.jsonc`
 * or `config.json`.
 */
export function bridgeDefaultAllowFromConfig(cfg: GlobalConfig): unknown {
  return cfg.extra.bridgeDefaultAllow;
}

/**
 * `bridgeRepoAllow`: per-repo default grants — an object mapping a host path of one checkout of a
 * repo to the capabilities `devc up` and `devc build` grant there (and on every other checkout of
 * that repo) when `--bridge-allow` is not given. Kept in `extra` and returned **raw**, exactly as
 * {@link bridgeDefaultAllowFromConfig}, for the same reasons.
 */
export function bridgeRepoAllowFromConfig(cfg: GlobalConfig): unknown {
  return cfg.extra.bridgeRepoAllow;
}

/** Construct a config value from explicit lists (used by tests and the wizard save path). */
export function makeGlobalConfig(
  codeRoots: string[],
  skillsRoots: string[],
  path: string = GLOBAL_CONFIG_PATH,
  extra: Record<string, unknown> = {},
  recentSkills: string[] = [],
): GlobalConfig {
  return makeConfig(
    [...codeRoots],
    [...skillsRoots],
    [...recentSkills],
    extra,
    path,
  );
}
