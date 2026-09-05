import {
  attachToContainer,
  type ContainerMount,
  downContainer,
  execInContainer,
  getContainerMounts,
  getContainerStatus,
  rebuildContainer,
  resolveLocalFolder,
  sessionNameForWorkspaceFolder,
  startContainer,
  stopContainer,
} from './container.ts';
import { describeBindMounts, resolveAttachCwd } from './attach.ts';
import { parseAttachArgs, parseBuildArgs, parseUpArgs } from './args.ts';
import {
  DEVCONTAINER_SUBCOMMAND,
  runEmbeddedDevcontainerCli,
} from './devcontainer_selfexec.ts';
import {
  HERDR_SIDECAR_SUBCOMMAND,
  type HerdrAttachSpec,
  herdrMode,
  runHerdrSidecarBody,
} from './herdr.ts';
import { ensureMergedConfig } from '@devc-tools/core/merged_config.ts';
import { initProject } from '@devc-tools/core/init.ts';
import {
  globalConfigExists,
  runGlobalConfigWizard,
  runProjectConfigWizard,
} from './tui/config_flow.ts';
import {
  COMMAND_HELP,
  COMMANDS,
  helpRequested,
  topLevelHelp,
  VERSION,
} from './help.ts';

const subcommand = Deno.args[0];
const KNOWN_COMMANDS = new Set(COMMANDS.map((c) => c.name));

// devc re-execs itself with this hidden subcommand to run the embedded devcontainer CLI (see
// `devcontainer_cli.ts`). First thing dispatched, ahead of `--version` and `--help`: from here on
// the process belongs to the CLI, and its argv is the CLI's, not devc's. Never returns.
if (subcommand === DEVCONTAINER_SUBCOMMAND) {
  await runEmbeddedDevcontainerCli(Deno.args.slice(1));
}

// devc self-execs with this hidden subcommand for the Herdr sidecar's disposable child (see
// `herdr.ts`). Dispatched immediately after `__devcontainer`, ahead of `--version`/`--help`: from
// here on the process belongs to the sidecar body, not devc. Never returns.
if (subcommand === HERDR_SIDECAR_SUBCOMMAND) {
  await runHerdrSidecarBody();
}

/** Prints a `devc:`-prefixed error to stderr and exits 1 (never returns). */
function fail(e: unknown): never {
  console.error(`devc: ${e instanceof Error ? e.message : e}`);
  Deno.exit(1);
}

/**
 * Turns a `--cwd` value into the container path `attachToContainer` wants. A host path is
 * translated through the container's own mount table; anything else passes through as a
 * container path. The decision itself is `resolveAttachCwd`'s — this only supplies the two
 * impure inputs it needs.
 *
 * A host path that no bind mount covers is fatal *before* the attach: the container cannot
 * see that directory, and attaching to a same-looking container path instead would be worse
 * than refusing. A container path that does not exist in the container is not checked here —
 * `docker exec` already reports a bad `-w` well, and a stat would cost a second round trip.
 */
async function resolveCwdArg(target: string, cwd: string): Promise<string> {
  // `null` when no container matches — startContainer just succeeded, so in practice this is
  // only a race. Treat it as "no table to translate against" and pass the value through.
  const mounts: ContainerMount[] | null = await getContainerMounts(target)
    .catch(() => null);
  const resolved = resolveAttachCwd(cwd, mounts, () => {
    try {
      Deno.statSync(cwd);
      return true;
    } catch {
      return false;
    }
  });
  if (resolved.kind === 'unmounted') {
    // Two different failures, and conflating them is what made the first real one hard to
    // diagnose: "we looked and it is not there" is not "we could not look".
    if (mounts === null) {
      fail(
        `--cwd ${resolved.hostPath} looks like a host path, but this container's mount ` +
          `table could not be read, so it cannot be translated. Check \`devc status\` and ` +
          `\`devc mounts\`, or pass the container-side path instead.`,
      );
    }
    const bindMounts = describeBindMounts(mounts);
    fail(
      `--cwd ${resolved.hostPath} is a host path, but no bind mount of this container ` +
        `covers it, so the container cannot see it.\n\n` +
        (bindMounts
          ? `Bind mounts checked (host source -> container path):\n${bindMounts}\n\n`
          : `This container has no bind mounts.\n\n`) +
        `Add a mount for it with \`devc config\`, or pass the container-side path instead.`,
    );
  }
  return resolved.containerPath;
}

/**
 * Shared `devc attach` / `devc claude` / `devc copilot` / `devc pi` / `devc herdr` flow: start
 * (or rebuild) the container for `target`, then attach. When `command` is given (`devc claude`/
 * `devc copilot`/`devc pi`/`devc herdr`), it runs inside a login shell instead of dropping into
 * an interactive shell.
 */
async function attach(rawArgs: string[], command?: string): Promise<void> {
  const { target: rawTarget, rebuild, noClear, cwd: rawCwd } = parseAttachArgs(
    rawArgs,
  );
  const target = resolveLocalFolder(rawTarget);
  const what = command ? `${target} and running \`${command}\`` : `${target}`;
  console.log(
    rebuild
      ? `Rebuilding and attaching to ${what}...`
      : `Attaching to ${what}...`,
  );
  const info = await startContainer(target, rebuild).catch(fail);

  // `--cwd` takes a container path or a host path. Translation needs the container's live
  // mount table, so it happens here — `attach.ts` takes a container path and stays free of
  // I/O, the same division `herdr` below already follows.
  const cwd = rawCwd === undefined
    ? undefined
    : await resolveCwdArg(target, rawCwd);

  // Derive session name from the git root of the local folder so it matches
  // $PROJECT_PATH basename in the container, even when devc is run on a subfolder.
  const gitRootResult = await new Deno.Command('git', {
    args: ['-C', target, 'rev-parse', '--show-toplevel'],
    stdout: 'piped',
    stderr: 'null',
  }).output();
  const projectRoot = gitRootResult.code === 0
    ? new TextDecoder().decode(gitRootResult.stdout).trim()
    : target;
  const sessionName = sessionNameForWorkspaceFolder(projectRoot);

  // Decided from environment alone — see `herdrMode`'s doc comment. `attachToContainer` takes
  // the resolved spec rather than reaching into the environment itself, so it stays testable.
  const mode = herdrMode((k) => Deno.env.get(k));
  const herdr: HerdrAttachSpec | undefined = mode.mode === 'off'
    ? undefined
    : mode.mode === 'pinned'
    ? { mode: 'pinned', kind: mode.kind }
    : { mode: 'watch', watchId: crypto.randomUUID() };

  try {
    const code = await attachToContainer(info, {
      noClear,
      sessionName,
      command,
      herdr,
      cwd,
    });
    Deno.exit(code);
  } catch (e) {
    console.error(`devc: ${e instanceof Error ? e.message : e}`);
    Deno.exit(125); // reserved: devc/docker infra failure (matches `exec`)
  }
}

// Help / version / unknown-command dispatch. Runs before the first-run global-config hook and
// before any folder resolution or Docker call, so `devc up --help` (etc.) prints help and exits
// without launching the wizard or requiring Docker.
if (subcommand === '-V' || subcommand === '--version') {
  console.log(`devc ${VERSION}`);
  Deno.exit(0);
}
if (
  subcommand === undefined || subcommand === '-h' || subcommand === '--help'
) {
  console.log(topLevelHelp());
  Deno.exit(0);
}
if (
  KNOWN_COMMANDS.has(subcommand) &&
  helpRequested(subcommand, Deno.args.slice(1))
) {
  console.log(COMMAND_HELP[subcommand]);
  Deno.exit(0);
}
if (!KNOWN_COMMANDS.has(subcommand)) {
  console.error(`devc: unknown command '${subcommand}'`);
  console.error('Run "devc --help" for a list of commands.');
  Deno.exit(1);
}

// `devc init [PATH]`: write the bundled default `.devcontainer/` into PATH (default cwd) and
// exit. Like `config`, dispatched before the first-run global-config hook below — scaffolding
// needs no folder roots, so it must never trigger that wizard.
if (subcommand === 'init') {
  const target = resolveLocalFolder(
    Deno.args.find((a, i) => i > 0 && !a.startsWith('--')),
  );
  const { written } = await initProject(target).catch(fail);
  console.log(`Wrote .devcontainer/ for ${target}`);
  for (const path of written) {
    const rel = path.slice(`${target}/.devcontainer/`.length);
    console.log(`  ${rel}${path.endsWith('/scripts') ? '/' : ''}`);
  }
  console.log(
    'Next: `devc up` to create the container, or `devc config` to add source/skills mounts.',
  );
  Deno.exit(0);
}

// `devc config [PATH]`: open the full four-step project wizard for PATH (default cwd). The
// Global config step is prepended (as the first step) when the global config is missing and
// stdin is a TTY, so the very first run configures roots then continues into the project steps.
if (subcommand === 'config') {
  // `--global` reconfigures the code/skills roots only (free-mode folder picker), then exits.
  if (Deno.args.includes('--global')) {
    await runGlobalConfigWizard({ err: (m) => console.error(m) });
    Deno.exit(0);
  }
  const target = resolveLocalFolder(
    Deno.args.find((a, i) => i > 0 && !a.startsWith('--')),
  );
  const includeGlobalStep = !(await globalConfigExists()) &&
    Deno.stdin.isTerminal();
  await runProjectConfigWizard(
    target,
    { err: (m) => console.error(m) },
    includeGlobalStep,
  );
  Deno.exit(0);
}

// First-run hook: before dispatching any other command, if the global config does not exist
// and stdin is a TTY, run the global-config wizard and then continue. Not a TTY ⇒ skip
// silently (lifecycle commands do not need roots), so a scripted `devc up` never blocks.
if (!(await globalConfigExists()) && Deno.stdin.isTerminal()) {
  await runGlobalConfigWizard({ err: (m) => console.error(m) });
}

if (subcommand === 'attach') {
  await attach(Deno.args.slice(1));
}

if (subcommand === 'claude') {
  await attach(Deno.args.slice(1), 'claude');
}

if (subcommand === 'copilot') {
  await attach(Deno.args.slice(1), 'copilot');
}

if (subcommand === 'pi') {
  await attach(Deno.args.slice(1), 'pi');
}

if (subcommand === 'herdr') {
  await attach(Deno.args.slice(1), 'herdr');
}

if (subcommand === 'stop') {
  const target = resolveLocalFolder(Deno.args[1]);
  await stopContainer(target);
  console.log(`Stopped container for ${target}`);
  Deno.exit(0);
}

if (subcommand === 'down') {
  const target = resolveLocalFolder(Deno.args[1]);
  await downContainer(target);
  console.log(`Removed container for ${target}`);
  Deno.exit(0);
}

if (subcommand === 'status') {
  const target = resolveLocalFolder(Deno.args[1]);
  console.log(await getContainerStatus(target));
  Deno.exit(0);
}

if (subcommand === 'up') {
  const { target: rawTarget, printConfig, json } = parseUpArgs(
    Deno.args.slice(1),
  );
  const target = resolveLocalFolder(rawTarget);

  // `--print-config` starts nothing: the effective config is merged into a cache directory
  // rather than left in the project, so this is what makes it readable — including before the
  // project has ever been started.
  if (printConfig) {
    const merged = await ensureMergedConfig(target).catch(fail);
    console.log(JSON.stringify(merged.config, null, 2));
    Deno.exit(0);
  }

  const info = await startContainer(target, false).catch(fail);
  if (json) {
    console.log(JSON.stringify(info));
  } else {
    console.log(
      `${info.containerId} running — workspace ${info.remoteWorkspaceFolder}`,
    );
  }
  Deno.exit(0);
}

// `devc build [PATH]`: recreate the container from scratch, without attaching. This is the
// operation that makes a `devcontainer.json` change take effect, since mounts are bound at
// container-create time; `--no-cache` also rebuilds the image without the layer cache.
if (subcommand === 'build') {
  const { target: rawTarget, noCache, json } = parseBuildArgs(
    Deno.args.slice(1),
  );
  const target = resolveLocalFolder(rawTarget);
  if (!json) console.log(`Rebuilding dev container for ${target}...`);
  const info = await rebuildContainer(target, { noCache }).catch(fail);
  if (json) {
    console.log(JSON.stringify(info));
  } else {
    console.log(
      `${info.containerId} running — workspace ${info.remoteWorkspaceFolder}`,
    );
  }
  Deno.exit(0);
}

if (subcommand === 'exec') {
  const rest = Deno.args.slice(1);

  // Everything after the `--` separator is the command, verbatim (exec'd
  // directly — no shell). Flags/path are parsed only from before it.
  const sepIndex = rest.indexOf('--');
  const flagArgs = sepIndex === -1 ? rest : rest.slice(0, sepIndex);
  const cmd = sepIndex === -1 ? [] : rest.slice(sepIndex + 1);

  let target: string | undefined;
  let cwd: string | undefined;
  const env: Record<string, string> = {};
  for (let i = 0; i < flagArgs.length; i++) {
    const a = flagArgs[i];
    if (a === '--cwd') {
      cwd = flagArgs[++i];
    } else if (a === '--env') {
      const kv = flagArgs[++i] ?? '';
      const eq = kv.indexOf('=');
      if (eq === -1) {
        console.error(`devc: --env expects K=V, got "${kv}"`);
        Deno.exit(125);
      }
      env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (!a.startsWith('--') && target === undefined) {
      target = a;
    }
  }

  if (cmd.length === 0) {
    console.error('devc: exec requires a command after `--`');
    Deno.exit(125);
  }

  try {
    // stdio defaults to 'inherit' — devc exec streams straight through, same as always.
    const { code } = await execInContainer(resolveLocalFolder(target), {
      cwd,
      env,
      cmd,
    });
    Deno.exit(code); // command's own exit code
  } catch (e) {
    console.error(`devc: ${e instanceof Error ? e.message : e}`);
    Deno.exit(125); // reserved: devc/docker infra failure
  }
}

if (subcommand === 'mounts') {
  const rest = Deno.args.slice(1);
  const json = rest.includes('--json');
  const target = resolveLocalFolder(rest.find((a) => !a.startsWith('--')));
  const m = await getContainerMounts(target);
  if (json) {
    console.log(JSON.stringify(m ?? []));
  } else if (m === null) {
    console.log(`No container for ${target}`);
  } else {
    for (const mount of m) {
      console.log(
        `${mount.type}\t${mount.source} -> ${mount.destination}\t${
          mount.rw ? 'rw' : 'ro'
        }`,
      );
    }
  }
  Deno.exit(0);
}

// Any subcommand reaching here is known (unknown/help/version exited above) but did not match a
// dispatch arm — this is a devc bug rather than user error.
console.error(`devc: command '${subcommand}' is not wired up`);
Deno.exit(70);
