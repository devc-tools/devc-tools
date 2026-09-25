// Clap-style help/version text for the `devc` CLI. Kept as a pure module (no argv, no IO) so the
// text and the help-detection logic are unit-testable; `main.ts` wires it into argv dispatch.
// The command help blocks mirror `.plans/design/devc-design.md` (the source of truth) verbatim.

/** CLI version. Single source of truth — the compiled binary cannot read `deno.json` at runtime. */
export const VERSION = '0.3.0';

/** The fifteen subcommands, in the order they appear in the top-level `Commands:` list. */
export const COMMANDS: { name: string; summary: string }[] = [
  {
    name: 'init',
    summary: 'Scaffold the default dev container config into the project',
  },
  {
    name: 'config',
    summary: 'Configure the source/skills mounts for the current project (TUI)',
  },
  {
    name: 'attach',
    summary: 'Attach to the dev container for the current project',
  },
  {
    name: 'claude',
    summary: 'Launch Claude inside the dev container for the current project',
  },
  {
    name: 'copilot',
    summary:
      'Launch GitHub Copilot CLI inside the dev container for the current project',
  },
  {
    name: 'pi',
    summary: 'Launch pi inside the dev container for the current project',
  },
  {
    name: 'herdr',
    summary: 'Launch herdr inside the dev container for the current project',
  },
  { name: 'up', summary: 'Start the dev container for the current project' },
  {
    name: 'build',
    summary: 'Rebuild the dev container for the current project',
  },
  {
    name: 'exec',
    summary:
      'Execute a command inside the dev container for the current project',
  },
  { name: 'mounts', summary: 'List container mounts for the current project' },
  { name: 'stop', summary: 'Stop the dev container for the current project' },
  { name: 'down', summary: 'Remove the dev container for the current project' },
  {
    name: 'prune',
    summary: 'Remove devc-bridge key dirs and policies no container uses',
  },
  {
    name: 'status',
    summary: 'Show dev container status for the current project',
  },
];

/** The top-level `devc --help` block (also shown for a bare `devc`). */
export function topLevelHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const commandLines = COMMANDS
    .map((c) => `  ${c.name.padEnd(width)}   ${c.summary}`)
    .join('\n');
  return [
    'Usage: devc [OPTIONS] <COMMAND>',
    '',
    'Options:',
    '  -h, --help     Print help',
    '  -V, --version  Print version',
    '',
    'Commands:',
    commandLines,
    '',
    'Run "devc <COMMAND> --help" for more information on a command.',
  ].join('\n');
}

/** Per-command help blocks, keyed by command name — verbatim from the design doc. */
export const COMMAND_HELP: Record<string, string> = {
  init: [
    'Usage: devc init [PATH]',
    '',
    'Arguments:',
    '  [PATH]  Path to the project (default: current directory)',
    '',
    'Options:',
    '  -h, --help  Print help',
  ].join('\n'),

  config: [
    'Usage: devc config [PATH] [--global]',
    '',
    'Arguments:',
    '  [PATH]  Path to the project (default: current directory)',
    '',
    'Options:',
    '      --global  Reconfigure the code/skills folder roots only, then exit',
    '  -h, --help    Print help',
  ].join('\n'),

  attach: [
    'Usage: devc attach [PATH] [OPTIONS]',
    '',
    'Arguments:',
    '  [PATH]  Path to the project (default: current directory)',
    '',
    'Options:',
    '      --build      Force a rebuild before attaching',
    '      --no-clear   Do not clear the screen before starting the TUI',
    '      --cwd <PATH> Start in PATH instead of the workspace folder — a',
    '                   container path, or a host path, which wins when a',
    '                   value could be read as either',
    '  -h, --help       Print help',
  ].join('\n'),

  claude: [
    'Usage: devc claude [PATH] [OPTIONS] [-- EXTRA_ARGS...]',
    '',
    'Arguments:',
    '  [PATH]         Path to the project (default: current directory)',
    '  [EXTRA_ARGS]   Additional arguments forwarded to Claude',
    '                 (everything after --)',
    '',
    'Options:',
    '      --cwd <PATH>  Start in PATH instead of the workspace folder — a',
    '                    container path, or a host path, which wins when a',
    '                    value could be read as either',
    '  -h, --help        Print help',
  ].join('\n'),

  copilot: [
    'Usage: devc copilot [PATH] [OPTIONS] [-- EXTRA_ARGS...]',
    '',
    'Arguments:',
    '  [PATH]         Path to the project (default: current directory)',
    '  [EXTRA_ARGS]   Additional arguments forwarded to Copilot',
    '                 (everything after --)',
    '',
    'Options:',
    '      --cwd <PATH>  Start in PATH instead of the workspace folder — a',
    '                    container path, or a host path, which wins when a',
    '                    value could be read as either',
    '  -h, --help        Print help',
  ].join('\n'),

  pi: [
    'Usage: devc pi [PATH] [OPTIONS] [-- EXTRA_ARGS...]',
    '',
    'Arguments:',
    '  [PATH]         Path to the project (default: current directory)',
    '  [EXTRA_ARGS]   Additional arguments forwarded to pi',
    '                 (everything after --)',
    '',
    'Options:',
    '      --cwd <PATH>  Start in PATH instead of the workspace folder — a',
    '                    container path, or a host path, which wins when a',
    '                    value could be read as either',
    '  -h, --help        Print help',
  ].join('\n'),

  herdr: [
    'Usage: devc herdr [PATH] [OPTIONS] [-- EXTRA_ARGS...]',
    '',
    'Arguments:',
    '  [PATH]         Path to the project (default: current directory)',
    '  [EXTRA_ARGS]   Additional arguments forwarded to herdr',
    '                 (everything after --)',
    '                 Without --session, --remote or a subcommand, herdr',
    '                 runs as `herdr --session devc` (deletable, unlike the',
    '                 default session)',
    '',
    'Options:',
    '      --cwd <PATH>  Start in PATH instead of the workspace folder — a',
    '                    container path, or a host path, which wins when a',
    '                    value could be read as either',
    '  -h, --help        Print help',
  ].join('\n'),

  up: [
    'Usage: devc up [PATH] [OPTIONS]',
    '',
    'Arguments:',
    '  [PATH]  Path to the project (default: current directory)',
    '',
    'Options:',
    '      --print-config      Print the effective devcontainer.json and exit',
    '      --json              Output container status as JSON',
    '      --bridge-git-push   Let this container push its current branch via',
    '                          devc-bridge; without it, any earlier grant is',
    '                          removed',
    '  -h, --help              Print help',
  ].join('\n'),

  build: [
    'Usage: devc build [PATH] [OPTIONS]',
    '',
    'Arguments:',
    '  [PATH]  Path to the project (default: current directory)',
    '',
    'Options:',
    '      --no-cache          Rebuild the image without the Docker layer cache',
    '      --json              Output container status as JSON',
    '      --bridge-git-push   As for `devc up`',
    '  -h, --help              Print help',
  ].join('\n'),

  exec: [
    'Usage: devc exec [PATH] [OPTIONS] -- <CMD...>',
    '',
    'Arguments:',
    '  [PATH]          Path to the project (default: current directory)',
    '  <CMD>...        Command (with arguments) to execute in the container',
    '',
    'Options:',
    '      --cwd <DIR>   Working directory inside the container',
    '      --env K=V     Environment variable(s) to set (repeatable)',
    '  -h, --help        Print help',
  ].join('\n'),

  mounts: [
    'Usage: devc mounts [PATH] [OPTIONS]',
    '',
    'Arguments:',
    '  [PATH]  Path to the project (default: current directory)',
    '',
    'Options:',
    '      --json   Output mounts as JSON',
    '  -h, --help   Print help',
  ].join('\n'),

  stop: [
    'Usage: devc stop [PATH]',
    '',
    'Arguments:',
    '  [PATH]  Path to the project (default: current directory)',
    '',
    'Options:',
    '  -h, --help  Print help',
  ].join('\n'),

  down: [
    'Usage: devc down [PATH]',
    '',
    'Arguments:',
    '  [PATH]  Path to the project (default: current directory)',
    '',
    'Options:',
    '  -h, --help  Print help',
    '',
    "Also removes this project's devc-bridge key dir and git-push policy.",
  ].join('\n'),

  prune: [
    'Usage: devc prune [OPTIONS]',
    '',
    'Options:',
    '      --dry-run   Print what would be removed, and remove nothing',
    '  -h, --help      Print help',
    '',
    'Removes every ~/.config/devc-bridge/keys/<key>/ and policy/<key>.conf that no',
    'container (running or stopped) maps to. Removes nothing if docker is unreachable.',
  ].join('\n'),

  status: [
    'Usage: devc status [PATH]',
    '',
    'Arguments:',
    '  [PATH]  Path to the project (default: current directory)',
    '',
    'Options:',
    '  -h, --help  Print help',
    '',
    'Prints the container state, then a git-protection line per bind-mounted repo:',
    '  protected   .git is a mountpoint; .git/config and .git/hooks are read-only',
    '  MISMATCH    protection is configured but the container does not have it',
    '              (a mount you declared on the same target, or a container',
    '               created before the mounts existed — rebuild with `devc build`)',
    '  UNSUPPORTED an umbrella mount of a folder of repos — bind each repo instead',
    '  UNPROTECTED a mounted git dir with no hooks directory',
    'Set "gitProtect": false in devc.jsonc to turn the whole control off.',
    '',
    "Then the devc-bridge lines: this project's key, whether its token is present,",
    'and the git-push pin in force — or "absent" when there is none.',
  ].join('\n'),
};

/**
 * Whether a command invocation is asking for help (`-h` / `--help`).
 *
 * Everything after the first `--` belongs to the launched command (`exec`'s CMD, or what
 * `claude`/`copilot`/`pi`/`herdr` forward), so a `--help` there must NOT trigger devc's help —
 * only tokens before the `--` are scanned. `devc herdr -- --help` is herdr's help.
 */
export function helpRequested(_cmd: string, cmdArgs: string[]): boolean {
  const sep = cmdArgs.indexOf('--');
  const scan = sep === -1 ? cmdArgs : cmdArgs.slice(0, sep);
  return scan.some((a) => a === '-h' || a === '--help');
}
