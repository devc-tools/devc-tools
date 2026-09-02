// Clap-style help/version text for the `devc` CLI. Kept as a pure module (no argv, no IO) so the
// text and the help-detection logic are unit-testable; `main.ts` wires it into argv dispatch.
// The command help blocks mirror `.plans/design/devc-design.md` (the source of truth) verbatim.

/** CLI version. Single source of truth — the compiled binary cannot read `deno.json` at runtime. */
export const VERSION = '0.2.0';

/** The thirteen subcommands, in the order they appear in the top-level `Commands:` list. */
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
    'Usage: devc claude [PATH] [EXTRA_ARGS...]',
    '',
    'Arguments:',
    '  [PATH]         Path to the project (default: current directory)',
    '  [EXTRA_ARGS]   Additional arguments forwarded to Claude',
    '',
    'Options:',
    '      --cwd <PATH>  Start in PATH instead of the workspace folder — a',
    '                    container path, or a host path, which wins when a',
    '                    value could be read as either',
    '  -h, --help        Print help',
  ].join('\n'),

  copilot: [
    'Usage: devc copilot [PATH] [EXTRA_ARGS...]',
    '',
    'Arguments:',
    '  [PATH]         Path to the project (default: current directory)',
    '  [EXTRA_ARGS]   Additional arguments forwarded to Copilot',
    '',
    'Options:',
    '      --cwd <PATH>  Start in PATH instead of the workspace folder — a',
    '                    container path, or a host path, which wins when a',
    '                    value could be read as either',
    '  -h, --help        Print help',
  ].join('\n'),

  pi: [
    'Usage: devc pi [PATH] [EXTRA_ARGS...]',
    '',
    'Arguments:',
    '  [PATH]         Path to the project (default: current directory)',
    '  [EXTRA_ARGS]   Additional arguments forwarded to pi',
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
    '      --print-config   Print the effective devcontainer.json and exit',
    '      --json           Output container status as JSON',
    '  -h, --help           Print help',
  ].join('\n'),

  build: [
    'Usage: devc build [PATH] [OPTIONS]',
    '',
    'Arguments:',
    '  [PATH]  Path to the project (default: current directory)',
    '',
    'Options:',
    '      --no-cache   Rebuild the image without the Docker layer cache',
    '      --json       Output container status as JSON',
    '  -h, --help       Print help',
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
  ].join('\n'),

  status: [
    'Usage: devc status [PATH]',
    '',
    'Arguments:',
    '  [PATH]  Path to the project (default: current directory)',
    '',
    'Options:',
    '  -h, --help  Print help',
  ].join('\n'),
};

/**
 * Whether a command invocation is asking for help (`-h` / `--help`).
 *
 * For `exec`, everything after the first `--` is the user's command, so a `--help` there belongs
 * to that command and must NOT trigger devc's help — only tokens before the `--` are scanned.
 */
export function helpRequested(cmd: string, cmdArgs: string[]): boolean {
  let scan = cmdArgs;
  if (cmd === 'exec') {
    const sep = cmdArgs.indexOf('--');
    scan = sep === -1 ? cmdArgs : cmdArgs.slice(0, sep);
  }
  return scan.some((a) => a === '-h' || a === '--help');
}
