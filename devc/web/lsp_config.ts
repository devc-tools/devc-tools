// Per-project language server settings for `devc web`: `language-servers.json` in a repo's devc
// config directory (`~/.config/devc/repos/<name>-<hash>/`, the repo overlay's, shared by every
// worktree). Each entry names a language and a checkout-relative root, and carries the options
// passed to that language's launcher (`describe --root … --options <b64>`). Nothing is written
// into a repo or a container. See `.plans/devc-web-lsp-core.md` § Per-project settings.
//
// Parsing, matching and editing are pure; {@link LspConfigStore} reads, caches, writes and
// watches the files.

import { dirname } from 'jsr:@std/path';
import { CONFIG_DIR } from '@devc-tools/core/default_config.ts';
import { displayPath } from '@devc-tools/core/config.ts';
import { repoOverlayDir, resolveRepo } from '@devc-tools/core/repo.ts';
import { isLspLanguage, type LspLanguage } from './lsp_languages.ts';

/** The file's name in the repo's config directory. */
export const LANGUAGE_SERVERS_FILE = 'language-servers.json';

/** One project's settings. `root` is checkout-relative (`''` is the whole checkout). */
export interface LspProject {
  language: LspLanguage;
  root: string;
  options: Record<string, unknown>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A checkout-relative root with `/` separators, without empty or `.` segments (`.` and `''` are
 * both the whole checkout); null when it has a `..` segment or a leading `/`.
 */
export function normalizeRoot(root: string): string | null {
  if (root.startsWith('/')) return null;
  const parts = root.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) return null;
  return parts.join('/');
}

/**
 * The entries of a parsed `language-servers.json`. Each failure is told to `warn` once, with the
 * file's path: a file that isn't an object or has a `version` other than 1 is ignored whole; a
 * bad entry (unknown `language`, a `root` with `..` or a leading `/`, `options` not an object)
 * or a second entry for the same `language` and `root` is skipped.
 */
export function parseLanguageServers(
  data: unknown,
  path: string,
  warn: (line: string) => void = console.error,
): LspProject[] {
  const where = displayPath(path);
  if (!isObject(data)) {
    warn(`devc web: ${where}: not a JSON object; ignored`);
    return [];
  }
  if (data.version !== 1) {
    warn(`devc web: ${where}: "version" must be 1; ignored`);
    return [];
  }
  if (!Array.isArray(data.projects)) {
    warn(`devc web: ${where}: "projects" must be an array; ignored`);
    return [];
  }
  const out: LspProject[] = [];
  const seen = new Set<string>();
  data.projects.forEach((p, i) => {
    const skip = (why: string) =>
      warn(`devc web: ${where}: projects[${i}] ${why}; skipped`);
    if (!isObject(p)) return skip('is not an object');
    if (!isLspLanguage(p.language)) {
      return skip(`has an unknown "language" (${JSON.stringify(p.language)})`);
    }
    const root = typeof p.root === 'string' ? normalizeRoot(p.root) : null;
    if (root === null) {
      return skip(
        '"root" must be a checkout-relative path, with no ".." and no leading "/"',
      );
    }
    if (!isObject(p.options)) return skip('"options" must be an object');
    const key = `${p.language}\n${root}`;
    if (seen.has(key)) {
      return skip(`repeats language "${p.language}" and root "${root}"`);
    }
    seen.add(key);
    out.push({ language: p.language, root, options: p.options });
  });
  return out;
}

/** Whether checkout-relative `root` contains checkout-relative `path` (a path-segment prefix). */
export function rootContains(root: string, path: string): boolean {
  return root === '' || path === root || path.startsWith(`${root}/`);
}

/**
 * The entry for a file at checkout-relative `path` in `language`: among that language's
 * entries, the one whose `root` contains it, the longest `root` first. Null for none.
 */
export function matchProject(
  projects: readonly LspProject[],
  language: LspLanguage,
  path: string,
): LspProject | null {
  let best: LspProject | null = null;
  for (const p of projects) {
    if (p.language !== language || !rootContains(p.root, path)) continue;
    if (!best || p.root.length > best.root.length) best = p;
  }
  return best;
}

/**
 * `projects` with `language`'s entry at `entry.root` replaced (or added), or with `entry` null,
 * without the entry that matches the file at `path` now. Pure.
 */
export function withProject(
  projects: readonly LspProject[],
  language: LspLanguage,
  path: string,
  entry: { root: string; options: Record<string, unknown> } | null,
): LspProject[] {
  if (entry === null) {
    const current = matchProject(projects, language, path);
    return projects.filter((p) => p !== current);
  }
  const next = { language, root: entry.root, options: entry.options };
  const i = projects.findIndex((p) =>
    p.language === language && p.root === entry.root
  );
  return i === -1
    ? [...projects, next]
    : projects.map((p, j) => (j === i ? next : p));
}

/** JSON with every object's keys sorted, so equal options give equal text. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObject(v)) {
    return `{${
      Object.keys(v).sort().map((k) =>
        `${JSON.stringify(k)}:${canonicalJson(v[k])}`
      )
        .join(',')
    }}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** `options` for `--options`: base64 of its UTF-8 JSON. */
export function optionsArg(options: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(options));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * The flags a matched entry adds to `describe` and `serve`: `--root <checkout root in the
 * container>/<root> --options <b64>`. None without an entry: detection and the Feature's defaults.
 */
export function launcherFlags(
  project: LspProject | null,
  checkoutRoot: string,
): string[] {
  if (!project) return [];
  const base = checkoutRoot.replace(/\/+$/, '');
  const root = project.root === '' ? (base || '/') : `${base}/${project.root}`;
  return ['--root', root, '--options', optionsArg(project.options)];
}

/** Reads and parses one file: missing is no entries; unreadable or bad JSON is told to `warn`. */
export async function readLanguageServers(
  path: string,
  warn: (line: string) => void = console.error,
): Promise<LspProject[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      warn(
        `devc web: ${displayPath(path)}: ${e instanceof Error ? e.message : e}`,
      );
    }
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    warn(
      `devc web: ${displayPath(path)}: not valid JSON (${
        e instanceof Error ? e.message : e
      }); ignored`,
    );
    return [];
  }
  return parseLanguageServers(data, path, warn);
}

/**
 * Writes the file atomically (a temp file renamed over the old one in the same directory),
 * making the directory first.
 */
export async function writeLanguageServers(
  path: string,
  projects: readonly LspProject[],
): Promise<void> {
  const dir = dirname(path);
  await Deno.mkdir(dir, { recursive: true });
  const tmp = await Deno.makeTempFile({ dir, prefix: '.language-servers-' });
  try {
    const file = {
      version: 1,
      projects: projects.map(({ language, root, options }) => ({
        language,
        root,
        options,
      })),
    };
    await Deno.writeTextFile(tmp, JSON.stringify(file, null, 2) + '\n');
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}

/** A repo folder's settings file: where it is, and the checkout root it is relative to. */
export interface RepoSettings {
  /** The checkout's root on the host (`resolveRepo`'s `checkoutRoot`). */
  checkoutRoot: string;
  /** `<configDir>/repos/<repoKey>/language-servers.json`. */
  path: string;
  projects: LspProject[];
}

/** Watches one file: `watchConfigFile`'s shape (server.ts). */
export type WatchFile = (
  path: string,
  onChange: () => void,
) => { stop(): void };

/**
 * The settings files of the repos devc web has attached files in: read once each and cached,
 * re-read when one changes on disk (`onChange(path)` after), written atomically. A watch starts
 * once the repo's config directory exists (devc web makes it on the first save).
 */
export class LspConfigStore {
  #configDir: string;
  #watch: WatchFile | null;
  #onChange: (path: string) => void;
  #warn: (line: string) => void;
  #files = new Map<string, LspProject[]>();
  #watches = new Map<string, { stop(): void }>();

  constructor(opts: {
    configDir?: string;
    watch?: WatchFile | null;
    onChange?: (path: string) => void;
    warn?: (line: string) => void;
  } = {}) {
    this.#configDir = opts.configDir ?? CONFIG_DIR;
    this.#watch = opts.watch ?? null;
    this.#onChange = opts.onChange ?? (() => {});
    this.#warn = opts.warn ?? console.error;
  }

  /**
   * The settings of the repo `folder` (a host folder, the repo's root or inside it) is in; null
   * when it is in none or its git metadata can't be read.
   */
  async forFolder(folder: string): Promise<RepoSettings | null> {
    let repo;
    try {
      repo = await resolveRepo(folder);
    } catch {
      return null;
    }
    if (!repo) return null;
    const path = `${await repoOverlayDir(
      repo.commonDir,
      this.#configDir,
    )}/${LANGUAGE_SERVERS_FILE}`;
    return {
      checkoutRoot: repo.checkoutRoot,
      path,
      projects: await this.read(path),
    };
  }

  /** `path`'s entries, from the cache once read. */
  async read(path: string): Promise<LspProject[]> {
    const cached = this.#files.get(path);
    if (cached) return cached;
    const projects = await readLanguageServers(path, this.#warn);
    this.#files.set(path, projects);
    await this.#ensureWatch(path);
    return projects;
  }

  /** Writes `path`'s entries (atomically) and caches them; `onChange` follows. */
  async write(path: string, projects: LspProject[]): Promise<void> {
    await writeLanguageServers(path, projects);
    this.#files.set(path, projects);
    await this.#ensureWatch(path);
    this.#onChange(path);
  }

  /** Re-reads `path` (a watch saw it change) and tells `onChange`. */
  async reload(path: string): Promise<void> {
    this.#files.delete(path);
    await this.read(path);
    this.#onChange(path);
  }

  async #ensureWatch(path: string) {
    if (!this.#watch || this.#watches.has(path)) return;
    const dir = await Deno.stat(dirname(path)).catch(() => null);
    if (!dir?.isDirectory || this.#watches.has(path)) return;
    this.#watches.set(path, this.#watch(path, () => void this.reload(path)));
  }

  stop(): void {
    for (const w of this.#watches.values()) w.stop();
    this.#watches.clear();
  }
}
