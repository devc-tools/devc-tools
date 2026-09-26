// The pure half of devc-bridge's per-container identity: where a workspace's key directory and
// policy file live, what the policy line looks like, and how the pin it carries is read out of a
// repo on the host.
//
// **Core writes nothing here.** `@devc-tools/core` is a lifecycle library, and a programmatic
// consumer must not acquire a devc-bridge integration by importing it — so creating
// `keys/<key>/`, writing `policy/<key>.conf` and removing either is the CLI's job
// (`devc/bridge.ts`). This module only computes paths, parses, serializes, and *reads* a repo.
//
// **Nothing here runs git.** devc runs on the host, and `git -C <repo> …` in an agent-writable repo
// fires `core.fsmonitor` — the exact payload git protection exists to disarm. `HEAD`, the
// `gitdir:` pointer and `remote.origin.url` are all read as files.

import { readFile, stat } from 'node:fs/promises';
import { isAbsolutePosix, resolvePosix } from './posix.ts';

/** devc-bridge's config tree, relative to `$HOME`. The bridge's own default base. */
export const BRIDGE_BASE_SUBPATH = '.config/devc-bridge';

/** Host paths devc and devc-bridge share for one workspace key. */
export interface BridgePaths {
  /** `~/.config/devc-bridge/keys/` — one subdirectory per workspace, never mounted whole. */
  keysDir: string;
  /** `~/.config/devc-bridge/keys/<key>/` — bind-mounted read-only at `/run/devc-bridge`. */
  keyDir: string;
  /** `~/.config/devc-bridge/keys/<key>/token` — minted by the bridge, never by devc. */
  tokenFile: string;
  /** `~/.config/devc-bridge/policy/` — host-only; no container mounts it. */
  policyDir: string;
  /** `~/.config/devc-bridge/policy/<key>.conf` — the one-line pin, written by devc. */
  policyFile: string;
}

/** Every path {@link BridgePaths} names, for `key` under `home`. */
export function bridgePaths(home: string, key: string): BridgePaths {
  const base = `${home}/${BRIDGE_BASE_SUBPATH}`;
  return {
    keysDir: `${base}/keys`,
    keyDir: `${base}/keys/${key}`,
    tokenFile: `${base}/keys/${key}/token`,
    policyDir: `${base}/policy`,
    policyFile: `${base}/policy/${key}.conf`,
  };
}

// ── the policy line ─────────────────────────────────────────────────────────────────────────

// ── capabilities ────────────────────────────────────────────────────────────────────────────

/**
 * Every devc-bridge capability a policy can grant, in canonical order. devc validates
 * `--bridge-allow` against this list and the bridge enforces it; nothing else defines it.
 */
export const BRIDGE_CAPABILITIES = [
  'git-push',
  'pr-review',
  'pr-resolve',
] as const;

/** One of {@link BRIDGE_CAPABILITIES}. */
export type BridgeCapability = typeof BRIDGE_CAPABILITIES[number];

/** The built-in bridge commands each capability enables. */
export const BRIDGE_CAPABILITY_COMMANDS: Readonly<
  Record<BridgeCapability, readonly string[]>
> = {
  'git-push': ['git-push', 'git-doctor'],
  'pr-review': ['pr-comments', 'pr-reply'],
  'pr-resolve': ['pr-resolve'],
};

/** Capabilities that are only granted alongside another — `pr-resolve` acts on `pr-comments`' ids. */
export const BRIDGE_CAPABILITY_REQUIRES: Readonly<
  Partial<Record<BridgeCapability, BridgeCapability>>
> = { 'pr-resolve': 'pr-review' };

/** The capability that enables built-in command `name`, or null when `name` is not a built-in. */
export function capabilityForCommand(name: string): BridgeCapability | null {
  for (const cap of BRIDGE_CAPABILITIES) {
    if (BRIDGE_CAPABILITY_COMMANDS[cap].includes(name)) return cap;
  }
  return null;
}

export function isBridgeCapability(name: string): name is BridgeCapability {
  return (BRIDGE_CAPABILITIES as readonly string[]).includes(name);
}

/**
 * Why `grants` is not a policy's grant list, or null when it is: non-empty, every name known, no
 * duplicates, canonical order, and every requirement present. One spelling per grant set.
 */
export function grantsProblem(grants: readonly string[]): string | null {
  if (grants.length === 0) return 'grants are empty';
  let last = -1;
  for (const g of grants) {
    const i = (BRIDGE_CAPABILITIES as readonly string[]).indexOf(g);
    if (i < 0) return `unknown capability ${JSON.stringify(g)}`;
    if (i <= last) return 'grants are duplicated or out of canonical order';
    last = i;
  }
  for (const g of grants as readonly BridgeCapability[]) {
    const needs = BRIDGE_CAPABILITY_REQUIRES[g];
    if (needs !== undefined && !grants.includes(needs)) {
      return `${g} requires ${needs}`;
    }
  }
  return null;
}

/** One container's publish pin: the one repo, remote and branch its capabilities act on. */
export interface Pin {
  /** Host path of the repo's working tree. */
  repo: string;
  /** `remote.origin.url`, as read from the repo's (frozen) config. */
  remote: string;
  /** The branch `HEAD` named, without `refs/heads/`. */
  branch: string;
}

/** A policy file: the pin, and the capabilities granted on it (canonical order, non-empty). */
export interface PolicyRecord extends Pin {
  grants: BridgeCapability[];
}

// A field may hold anything but the separator and line breaks; control characters are refused
// outright so a pin can never smuggle a second line or an invisible character into the file.
// deno-lint-ignore no-control-regex
const UNSAFE_FIELD = /[\u0000-\u001f\u007f]/;

/** Why `value` cannot be a policy field, or null when it can. */
function fieldProblem(name: string, value: string): string | null {
  if (value.length === 0) return `${name} is empty`;
  if (UNSAFE_FIELD.test(value)) {
    return `${name} contains a tab, newline or other control character`;
  }
  return null;
}

/**
 * The policy file's contents: `<repo>\t<remote>\t<branch>\t<grants>\n`, grants comma-joined in
 * canonical order. Throws for a field that could not be read back as itself, or a grant list
 * {@link grantsProblem} refuses — callers validate first, so reaching this is a bug.
 */
export function serializePolicy(record: PolicyRecord): string {
  for (const name of ['repo', 'remote', 'branch'] as const) {
    const problem = fieldProblem(name, record[name]);
    if (problem !== null) throw new Error(`policy ${problem}`);
  }
  const problem = grantsProblem(record.grants);
  if (problem !== null) throw new Error(`policy ${problem}`);
  return `${record.repo}\t${record.remote}\t${record.branch}\t${
    record.grants.join(',')
  }\n`;
}

/**
 * Parse a policy file. Exactly one non-empty line of exactly four non-empty fields, the last a
 * valid grant list, or `null` — a malformed policy grants nothing, and the reader must not guess.
 * A three-field file from before grants existed, and a capability this build does not know, are
 * both malformed: they fail closed.
 */
export function parsePolicy(text: string): PolicyRecord | null {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (body.includes('\n') || body.includes('\r')) return null;
  const fields = body.split('\t');
  if (fields.length !== 4) return null;
  const [repo, remote, branch, grantField] = fields;
  const pairs = [['repo', repo], ['remote', remote], ['branch', branch]];
  for (const [name, value] of pairs) {
    if (fieldProblem(name, value) !== null) return null;
  }
  if (fieldProblem('grants', grantField) !== null) return null;
  const grants = grantField.split(',');
  if (grantsProblem(grants) !== null) return null;
  return { repo, remote, branch, grants: grants as BridgeCapability[] };
}

// ── reading the pin out of a repo ───────────────────────────────────────────────────────────

/** What `.git/HEAD` names. */
export type HeadRef =
  | { kind: 'branch'; name: string }
  | { kind: 'detached' }
  | { kind: 'invalid' };

/**
 * Parse `.git/HEAD`: `ref: refs/heads/<name>` is a branch, a bare 40- or 64-hex object id is a
 * detached `HEAD`, anything else (a ref outside `refs/heads/`, garbage) is invalid.
 */
export function parseHead(text: string): HeadRef {
  const line = text.replace(/\r?\n$/, '');
  if (line.includes('\n')) return { kind: 'invalid' };
  const ref = /^ref: (.+)$/.exec(line);
  if (ref !== null) {
    const m = /^refs\/heads\/(.+)$/.exec(ref[1]);
    if (m === null) return { kind: 'invalid' };
    return fieldProblem('branch', m[1]) === null
      ? { kind: 'branch', name: m[1] }
      : { kind: 'invalid' };
  }
  if (/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(line)) return { kind: 'detached' };
  return { kind: 'invalid' };
}

/** The path a linked worktree's `.git` *file* points at (`gitdir: <path>`), or null. */
export function parseGitdirPointer(text: string): string | null {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  return m === null ? null : m[1];
}

/** `remote.origin.url` from a git config file's text, or why it could not be read unambiguously. */
export type OriginUrl = { ok: true; url: string } | {
  ok: false;
  reason: string;
};

/**
 * Read `remote.origin.url` out of a git config file, as git would, for the subset of the format a
 * repo config actually uses — and **refuse** anything outside that subset rather than guess.
 *
 * Refused, each with its reason: no `url`, more than one (git would push to the first but the pin
 * would be ambiguous), an `[include]`/`[includeIf]` section anywhere (the included file need not
 * be frozen), and a value continued onto the next line with a trailing backslash.
 *
 * Section names and keys are case-insensitive; the subsection (`"origin"`) is case-sensitive.
 * Values may be double-quoted, carry `\"`/`\\`/`\n`/`\t` escapes, and end in a `#` or `;` comment.
 */
export function parseOriginUrl(text: string): OriginUrl {
  let inOrigin = false;
  const urls: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/
        .exec(line);
      if (section === null) {
        return { ok: false, reason: `unreadable section header: ${line}` };
      }
      const name = section[1].toLowerCase();
      if (name === 'include' || name === 'includeif') {
        return {
          ok: false,
          reason: `the repo config has an [${
            section[1]
          }] section, and an included file need not be frozen`,
        };
      }
      inOrigin = name === 'remote' && section[2] === 'origin';
      // Git allows `[section] key = value` on one line; nothing a repo config writes does.
      if (line.slice(section[0].length).trim() !== '') {
        return { ok: false, reason: `unreadable config line: ${line}` };
      }
      continue;
    }
    if (!inOrigin) continue;
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (kv === null) {
      return { ok: false, reason: `unreadable config line: ${line}` };
    }
    if (kv[1].toLowerCase() !== 'url') continue;
    const value = parseConfigValue(kv[2] ?? '');
    if (value === null) {
      return {
        ok: false,
        reason: 'remote.origin.url is continued or unterminated',
      };
    }
    urls.push(value);
  }
  if (urls.length === 0) {
    return { ok: false, reason: 'the repo has no remote.origin.url' };
  }
  if (urls.length > 1) {
    return {
      ok: false,
      reason: `remote.origin.url is set ${urls.length} times`,
    };
  }
  const problem = fieldProblem('remote.origin.url', urls[0]);
  return problem === null
    ? { ok: true, url: urls[0] }
    : { ok: false, reason: problem };
}

/** A git config value: quotes removed, escapes applied, trailing comment dropped; null if continued. */
function parseConfigValue(raw: string): string | null {
  let out = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\') {
      const next = raw[i + 1];
      if (next === undefined) return null; // line continuation
      const escapes: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        n: '\n',
        t: '\t',
        b: '\b',
      };
      if (!(next in escapes)) return null;
      out += escapes[next];
      i++;
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (c === '#' || c === ';')) break;
    out += c;
  }
  if (quoted) return null;
  return out.trim();
}

/** The pin {@link resolvePin} derived, or the one reason it could not. */
export type PinResult =
  | { ok: true; record: Pin; worktree: boolean }
  | { ok: false; reason: string };

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function kindOf(path: string): Promise<'dir' | 'file' | 'none'> {
  try {
    const info = await stat(path);
    return info.isDirectory() ? 'dir' : 'file';
  } catch {
    return 'none';
  }
}

/**
 * Derive the publish pin for the repo whose working tree is `repo` (a host path): the branch
 * `HEAD` names, and `remote.origin.url`. Reads files only — see the module header.
 *
 * - `<repo>/.git` a directory → `HEAD` and `config` are read from it.
 * - `<repo>/.git` a file (a linked worktree) → follow `gitdir:` for `HEAD`, and that git dir's
 *   `commondir` for `config`, which is where a worktree's remotes live. `worktree: true` in the
 *   result, so the caller can name the case when protection is missing.
 * - A detached `HEAD`, or one naming a ref outside `refs/heads/` → fail closed.
 *
 * Whether the config it reads can be *trusted* is not decided here: that needs the container's
 * live mount table, and is the caller's job. A caller that has it should pass `configPath` — the
 * host source of the container's frozen `config` mount — so the remote comes from the file that is
 * actually frozen rather than from whatever the (writable) `commondir` file points at today.
 */
export async function resolvePin(
  repo: string,
  opts: { configPath?: string } = {},
): Promise<PinResult> {
  const dotGit = `${repo}/.git`;
  const kind = await kindOf(dotGit);
  if (kind === 'none') {
    return { ok: false, reason: `${repo} is not a git repository` };
  }

  let gitDir = dotGit;
  let commonDir = dotGit;
  if (kind === 'file') {
    const pointer = parseGitdirPointer(await readText(dotGit) ?? '');
    if (pointer === null) {
      return { ok: false, reason: `${dotGit} is a file with no gitdir: line` };
    }
    gitDir = isAbsolutePosix(pointer) ? pointer : resolvePosix(repo, pointer);
    const common = (await readText(`${gitDir}/commondir`))?.trim();
    commonDir = common === undefined || common === ''
      ? gitDir
      : isAbsolutePosix(common)
      ? common
      : resolvePosix(gitDir, common);
  }

  const headText = await readText(`${gitDir}/HEAD`);
  if (headText === null) {
    return { ok: false, reason: `cannot read ${gitDir}/HEAD` };
  }
  const head = parseHead(headText);
  if (head.kind === 'detached') {
    return {
      ok: false,
      reason: `HEAD is detached in ${repo} — check out the branch to publish`,
    };
  }
  if (head.kind === 'invalid') {
    return {
      ok: false,
      reason: `HEAD in ${repo} does not name a branch under refs/heads/`,
    };
  }

  const configPath = opts.configPath ?? `${commonDir}/config`;
  const configText = await readText(configPath);
  if (configText === null) {
    return { ok: false, reason: `cannot read ${configPath}` };
  }
  const origin = parseOriginUrl(configText);
  if (!origin.ok) return { ok: false, reason: origin.reason };

  const repoProblem = fieldProblem('repo path', repo);
  if (repoProblem !== null) return { ok: false, reason: repoProblem };

  return {
    ok: true,
    record: { repo, remote: origin.url, branch: head.name },
    worktree: kind === 'file',
  };
}
