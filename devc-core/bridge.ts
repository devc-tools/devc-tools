// The pure half of devc-bridge's per-container identity: where a workspace's key directory and
// policy file live, what the policy lines look like, and how each pin they carry is read out of a
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
  /** `~/.config/devc-bridge/policy/<key>.conf` — one pin line per pinned repo, written by devc. */
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

// ── the policy lines ────────────────────────────────────────────────────────────────────────

// ── capabilities ────────────────────────────────────────────────────────────────────────────

/**
 * Every devc-bridge capability a policy can grant, in canonical order. devc validates
 * `--bridge-allow` against this list and the bridge enforces it; nothing else defines it.
 */
export const BRIDGE_CAPABILITIES = [
  'gh-push',
  'gh-pr-read',
  'gh-pr-reply',
  'gh-pr-viewed',
  'gh-pr-resolve',
  'gh-pr-resolve-copilot',
  'gh-pr-request-review',
] as const;

/** One of {@link BRIDGE_CAPABILITIES}. */
export type BridgeCapability = typeof BRIDGE_CAPABILITIES[number];

/**
 * The built-in bridge commands each capability enables. The bridge dispatches by file name, so
 * every name here is also the name of a script in `devc-bridge/builtin/`. A command may appear
 * under more than one capability and runs when **any** of them is granted: `gh-pr-resolve` is
 * both `gh-pr-resolve`'s (any thread) and `gh-pr-resolve-copilot`'s (Copilot's threads only), and
 * the script reads the policy's grants to pick the scope. Reads are `gh-pr-read`'s alone.
 */
export const BRIDGE_CAPABILITY_COMMANDS: Readonly<
  Record<BridgeCapability, readonly string[]>
> = {
  'gh-push': ['gh-push', 'gh-doctor'],
  'gh-pr-read': ['gh-pr-comments', 'gh-pr-files'],
  'gh-pr-reply': ['gh-pr-reply'],
  'gh-pr-viewed': ['gh-pr-viewed'],
  'gh-pr-resolve': ['gh-pr-resolve'],
  'gh-pr-resolve-copilot': ['gh-pr-resolve'],
  'gh-pr-request-review': ['gh-pr-request-review'],
};

/**
 * Capabilities that are only granted alongside another. Every PR write acts on what a read shows
 * — `gh-pr-viewed` marks paths `gh-pr-files` lists, the reply and resolve grants act on
 * `gh-pr-comments`' thread ids, and `gh-pr-request-review` asks for a review whose threads
 * `gh-pr-comments` lists — so each requires `gh-pr-read`.
 */
export const BRIDGE_CAPABILITY_REQUIRES: Readonly<
  Partial<Record<BridgeCapability, BridgeCapability>>
> = {
  'gh-pr-reply': 'gh-pr-read',
  'gh-pr-viewed': 'gh-pr-read',
  'gh-pr-resolve': 'gh-pr-read',
  'gh-pr-resolve-copilot': 'gh-pr-read',
  'gh-pr-request-review': 'gh-pr-read',
};

/**
 * Capability names that no longer exist, each with the reason given in place of
 * `unknown capability …` wherever a name is checked. `gh-pr-review` bundled the thread read with
 * replying; it was split rather than aliased so no grant keeps that bundle.
 */
export const RETIRED_CAPABILITIES: Readonly<Record<string, string>> = {
  'gh-pr-review':
    'gh-pr-review was split — grant gh-pr-read,gh-pr-reply instead',
};

/** Why `name` is a retired capability name, or null when it isn't one. */
export function retiredCapabilityReason(name: string): string | null {
  return Object.hasOwn(RETIRED_CAPABILITIES, name)
    ? RETIRED_CAPABILITIES[name]
    : null;
}

/**
 * Every capability that enables built-in command `name`, in canonical order — empty when `name`
 * is not a built-in. The bridge runs the command when the caller's policy grants any of them.
 */
export function capabilitiesForCommand(name: string): BridgeCapability[] {
  return BRIDGE_CAPABILITIES.filter((cap) =>
    BRIDGE_CAPABILITY_COMMANDS[cap].includes(name)
  );
}

/** Every built-in command name, once each, in the order the capabilities list them. */
export function builtinCommandNames(): string[] {
  return [
    ...new Set(
      BRIDGE_CAPABILITIES.flatMap((c) => BRIDGE_CAPABILITY_COMMANDS[c]),
    ),
  ];
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
    if (i < 0) {
      return retiredCapabilityReason(g) ??
        `unknown capability ${JSON.stringify(g)}`;
    }
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

/**
 * Whether `url` is a GitHub remote — exactly the shapes the bridge scripts' `parse_remote`
 * accepts, shape for shape, so devc refuses at grant time what `gh-push` would refuse at run time:
 *
 * - `git@<host>:<owner>/<name>[.git]`
 * - `ssh://git@<host>/<owner>/<name>[.git]`
 * - `https://<host>/<owner>/<name>[.git]`
 *
 * `<host>` is `github.com` or a `github.com-<alias>` ssh host alias, of `[A-Za-z0-9.-]` only;
 * `<owner>` and `<name>` are non-empty `[A-Za-z0-9._-]`, and neither is `.` or `..`.
 */
export function isGitHubRemote(url: string): boolean {
  return gitHubRepoOf(url) !== null;
}

/**
 * The owner/name a GitHub remote names, as `<owner>/<name>` with any `.git` dropped — the same
 * parse {@link isGitHubRemote} accepts, shape for shape — or null for anything else. Two remotes
 * name the same repo when these match case-insensitively, as GitHub's own names do.
 */
export function gitHubRepoOf(url: string): string | null {
  let host: string;
  let path: string;
  if (url.startsWith('git@') && url.includes(':')) {
    const rest = url.slice('git@'.length);
    host = rest.slice(0, rest.indexOf(':'));
    path = rest.slice(rest.indexOf(':') + 1);
  } else if (/^ssh:\/\/git@.*\//s.test(url)) {
    const rest = url.slice('ssh://git@'.length);
    host = rest.slice(0, rest.indexOf('/'));
    path = rest.slice(rest.indexOf('/') + 1);
  } else if (/^https:\/\/.*\//s.test(url)) {
    const rest = url.slice('https://'.length);
    host = rest.slice(0, rest.indexOf('/'));
    path = rest.slice(rest.indexOf('/') + 1);
  } else {
    return null;
  }
  if (host !== 'github.com' && !host.startsWith('github.com-')) return null;
  if (/[^A-Za-z0-9.-]/.test(host)) return null;
  if (path.endsWith('.git')) path = path.slice(0, -'.git'.length);
  const slash = path.indexOf('/');
  if (slash < 0) return null;
  const owner = path.slice(0, slash);
  const name = path.slice(slash + 1);
  return validRemoteName(owner) && validRemoteName(name)
    ? `${owner}/${name}`
    : null;
}

/** An owner or repo name: `[A-Za-z0-9._-]`, non-empty, and not `.` or `..`. */
function validRemoteName(name: string): boolean {
  return name !== '.' && name !== '..' && /^[A-Za-z0-9._-]+$/.test(name);
}

/** One repo's publish pin: the repo, remote and branch a container's capabilities act on there. */
export interface Pin {
  /** Host path of the repo's working tree. */
  repo: string;
  /** `remote.origin.url`, as read from the repo's (frozen) config. */
  remote: string;
  /** The branch `HEAD` named, without `refs/heads/`. */
  branch: string;
}

/** A pin and where the repo sits in the container — one policy line. */
export interface PinnedRepo extends Pin {
  /**
   * The repo's path in the container: what the bridge commands' `--repo <path>` selects by.
   * Normalized — see {@link targetProblem}.
   */
  target: string;
}

/** The most repos one policy pins: the workspace repo plus fifteen `--bridge-repo`s. */
export const MAX_PINNED_REPOS = 16;

/**
 * A policy file: the capabilities granted (canonical order, non-empty), shared by every pinned
 * repo, and the pinned repos — the workspace repo first when it could be pinned, then each
 * `--bridge-repo` that could, in the order it was given. 1–{@link MAX_PINNED_REPOS} of them, with
 * distinct `repo`s and distinct `target`s.
 */
export interface PolicyRecord {
  grants: BridgeCapability[];
  repos: PinnedRepo[];
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
 * Why `target` is not a policy line's container path, or null when it is: absolute, not `/`
 * itself, no trailing `/`, and no empty, `.` or `..` segment — one spelling per path, so the
 * bridge commands can select a line by plain string comparison. Assumes {@link fieldProblem}
 * already passed.
 */
export function targetProblem(target: string): string | null {
  if (!target.startsWith('/')) return 'target is not an absolute path';
  if (target === '/') return 'target is /';
  if (target.endsWith('/')) return 'target ends with /';
  for (const segment of target.slice(1).split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      return 'target has an empty, . or .. segment';
    }
  }
  return null;
}

/**
 * The policy file's contents: one `<repo>\t<remote>\t<branch>\t<grants>\t<target>\n` line per
 * pinned repo, grants comma-joined in canonical order and the same on every line. Throws for
 * anything {@link policyProblem} would refuse to read back — callers validate first, so reaching
 * this is a bug.
 */
export function serializePolicy(record: PolicyRecord): string {
  const grants = record.grants.join(',');
  const text = record.repos.map((r) =>
    `${r.repo}\t${r.remote}\t${r.branch}\t${grants}\t${r.target}\n`
  ).join('');
  const problem = record.repos.length === 0
    ? 'has no repos'
    : grantsProblem(record.grants) ?? policyProblem(text);
  if (problem !== null) throw new Error(`policy ${problem}`);
  return text;
}

/**
 * Why `text` is not a policy file, or null when it is: the **first** problem in the order
 * {@link parsePolicy} checks — the final newline, the line count, then per line (`line <n>: …`)
 * an empty line, the field count, each field, the target and the grant list, and last the
 * cross-line rules (grants identical to line 1's, `repo` and `target` each distinct).
 * {@link parsePolicy} is built on this, so the two never disagree. The bridge scripts' bash
 * parsers apply the same rules.
 */
export function policyProblem(text: string): string | null {
  if (!text.endsWith('\n')) return 'the file does not end with a newline';
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > MAX_PINNED_REPOS) {
    return `more than ${MAX_PINNED_REPOS} lines`;
  }
  const seenRepo = new Map<string, number>();
  const seenTarget = new Map<string, number>();
  let firstGrants = '';
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    if (lines[i] === '') return `line ${n} is empty`;
    const fields = lines[i].split('\t');
    if (fields.length !== 5) {
      return `line ${n}: want 5 tab-separated fields, found ${fields.length}`;
    }
    const [repo, remote, branch, grantField, target] = fields;
    const pairs = [
      ['repo', repo],
      ['remote', remote],
      ['branch', branch],
      ['grants', grantField],
      ['target', target],
    ];
    for (const [name, value] of pairs) {
      const problem = fieldProblem(name, value);
      if (problem !== null) return `line ${n}: ${problem}`;
    }
    const problem = targetProblem(target) ??
      grantsProblem(grantField.split(','));
    if (problem !== null) return `line ${n}: ${problem}`;
    if (i === 0) firstGrants = grantField;
    else if (grantField !== firstGrants) {
      return `line ${n}: grants differ from line 1's`;
    }
    const repoAt = seenRepo.get(repo);
    if (repoAt !== undefined) return `line ${n}: repo repeats line ${repoAt}'s`;
    const targetAt = seenTarget.get(target);
    if (targetAt !== undefined) {
      return `line ${n}: target repeats line ${targetAt}'s`;
    }
    seenRepo.set(repo, n);
    seenTarget.set(target, n);
  }
  return null;
}

/**
 * Parse a policy file: 1–{@link MAX_PINNED_REPOS} newline-terminated lines of exactly five
 * non-empty fields, or `null` — a malformed policy grants nothing, and the reader must not guess.
 * A four-field file from before targets existed, a three-field one from before grants existed,
 * and a capability this build does not know are all malformed: they fail closed.
 * {@link policyProblem} says why.
 */
export function parsePolicy(text: string): PolicyRecord | null {
  if (policyProblem(text) !== null) return null;
  const repos = text.slice(0, -1).split('\n').map((line) => {
    const [repo, remote, branch, , target] = line.split('\t');
    return { repo, remote, branch, target };
  });
  const grants = text.slice(0, text.indexOf('\n')).split('\t')[3]
    .split(',') as BridgeCapability[];
  return { grants, repos };
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

/** Why a pin is refused when {@link enablesWorktreeConfig} holds for its frozen config. */
export const WORKTREE_CONFIG_REASON =
  'its repo config enables extensions.worktreeConfig, so a per-worktree config.worktree could ' +
  'override the frozen config — unset it on the host to pin this repo';

/**
 * Whether a git config file's text turns on `extensions.worktreeConfig`. With it on, git also
 * reads `<git dir>/config.worktree` — for the primary worktree and every linked one — and that
 * file is not among the read-only mounts, so the frozen `config` would no longer be the whole
 * config. It cannot be switched on from inside a container (it lives in the frozen file), but a
 * user may already have it on.
 *
 * As git reads it: `[extensions]` with no subsection, key `worktreeConfig`, both case-insensitive;
 * the last occurrence wins; a bare key is `true`; only `false`/`no`/`off`/`0` (case-insensitive)
 * turn it off. **Fails closed**: a line inside `[extensions]` it cannot read, or a value it cannot
 * parse, counts as on — refusing a pin over an odd config is recoverable, trusting one is not.
 */
export function enablesWorktreeConfig(text: string): boolean {
  let inExtensions = false;
  let enabled = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      const section = /^\[\s*([A-Za-z0-9.-]+)(\s+"(?:[^"\\]|\\.)*")?\s*\]/
        .exec(line);
      inExtensions = section !== null &&
        section[1].toLowerCase() === 'extensions' && section[2] === undefined;
      if (inExtensions && line.slice(section![0].length).trim() !== '') {
        return true;
      }
      continue;
    }
    if (!inExtensions) continue;
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (kv === null) return true;
    if (kv[1].toLowerCase() !== 'worktreeconfig') continue;
    if (kv[2] === undefined) {
      enabled = true;
      continue;
    }
    const value = parseConfigValue(kv[2]);
    if (value === null) return true;
    enabled = !['false', 'no', 'off', '0'].includes(value.toLowerCase());
  }
  return enabled;
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
 * - A config that turns on `extensions.worktreeConfig` → fail closed with
 *   {@link WORKTREE_CONFIG_REASON}: git would also read an unfrozen `config.worktree`.
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
  if (enablesWorktreeConfig(configText)) {
    return { ok: false, reason: WORKTREE_CONFIG_REASON };
  }

  const repoProblem = fieldProblem('repo path', repo);
  if (repoProblem !== null) return { ok: false, reason: repoProblem };

  return {
    ok: true,
    record: { repo, remote: origin.url, branch: head.name },
    worktree: kind === 'file',
  };
}
