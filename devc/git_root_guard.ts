// Guards against the devcontainer CLI's git-root walk-up mounting more than the user meant.
//
// With `--mount-workspace-git-root` (on by default; devc does not turn it off) the CLI mounts the
// nearest ancestor holding a `.git`, not the project folder. That is right for a subfolder of a
// monorepo, and a surprise for a fresh `~/code/new-project` nobody has `git init`ed yet: the
// container quietly gets whatever repo sits higher up — `~/code` itself, or `~` for a dotfiles
// repo. So before a container is *created* for such a folder, devc says so and asks.
//
// Only on create (or rebuild): mounts are bound at create time, so once the user has said yes the
// existing container is what they chose, and asking again on every attach would only nag.

import type { MergedConfig } from '@devc-tools/core/merged_config.ts';
import { findRepoRoot } from '@devc-tools/core/overlay.ts';
import { runConfirm } from './tui/prompts.ts';

/**
 * The ancestor repo the CLI will mount instead of `localFolder`, or null when it mounts
 * `localFolder` itself, mounts nothing git-derived, or the config decides the mount on its own
 * (`workspaceMount`, Docker Compose). Pure apart from `findRoot`.
 */
export async function ancestorRepoRoot(
  config: MergedConfig['config'],
  localFolder: string,
  findRoot: (folder: string) => Promise<string | null> = findRepoRoot,
): Promise<string | null> {
  if (config.workspaceMount !== undefined) return null;
  if (config.dockerComposeFile !== undefined) return null;
  const root = await findRoot(localFolder);
  return root === null || root === localFolder ? null : root;
}

/** The warning shown before the prompt. Pure. */
export function ancestorRepoWarning(localFolder: string, root: string): string {
  return `devc: ${localFolder} is not a git repo root — the devcontainer CLI will mount the ` +
    `enclosing repo ${root} instead.\n` +
    `  If this is a new project, run \`git init\` in it first so only it is mounted.`;
}

export interface GuardDeps {
  /** Whether a container for the folder already exists (any state). */
  containerExists: () => Promise<boolean>;
  /** null when there is no terminal to ask on — then the warning is printed and the start goes on. */
  confirm: ((question: string) => Promise<boolean>) | null;
  warn: (message: string) => void;
  findRoot?: (folder: string) => Promise<string | null>;
}

/**
 * Throws when the user declines. A no-op unless a container is about to be created (`rebuild`, or
 * none exists) for a folder whose mount would come from an ancestor repo.
 */
export async function guardAncestorRepoMount(
  merged: MergedConfig,
  localFolder: string,
  rebuild: boolean,
  deps: GuardDeps,
): Promise<void> {
  const root = await ancestorRepoRoot(
    merged.config,
    localFolder,
    deps.findRoot,
  );
  if (root === null) return;
  if (!rebuild && await deps.containerExists()) return;
  deps.warn(ancestorRepoWarning(localFolder, root));
  if (deps.confirm === null) return;
  if (!await deps.confirm(`Mount ${root} anyway?`)) {
    throw new Error('cancelled — no container started');
  }
}

/** {@link GuardDeps}`.confirm` for the real terminal, or null when stdin/stdout is not one. */
export function terminalConfirm(): GuardDeps['confirm'] {
  if (!Deno.stdin.isTerminal() || !Deno.stdout.isTerminal()) return null;
  return (question) =>
    runConfirm(question, false, {
      input: Deno.stdin.readable,
      output: Deno.stdout.writable,
      raw: true,
    });
}
