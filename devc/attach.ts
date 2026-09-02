// The one half of the old `container.ts` that stays in the CLI: attaching an interactive shell.
// It touches raw TTY behavior — tmux, terminal titles, OSC background tints — none of which a
// programmatic library consumer (the pi extension `devc-core` exists for) has any use for. See
// `.plans/devc-core-npm-library.md`'s "the split follows the TTY" design decision.

import type {
  ContainerInfo,
  ContainerMount,
} from '@devc-tools/core/container.ts';
import { hostToContainerPath } from '@devc-tools/core/mount_paths.ts';
import { basenamePosix } from '@devc-tools/core/posix.ts';
import {
  DEVC_HERDR_WATCH_ENV,
  type HerdrAttachSpec,
  startHerdrSidecar,
} from './herdr.ts';

/**
 * Derives an attach session name from the container's workspace folder, e.g.
 * `/workspaces/some-tool` -> `some-tool`. `.` and `:` are replaced to keep
 * the name a safe single token (they also carry meaning in tmux's
 * `session:window.pane` target syntax when a host tmux window is renamed).
 */
export function sessionNameForWorkspaceFolder(
  remoteWorkspaceFolder: string,
): string {
  const name = basenamePosix(remoteWorkspaceFolder).replace(/[.:]/g, '_');
  return name || 'main';
}

// Solarized Dark — visually marks an attached container shell apart from local
// terminals for the duration of the attach.
const ATTACH_BG = '#002b36';
const ATTACH_FG = '#839496';

/**
 * Reports whether the terminal devc is running in is a genuine tmux client.
 *
 * `$TMUX` alone is not reliable: it is exported, so a child that merely
 * inherited it — e.g. a VS Code terminal launched via `code .` from a tmux
 * shell — looks like tmux even though it is not a tmux client. A real tmux
 * pane's `#{pane_tty}` equals the process's own controlling tty; an inherited
 * pointer resolves to the original pane, whose tty differs from the child's pty.
 */
async function hostIsTmux(): Promise<boolean> {
  if (!Deno.env.get('TMUX')) return false;
  const decode = (o: Deno.CommandOutput) =>
    o.code === 0 ? new TextDecoder().decode(o.stdout).trim() : '';
  const [paneTty, ownTty] = await Promise.all([
    new Deno.Command('tmux', {
      args: ['display-message', '-p', '#{pane_tty}'],
      stdout: 'piped',
      stderr: 'null',
    }).output().then(decode).catch(() => ''),
    new Deno.Command('tty', {
      stdin: 'inherit',
      stdout: 'piped',
      stderr: 'null',
    }).output().then(decode).catch(() => ''),
  ]);
  return paneTty !== '' && paneTty === ownTty;
}

/**
 * Tints the terminal for the lifetime of an attach so a container shell reads
 * as distinct from local terminals, and returns a function that undoes it.
 * Dispatches on environment because the effective lever differs:
 *
 * - Inside a local tmux, the terminal-level background is hidden by tmux's own
 *   per-cell rendering, so OSC 11 has no visible effect. We set the tmux
 *   `window-style`/`window-active-style` for the current window instead and
 *   unset them on detach (reverting to whatever global default was in place).
 * - Otherwise (VS Code integrated terminal, or a bare iTerm2 session) we set
 *   the terminal background/foreground directly via OSC 11/10 — honored by
 *   both xterm.js and iTerm2 — and reset via OSC 111/110 on detach.
 */
async function applyAttachColors(
  inTmux: boolean,
): Promise<() => Promise<void>> {
  if (inTmux) {
    const style = `bg=${ATTACH_BG},fg=${ATTACH_FG}`;
    const setStyle = (name: string, value?: string) =>
      new Deno.Command('tmux', {
        args: value === undefined
          ? ['set', '-uw', name]
          : ['set', '-w', name, value],
        stdout: 'null',
        stderr: 'null',
      }).output().catch(() => {});
    await setStyle('window-style', style);
    await setStyle('window-active-style', style);
    return async () => {
      await setStyle('window-style');
      await setStyle('window-active-style');
    };
  }
  const enc = new TextEncoder();
  await Deno.stdout.write(
    enc.encode(`\x1b]11;${ATTACH_BG}\x07\x1b]10;${ATTACH_FG}\x07`),
  );
  return async () => {
    await Deno.stdout.write(enc.encode(`\x1b]111\x07\x1b]110\x07`));
  };
}

export interface AttachOptions {
  sessionName?: string;
  /**
   * Keep attach/build output on screen by skipping the first-prompt clear
   * (i.e. don't set `DEVC_ATTACH=1`). Useful for reading postCreate/build
   * warnings that the clear would otherwise erase.
   */
  noClear?: boolean;
  /**
   * When set, run this command inside a login shell instead of dropping into an
   * interactive shell — the shortcut behind `devc claude`. The attach ends when
   * the command exits. The screen is cleared after login init (matching the
   * first-prompt clear a plain attach does) unless `noClear`.
   */
  command?: string;
  /**
   * Herdr sidecar integration (see `herdr.ts`) — absent when disabled. Computed by the caller
   * from `HERDR_ENV`/`HERDR_AGENT`/`DEVC_HERDR_AGENT` (`herdrMode`), so this module never reads
   * the environment itself and stays testable.
   */
  herdr?: HerdrAttachSpec;
  /**
   * Container-side working directory for the attach — a git worktree under a `.worktrees`
   * mount, typically. Defaults to `info.remoteWorkspaceFolder`.
   *
   * A **container** path only: no translation, no filesystem access, no mount lookup happens
   * here. A caller holding a host path resolves it first with {@link resolveAttachCwd},
   * which is where the one impure step lives — the same division `herdr` already follows.
   */
  cwd?: string;
}

/** What a `--cwd` value turned out to be, once checked against the container's mounts. */
export type AttachCwdResolution =
  /** Use this as `docker exec -w`. Either a translated host path or a pass-through. */
  | { kind: 'container'; containerPath: string }
  /** A host path no bind mount covers: the container cannot see it, so refuse. */
  | { kind: 'unmounted'; hostPath: string };

/**
 * Classifies a `--cwd` value, given the container's mount table and a way to ask whether the
 * path exists on the host. Pure — `existsOnHost` is a thunk the caller supplies, and it is
 * only consulted when the mount table did not already answer.
 *
 * **Precedence:** when a value is ambiguous — it exists on the host *and* would be a valid
 * container path — the host reading wins, because that is the one a user cannot express any
 * other way. A host path outside every mount is therefore refused rather than passed through
 * as a container path that merely looks similar.
 */
export function resolveAttachCwd(
  cwd: string,
  mounts: ContainerMount[] | null,
  existsOnHost: () => boolean,
): AttachCwdResolution {
  if (mounts !== null) {
    const containerPath = hostToContainerPath(cwd, mounts);
    if (containerPath !== null) return { kind: 'container', containerPath };
  }
  if (existsOnHost()) return { kind: 'unmounted', hostPath: cwd };
  return { kind: 'container', containerPath: cwd };
}

/**
 * The bind mounts a rejected `--cwd` host path was actually compared against, one
 * `source -> destination` line each, for an error message.
 *
 * Listing them rather than pointing at `devc mounts` is deliberate. The first real failure
 * of this flag was caused by the *sources themselves* being surprising — Docker Desktop
 * reported them as `/host_mnt/...` VM paths — and a message that named only the rejected
 * path gave no way to see that. The values are the diagnosis.
 *
 * Volumes are omitted: they have no host path a user could have meant, and including them
 * would pad the list with `/var/lib/docker/volumes/...` noise.
 */
export function describeBindMounts(mounts: ContainerMount[]): string {
  return mounts
    .filter((m) => m.type === 'bind')
    .map((m) => `  ${m.source} -> ${m.destination}`)
    .join('\n');
}

/**
 * The `docker exec` argv for an attach. Split out from {@link attachToContainer} — which is
 * otherwise all TTY and environment side effects — so the one part with a decision in it is
 * directly testable: `-w` is `cwd` when the caller gave one, and the container's own
 * workspace folder otherwise.
 */
export function attachExecArgs(
  info: Pick<
    ContainerInfo,
    'containerId' | 'remoteUser' | 'remoteWorkspaceFolder'
  >,
  envFlags: string[],
  shellArgs: string[],
  cwd?: string,
): string[] {
  return [
    'exec',
    '-it',
    ...envFlags,
    '-u',
    info.remoteUser,
    '-w',
    cwd ?? info.remoteWorkspaceFolder,
    info.containerId,
    ...shellArgs,
  ];
}

/**
 * Attaches an interactive `docker exec -it` login shell to the container (or,
 * with `options.command`, runs that command inside a login shell instead).
 * Resolves to the attached shell/command's exit code — mirrors
 * `execInContainer`'s contract. Throws only on infra failure (e.g. `docker`
 * isn't runnable at all), not on the shell/command's own non-zero exit.
 */
export async function attachToContainer(
  info: ContainerInfo,
  options: AttachOptions = {},
): Promise<number> {
  const {
    sessionName = sessionNameForWorkspaceFolder(info.remoteWorkspaceFolder),
    noClear = false,
    command,
    herdr,
    cwd,
  } = options;

  // A genuine tmux client (not a child that merely inherited $TMUX, e.g. a VS
  // Code terminal) drives both how we tint and whether the window-rename below
  // targets a real pane instead of retargeting the pane that spawned it.
  const inTmux = await hostIsTmux();

  // Set terminal title to project name. If running inside a host tmux session,
  // rename that window — it's what the host terminal actually displays, not any
  // title set from inside the container.
  if (inTmux) {
    await new Deno.Command('tmux', {
      args: ['rename-window', sessionName],
      stdout: 'null',
      stderr: 'null',
    }).output().catch(() => {});
  }
  await Deno.stdout.write(
    new TextEncoder().encode(`\x1b]0;${sessionName}\x07`),
  );

  // The login shell to run inside the container. Without `command`, an
  // interactive login shell (plain `devc attach`). With `command`, a login
  // shell that runs the command and exits when it does (e.g. `devc claude`).
  // `clear` wipes login-init clutter before the command runs, mirroring the
  // first-prompt clear a plain attach does via DEVC_ATTACH.
  const loginShell = (clear: boolean): string[] => {
    if (!command) return ['/bin/bash', '-l'];
    const inner = clear
      ? `clear; printf '\\033[3J'; exec ${command}`
      : `exec ${command}`;
    return ['/bin/bash', '-lc', inner];
  };

  const shellArgs = loginShell(!noClear);

  // `docker exec -t` hardcodes TERM=xterm and drops the rest of the host's terminal
  // identity, so keys negotiated against the outer terminal (extended keys like
  // shift+enter) break inside the container. Propagate the identity vars the app
  // keys off, each only when the host has it set:
  //   TERM                 — e.g. tmux-256color, so behavior matches the host
  //   TERM_PROGRAM         — e.g. vscode, so Claude interprets VS Code's shift+enter
  //                          sequence (which `/terminal-setup` makes VS Code emit)
  //   TERM_PROGRAM_VERSION — companion to TERM_PROGRAM
  // Placed before remoteEnv so explicit remoteEnv overrides still win.
  const termIdentityFlags = ['TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION']
    .flatMap((k) => {
      const v = Deno.env.get(k);
      return v ? ['-e', `${k}=${v}`] : [];
    });
  const baseEnvFlags = [
    ...termIdentityFlags,
    ...Object.entries(info.remoteEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
  ];

  // Claude only requests extended keys (shift+enter et al.) from the outer terminal
  // when it detects tmux via $TMUX, which `docker exec` drops — so a host-tmux user
  // loses shift+enter inside the container despite the correct TERM. Re-inject the
  // host $TMUX (only set when the host really is in tmux) so the container app sees it.
  const hostTmux = Deno.env.get('TMUX');
  const tmuxEnvFlags = hostTmux ? ['-e', `TMUX=${hostTmux}`] : [];

  // DEVC_ATTACH=1 arms the first-prompt clear in the devc:bashrc-additions fence
  // (features/devc-config/post-create.sh). Skip it when the caller asked to keep
  // output on screen (--no-clear), or when running a command (no interactive prompt
  // fires — the clear is baked into the command via loginShell()).
  const attachFlag = noClear || command ? [] : ['-e', 'DEVC_ATTACH=1'];

  // The marker the watcher greps `/proc/*/environ` for, so it can find *this* attach's shell
  // among every process in the container. Only in `watch` mode — `pinned` needs no watcher.
  const herdrWatchFlag = herdr?.mode === 'watch'
    ? ['-e', `${DEVC_HERDR_WATCH_ENV}=${herdr.watchId}`]
    : [];
  const envFlags = [
    ...baseEnvFlags,
    ...tmuxEnvFlags,
    ...attachFlag,
    ...herdrWatchFlag,
  ];

  // Two silent children beside the attach — a watcher and a sidecar, or just a pinned sidecar.
  // Seeded from `command` (`devc claude`) so the pane is correct immediately rather than a
  // second later. See `herdr.ts`.
  const herdrController = herdr
    ? startHerdrSidecar(info, herdr, command)
    : null;

  // Tint the terminal for the duration of the attach; reset on detach (including
  // on a non-zero exit or a thrown error via finally).
  const resetColors = await applyAttachColors(inTmux);
  try {
    const { code } = await new Deno.Command('docker', {
      args: attachExecArgs(info, envFlags, shellArgs, cwd),
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    }).spawn().status;

    return code;
  } finally {
    await resetColors();
    await herdrController?.stop();
  }
}
