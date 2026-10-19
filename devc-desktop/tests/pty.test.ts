import { test } from 'node:test';
import { deepStrictEqual as assertEquals } from 'node:assert/strict';
import { HostPty, hostShell, ptyEnv } from '../src/main/pty.ts';

test('hostShell: $SHELL, else the account shell, else the platform default', () => {
  assertEquals(
    hostShell({ SHELL: '/bin/fish' }, 'darwin', '/bin/zsh'),
    '/bin/fish',
  );
  assertEquals(hostShell({}, 'linux', '/usr/bin/zsh'), '/usr/bin/zsh');
  assertEquals(hostShell({ SHELL: '' }, 'darwin', null), '/bin/zsh');
  assertEquals(hostShell({}, 'linux', null), '/bin/bash');
});

test('ptyEnv: the given environment plus a terminal type', () => {
  assertEquals(ptyEnv({ PATH: '/bin', TERM: 'dumb' }), {
    PATH: '/bin',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  });
});

/** A stand-in for node-pty's spawn: records what it was given and lets the test drive it. */
function fakeSpawn() {
  const made: Array<{
    file: string;
    args: string[];
    opts: Record<string, unknown>;
    written: string[];
    sizes: Array<[number, number]>;
    data: (d: string) => void;
    exit: (e: { exitCode: number }) => void;
  }> = [];
  const spawn =
    ((file: string, args: string[], opts: Record<string, unknown>) => {
      const p = {
        file,
        args,
        opts,
        written: [] as string[],
        sizes: [] as Array<[number, number]>,
        data: (_d: string) => {},
        exit: (_e: { exitCode: number }) => {},
      };
      made.push(p);
      return {
        pid: 999999,
        process: 'zsh',
        onData: (cb: (d: string) => void) => p.data = cb,
        onExit: (cb: (e: { exitCode: number }) => void) => {
          const prev = p.exit;
          p.exit = (e) => {
            prev(e);
            cb(e);
          };
        },
        write: (d: string) => p.written.push(d),
        resize: (c: number, r: number) => p.sizes.push([c, r]),
        kill: () => p.exit({ exitCode: 0 }),
      };
    }) as never;
  return { spawn, made };
}

test('HostPty: one login shell, reused until it exits', async () => {
  const { spawn, made } = fakeSpawn();
  const out: string[] = [];
  const exits: number[] = [];
  const pty = new HostPty({
    shell: '/bin/zsh',
    cwd: '/home/me',
    env: { PATH: '/bin' },
    onOutput: (d) => out.push(d),
    onExit: (c) => exits.push(c),
  }, spawn);
  pty.start(100, 30);
  assertEquals(made.length, 1);
  assertEquals([made[0].file, made[0].args], ['/bin/zsh', ['-l']]);
  assertEquals([made[0].opts.cols, made[0].opts.rows, made[0].opts.cwd], [
    100,
    30,
    '/home/me',
  ]);
  // A second start (the drawer reopened) resizes the same shell.
  pty.start(120, 40);
  assertEquals(made.length, 1);
  assertEquals(made[0].sizes, [[120, 40]]);
  pty.write('ls\r');
  assertEquals(made[0].written, ['ls\r']);
  // Output is batched into one message.
  made[0].data('a');
  made[0].data('b');
  await new Promise((r) => setTimeout(r, 40));
  assertEquals(out, ['ab']);
  // Exit: reported, and the next start spawns a new shell.
  made[0].exit({ exitCode: 3 });
  assertEquals([exits, pty.running], [[3], false]);
  pty.start(80, 24);
  assertEquals(made.length, 2);
});

test('HostPty: sizes from the page are whole numbers in range, else the defaults', () => {
  const { spawn, made } = fakeSpawn();
  const pty = new HostPty({
    shell: '/bin/sh',
    cwd: '/',
    env: {},
    onOutput: () => {},
    onExit: () => {},
  }, spawn);
  pty.start(Number.NaN, 1e9);
  assertEquals([made[0].opts.cols, made[0].opts.rows], [80, 24]);
  pty.resize(0, 2.5);
  assertEquals(made[0].sizes, [[80, 24]]);
});

test('HostPty: shell and foreground', () => {
  const { spawn, made } = fakeSpawn();
  const pty = new HostPty({
    shell: '/bin/zsh',
    cwd: '/',
    env: {},
    onOutput: () => {},
    onExit: () => {},
  }, spawn);
  assertEquals([pty.shell, pty.foreground], ['/bin/zsh', null]);
  pty.start(80, 24);
  assertEquals(pty.foreground, 'zsh');
  made[0].exit({ exitCode: 0 });
  assertEquals(pty.foreground, null);
});
