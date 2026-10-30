// `devc web`'s environments: one project's place to run commands, and the sources that find them
// and start and stop them. A devcontainer (`containers.ts`) is one kind, a folder on this machine
// (`env_host.ts`) the other; everything that runs a command for a project — Herdr's bridge and
// controllers, the Files node, Past sessions, language servers, the page's PR review — goes
// through an {@link Environment}, so nothing outside those two modules knows which kind it has.
// See `.plans/devc-web-host-environments.md`.

import { createHash } from 'node:crypto';
import type { ContainerMount } from '@devc-tools/core/container.ts';
import type { BridgeCapability } from '@devc-tools/core/bridge.ts';
import type { ByteProc, LineProc } from './proc.ts';
import type { DirEntry } from './files.ts';

export type EnvironmentKind = 'container' | 'host';

/** The kinds in the order the `projects` message lists them. */
export const ENVIRONMENT_KINDS: readonly EnvironmentKind[] = [
  'container',
  'host',
];

/** One finished command, stdout as bytes. */
export interface ExecOutput {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}

/** A command to run in an environment. */
export interface EnvExec {
  /** argv, exec'd directly (no shell). */
  cmd: string[];
  /** Default: a container's `remoteWorkspaceFolder`, a host project's folder. */
  cwd?: string;
  /** On top of the environment's own. */
  env?: Record<string, string>;
  /** stdin piped (Herdr's JSON lines). */
  interactive?: boolean;
}

/** A one-shot run's limits (the PR review's bridge commands). */
export interface RunLimits {
  timeoutMs: number;
  maxOutput: number;
}

/** A bridge command's end: its exit, or why it was killed. */
export type BridgeRun =
  | { kind: 'exit'; code: number; stdout: string; stderr: string }
  | { kind: 'timeout' }
  | { kind: 'too_large' };

/** A live Claude process's session: which Herdr pane runs it. */
export interface RunningSession {
  session: string;
  /** Its `HERDR_SESSION`: the Herdr server its pane belongs to. */
  herdrSession: string;
  /** Its `HERDR_PANE_ID`. */
  paneId: string;
}

/**
 * An environment's own filesystem, for the Files node and the writes made as its user: paths are
 * absolute in the environment. Every method throws `FilesError` (`not_found`, `not_file` as
 * `bad_request`, `forbidden`, `exists`, `conflict`, `too_large`, `not_running`), or an `Error`.
 */
export interface EnvFiles {
  list(path: string): Promise<{ entries: DirEntry[]; truncated: boolean }>;
  read(path: string): Promise<{ text: string; size: number; hash: string }>;
  /** Up to one byte past `max`, which the caller refuses. */
  readBytes(path: string, max: number): Promise<Uint8Array>;
  create(path: string, kind: 'file' | 'dir'): Promise<{ path: string }>;
  /** `to` is in `from`'s folder. */
  rename(from: string, to: string): Promise<{ path: string }>;
  delete(path: string): Promise<Record<string, never>>;
  /** Writes `text` to `file`, making folder `dir` first. */
  write(dir: string, file: string, text: string): Promise<void>;
  /**
   * Writes an attached image's `bytes` to new file `file` in `dir` (`0600`; `dir` made `0700`),
   * then removes the images in `dir` older than `IMAGE_TTL_DAYS` (`images.ts`).
   */
  writeImage(dir: string, file: string, bytes: Uint8Array): Promise<void>;
  /** Saves in place; with `base`, the current bytes must still hash to it. */
  writeText(
    path: string,
    text: string,
    base: string | undefined,
  ): Promise<{ hash: string; size: number }>;
}

/** The page's PR review for one environment's repos. */
export interface PrBackend {
  /** The repo at host folder `root` as a pinned line (`target`, `grants`), or why there is none. */
  pin(
    root: string,
  ): Promise<
    { target: string; grants: BridgeCapability[] } | { problem: string }
  >;
  /** `<command> --repo <target> …args`, the built-in recipe, under `limits`. */
  run(
    command: string,
    target: string,
    args: string[],
    limits: RunLimits,
  ): Promise<BridgeRun>;
}

export interface Environment {
  /** The wire's `container`: a container's full Docker id, a host project's {@link hostEnvironmentId}. */
  readonly id: string;
  readonly kind: EnvironmentKind;
  readonly localFolder: string;
  /** The Herdr session devc web talks to there. */
  readonly herdrSession: string;
  /** Resolves how to reach it; again on Retry and before a server start. */
  prepare(): Promise<void>;
  /** Long-lived, lines on stdout (Herdr's bridge, a pane controller). */
  spawn(x: EnvExec): LineProc;
  /** Long-lived, raw bytes (a language server). */
  spawnBytes(x: EnvExec): ByteProc;
  /** One-shot, bytes out; with `input`, piped to stdin. */
  run(x: EnvExec, input?: Uint8Array): Promise<ExecOutput>;
  /** Started and left running (`herdr server`). */
  runDetached(x: EnvExec): Promise<ExecOutput>;
  /** One-shot, stdout kept up to `limits` (the PR review's bridge commands). */
  runLimited(x: EnvExec, limits: RunLimits): Promise<BridgeRun>;
  /** argv running `script` in a login shell, `args` as `$0`/`$@`. */
  loginShell(script: string, ...args: string[]): string[];
  /** Absolute, or `''` when there is none. */
  herdrPath(): Promise<string>;
  /** The user's `$HOME` there, or null. */
  home(): Promise<string | null>;
  /** The path map: a container's mount table; a host project's identity bind. */
  mounts(): Promise<ContainerMount[]>;
  /** Host folders `mountedRepos` looks for repos in, besides `localFolder`. */
  repoSources(): Promise<string[]>;
  files: EnvFiles;
  /** Live Claude processes: which session id runs in which Herdr pane. */
  runningAgents(): Promise<RunningSession[]>;
  /** Whether it still runs (a language server's crash told from its container stopping). */
  running(): Promise<boolean>;
  pr: PrBackend;
  caps: { stop: boolean; down: boolean; containerPaths: boolean };
}

/** What an {@link EnvironmentSource} tells the server. */
export interface DiscoveryHooks {
  /** An environment runs. */
  onAdd(env: Environment): void;
  /** A running one stopped or went away. */
  onRemove(id: string): void;
  /** The set of stopped ones changed: see {@link EnvironmentSource.stopped}. */
  onStoppedChange(): void;
  /** Something may have started environment `id`'s Herdr server (`devc herdr`, say). */
  onLaunch(id: string): void;
  onError(message: string): void;
}

export interface EnvironmentSource {
  readonly kind: EnvironmentKind;
  start(hooks: DiscoveryHooks): void;
  stop(): void;
  /** Lists again; throws when listing fails. */
  refresh(): Promise<void>;
  stopped(): ReadonlyMap<string, { id: string; localFolder: string }>;
  /** A stopped one's environment, for its mounts and repos (nothing is run in it). */
  environment(record: { id: string; localFolder: string }): Environment;
  startProject(
    localFolder: string,
    onLine: (line: string) => void,
  ): Promise<void>;
  /** `false` when it was not running. */
  stopProject(localFolder: string): Promise<boolean>;
  /** `false` when there was nothing to remove. */
  downProject?(localFolder: string): Promise<boolean>;
}

/** SHA-256 of the folder's UTF-8, lowercase hex. */
function folderHash(localFolder: string): string {
  return createHash('sha256').update(localFolder, 'utf8').digest('hex');
}

/** A host project's environment id: `host-` and 16 hex chars of its folder's hash. */
export function hostEnvironmentId(localFolder: string): string {
  return `host-${folderHash(localFolder).slice(0, 16)}`;
}

/** The longest slug a host session name carries. */
const SLUG_MAX = 24;

/**
 * A host project's own Herdr session: `<base>-<slug>-<hex8>`, the slug its folder's basename
 * lowercased with every run of other than `[a-z0-9]` made `-`, trimmed and cut to
 * {@link SLUG_MAX}; `<base>-<hex8>` when the slug is empty.
 */
export function hostSessionName(base: string, localFolder: string): string {
  const hex8 = folderHash(localFolder).slice(0, 8);
  const name = localFolder.replace(/\/+$/, '').split('/').pop() ?? '';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, SLUG_MAX).replace(/-+$/, '');
  return slug === '' ? `${base}-${hex8}` : `${base}-${slug}-${hex8}`;
}
