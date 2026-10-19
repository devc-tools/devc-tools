// Global user configuration: the code/skills folder root lists at
// `${CONFIG_DIR}/config.json`. See `.plans/design/devc-design.md` →
// "Global user configuration" and "First-run flow".
//
// Two rules the tests pin down:
//
//   1. **Store raw, expand on read.** Entries persist exactly as the user typed them
//      (`~/code`, `$WORK/repos`); expansion happens only when a consumer asks for a
//      filesystem path via the `*Expanded()` accessors. Round-tripping never rewrites
//      `~` to an absolute path.
//   2. **Never drop user data.** Unknown top-level keys are kept in `extra` and written
//      back verbatim on save.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { CONFIG_DIR } from './default_config.ts';
import { isAlreadyExists, isNotFound } from './errors.ts';

/** Absolute path of the global config file. */
export const GLOBAL_CONFIG_PATH = `${CONFIG_DIR}/config.json`;

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
  /** Absolute path of the config file (whether or not it existed). */
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

/** True when the global config file exists. */
export async function globalConfigExists(
  path: string = GLOBAL_CONFIG_PATH,
): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

/**
 * Read the global config. A missing or invalid file is treated as empty lists (no crash) —
 * the first-run flow creates it, and lifecycle commands do not need roots. Unknown keys are
 * captured in `extra` and preserved on the next save.
 */
export async function loadGlobalConfig(
  path: string = GLOBAL_CONFIG_PATH,
): Promise<GlobalConfig> {
  let raw: Record<string, unknown> = {};
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    if (
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ) {
      raw = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or invalid: empty lists. First-run/`config` writes a fresh file.
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

/**
 * Write the global config as pretty JSON with a trailing newline, `codeRoots` and
 * `skillsRoots` first, then any preserved unknown keys. Creates parent dirs as needed.
 */
export async function saveGlobalConfig(cfg: GlobalConfig): Promise<void> {
  const dir = cfg.path.slice(0, Math.max(0, cfg.path.lastIndexOf('/')));
  if (dir !== '') {
    await mkdir(dir, { recursive: true }).catch((e) => {
      if (!isAlreadyExists(e)) throw e;
    });
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
