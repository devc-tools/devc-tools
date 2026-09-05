import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import {
  COMMAND_HELP,
  COMMANDS,
  helpRequested,
  topLevelHelp,
  VERSION,
} from '../help.ts';

Deno.test('VERSION is a non-empty string', () => {
  assert(typeof VERSION === 'string' && VERSION.length > 0);
});

Deno.test('topLevelHelp lists every command, the version option, and the footer', () => {
  const help = topLevelHelp();
  for (const { name } of COMMANDS) {
    assertStringIncludes(help, name);
  }
  assertStringIncludes(help, '-V, --version  Print version');
  assertStringIncludes(
    help,
    'Run "devc <COMMAND> --help" for more information on a command.',
  );
});

Deno.test('COMMAND_HELP has a Usage block for each of the fourteen commands', () => {
  assertEquals(COMMANDS.length, 14);
  for (const { name } of COMMANDS) {
    const block = COMMAND_HELP[name];
    assert(block !== undefined, `missing help block for ${name}`);
    assertStringIncludes(block, `Usage: devc ${name}`);
  }
});

Deno.test('helpRequested detects -h / --help for a normal command', () => {
  assert(helpRequested('up', ['--help']));
  assert(helpRequested('up', ['-h']));
  assert(helpRequested('up', ['path', '--help']));
  assert(!helpRequested('up', ['.']));
  assert(!helpRequested('up', []));
});

Deno.test("helpRequested respects exec's `--` boundary", () => {
  // Before `--`: devc's own help.
  assert(helpRequested('exec', ['--help', '--', 'echo']));
  assert(helpRequested('exec', ['-h', '--', 'echo']));
  // After `--`: belongs to the user command, not devc.
  assert(!helpRequested('exec', ['--', 'echo', '--help']));
  assert(!helpRequested('exec', ['.']));
});

Deno.test('build is listed and documents its own options', () => {
  assertStringIncludes(
    topLevelHelp(),
    'build     Rebuild the dev container for the current project',
  );
  const block = COMMAND_HELP['build'];
  assertStringIncludes(block, '--no-cache');
  assertStringIncludes(block, '--json');
});
