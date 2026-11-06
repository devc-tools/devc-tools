// The host terminal's shell: which login shell the app's Herdr session runs (its server is
// started in it, and every pane gets it as `$SHELL`). The panes themselves are Herdr's
// (`herdr.ts`).

import { userInfo } from 'node:os';

/**
 * The shell the host terminal runs: `$SHELL`, else the account's login shell, else `/bin/zsh`
 * on macOS and `/bin/bash` elsewhere.
 */
export function hostShell(
  env: Record<string, string | undefined>,
  platform: string,
  accountShell: string | null,
): string {
  return env.SHELL || accountShell ||
    (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

/** The account's shell from the password database, or `null`. */
export function accountShell(): string | null {
  try {
    return userInfo().shell || null;
  } catch {
    return null;
  }
}
