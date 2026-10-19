// The `devcontainer` CLI, embedded in devc — not looked up on PATH, and not run through
// `devc-core`'s default `nodeDevcontainerRunner` either: that runner spawns `process.execPath`
// against a `devcontainer.js` resolved from `node_modules`, and a `deno compile` binary has
// neither. This module is the CLI's own `DevcontainerRunner` (see `devc-core/devcontainer.ts`),
// bound into `container.ts` below.
//
// `@devcontainers/cli` ships **no programmatic API**: its `package.json` declares only `bin`, and
// its esbuild bundle ends in `0&&(module.exports={doExec})` — the dead-code marker, so it exports
// nothing. Importing it *runs* the CLI against `process.argv` and finishes with `process.exit()`.
// Both facts rule out calling it in-process: devc would have to hand over its own argv and would
// be killed when the CLI exits.
//
// So devc re-execs **itself** with a hidden `__devcontainer` subcommand
// ({@link DEVCONTAINER_SUBCOMMAND}). The child sets `process.argv` and imports the bundle, which
// makes that process a devcontainer CLI; the parent pipes its stdout exactly as it piped the PATH
// binary's, so {@link import("@devc-tools/core/container.ts").startContainer}'s JSON-per-line
// parsing is unchanged. One binary — neither `devcontainer` nor `node` has to exist on the host.
//
// The npm package is pinned in `deno.json`'s `imports` and embedded by `deno compile`, which is
// what makes the child self-sufficient. It is pure JavaScript with zero dependencies, so it
// cross-compiles to every release target like the rest of the graph.
import { fromFileUrl } from 'jsr:@std/path';
import type { DevcontainerRunner } from '@devc-tools/core/devcontainer.ts';

/**
 * Hidden first argument that turns a devc process into the devcontainer CLI. Dispatched in
 * `main.ts` ahead of everything else and deliberately absent from `COMMANDS`: it is an
 * implementation detail of {@link selfExecDevcontainerRunner}, not a command anyone types.
 *
 * The `__` prefix keeps it out of the namespace a real subcommand could ever want.
 */
export const DEVCONTAINER_SUBCOMMAND = '__devcontainer';

/**
 * Permissions the **from-source** child is spawned with (`deno run <perms> main.ts
 * __devcontainer …`). A `Deno.Command` child is a fresh process and inherits nothing, so the set
 * has to be spelled out; the compiled binary gets the equivalent set baked in by `deno compile`,
 * from `deno.json`'s `build` task. Keep the two in step — they are the same permissions for the
 * same code, and only the delivery differs.
 *
 * `--allow-run` is unscoped, here and in `deno.json`, and that is forced rather than chosen: a
 * `devcontainer.json` may declare an `initializeCommand`, which the CLI runs **on the host**
 * through `/bin/sh -c` (devc's own bundled default declares one). An allowlist containing
 * `/bin/sh` permits every host command anyway, so enumerating `docker`, `git` and friends beside
 * it would only look like a boundary. `--allow-sys` and `--allow-net` are the CLI's too:
 * `osRelease` on startup, and its own HTTPS fetches of Features from OCI registries during `up`.
 */
const SOURCE_CHILD_PERMISSIONS = [
  '--allow-read',
  '--allow-write',
  '--allow-env',
  '--allow-sys',
  '--allow-net',
  '--allow-run',
];

/** The subset of the runtime {@link devcontainerArgv} reads, injectable for tests. */
export interface SelfExecRuntime {
  /** `Deno.execPath()` — the devc binary when compiled, the `deno` binary from source. */
  execPath: string;
  /** `Deno.build.standalone` — true inside a `deno compile` binary. */
  standalone: boolean;
  /** `Deno.mainModule` — the `file:` URL of `main.ts`; only read from source. */
  mainModule: string;
}

/**
 * Full argv for the self-exec, given the devcontainer CLI's own `args` (`['up', …]`).
 *
 * Compiled, `execPath` is the devc binary and the hidden subcommand is all it takes. From source
 * `execPath` is `deno` itself, so the invocation has to be rebuilt around `main.ts`:
 * `deno run <perms> /path/to/main.ts __devcontainer …`. Pure and exported for the same reason
 * `buildUpArgs` is — the branch that only fires in a compiled binary is otherwise untestable.
 */
export function devcontainerArgv(
  args: string[],
  runtime: SelfExecRuntime,
): string[] {
  const self = runtime.standalone
    ? []
    : ['run', ...SOURCE_CHILD_PERMISSIONS, fromFileUrl(runtime.mainModule)];
  return [...self, DEVCONTAINER_SUBCOMMAND, ...args];
}

/** {@link devcontainerArgv}'s runtime input, read from the live `Deno` namespace. */
export function currentRuntime(): SelfExecRuntime {
  return {
    execPath: Deno.execPath(),
    standalone: Deno.build.standalone,
    mainModule: Deno.mainModule,
  };
}

/**
 * The CLI's `DevcontainerRunner`: self-execs with the hidden `__devcontainer` subcommand and
 * captures its stdout, a drop-in for `devc-core`'s default `nodeDevcontainerRunner` — see the
 * module header for why a compiled binary needs its own.
 */
export const selfExecDevcontainerRunner: DevcontainerRunner = {
  async run(args) {
    const runtime = currentRuntime();
    const cmd = new Deno.Command(runtime.execPath, {
      args: devcontainerArgv(args, runtime),
      stdout: 'piped',
      stderr: 'inherit',
    });
    const { code, stdout } = await cmd.output();
    return { code, stdout: new TextDecoder().decode(stdout) };
  },
};

/**
 * The child half: become the devcontainer CLI. Sets `process.argv` to what the bundle's yargs
 * parser expects (`[node, devcontainer, …]`) and imports it, which runs it.
 *
 * Never returns — the CLI exits the process itself, which is exactly why this runs in a child.
 * The import is dynamic so a plain `devc up` never pays to load a 1.9 MB bundle it will not use;
 * the specifier is a literal, so `deno compile` still resolves it statically and embeds it.
 */
export async function runEmbeddedDevcontainerCli(
  args: string[],
): Promise<never> {
  const process = (await import('node:process')).default;
  process.argv = ['node', 'devcontainer', ...args];
  await import('npm:@devcontainers/cli/devcontainer.js');

  // The bundle's entry point is a bare `(async () => { … })()` — nothing exports its promise, so
  // the import above resolves the moment the module *evaluates*, with every `up` still running.
  // Parking here is what hands the process to the CLI: it owns the exit, on success and on
  // failure alike. Returning instead would drop straight back into devc's own dispatch below the
  // call, mid-`up`; an explicit `Deno.exit()` here would kill the CLI before it did anything
  // (measured: a silent exit 0 and not one line of the JSON stream devc parses).
  await new Promise<never>(() => {});
  throw new Error('unreachable: the devcontainer CLI exits the process');
}
