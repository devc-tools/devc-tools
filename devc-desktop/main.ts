// devc-desktop: `devc web` in its own window. Runs the installed `devc web --no-open …` as a
// child, shows a status page while it starts, then points the window at the URL the child
// prints. Live mode (`--live`, `--live-yolo`) works unchanged: the supervisor, its server swaps
// and its fallback all stay inside `devc`, on devc's fixed port, so the page reconnects across
// them as a browser tab does. See `.plans/devc-desktop.md`.
//
// Built with `deno desktop --backend cef` (see deno.json), whose `Deno.BrowserWindow` plain
// `deno check` does not know; everything testable lives in `launch.ts` and `status.ts`.

import {
  childEnv,
  desktopWebArgsFromConfig,
  devcArgs,
  type DevcWeb,
  findDevc,
  loginPath,
  LOOKED,
  onPath,
  startDevcWeb,
} from './launch.ts';
import { type Status, statusHandler } from './status.ts';

/** devc's global config, where `desktopWebArgs` lives. */
const CONFIG_PATH = `${Deno.env.get('HOME') ?? ''}/.config/devc/config.json`;

let status: Status = { phase: 'starting', message: 'Starting…', stderr: [] };
let current: DevcWeb | null = null;
let stopping = false;

const set = (next: Status) => {
  status = next;
  console.error(`devc-desktop: ${next.message}`);
};
const fail = (message: string, stderr: string[] = []) =>
  set({ phase: 'failed', message, stderr });

// The app's first `Deno.serve`: the desktop runtime binds it to its own address, which the
// startup window loads.
const statusUrl = await new Promise<string>((resolve) => {
  Deno.serve(
    {
      hostname: '127.0.0.1',
      port: 0,
      onListen: ({ port }) => resolve(`http://127.0.0.1:${port}/`),
    },
    statusHandler(() => status, () => void start()),
  );
});

// The first BrowserWindow adopts the startup window.
const win = new Deno.BrowserWindow({ title: 'devc web' });

async function readConfig(): Promise<string | null> {
  try {
    return await Deno.readTextFile(CONFIG_PATH);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

/** Starts `devc web`, unless one is running. Every outcome lands in `status`. */
async function start(): Promise<void> {
  if (current !== null || stopping) return;
  set({ phase: 'starting', message: 'Looking for devc…', stderr: [] });
  const found = await findDevc({
    env: (k) => Deno.env.get(k),
    onPath,
    loginPath: () => loginPath(),
  });
  if (found === null) {
    return fail(`devc not found. Looked in ${LOOKED.join(', ')}.`);
  }
  let args;
  try {
    args = devcArgs(Deno.args, desktopWebArgsFromConfig(await readConfig()));
  } catch (e) {
    return fail(`${CONFIG_PATH}: ${e instanceof Error ? e.message : e}`);
  }
  if (current !== null || stopping) return;
  let child: DevcWeb;
  try {
    child = startDevcWeb(
      found.devc,
      args,
      childEnv(Deno.env.toObject(), found.path),
    );
  } catch (e) {
    return fail(
      `cannot run ${found.devc}: ${e instanceof Error ? e.message : e}`,
    );
  }
  current = child;
  set({
    phase: 'starting',
    message: `Running ${found.devc} ${args.join(' ')}…`,
    stderr: [],
  });
  let shown = false;
  void child.ready.then((url) => {
    if (current !== child || stopping) return;
    shown = true;
    win.navigate(url);
  });
  void child.exited.then((code) => {
    if (current !== child) return;
    current = null;
    if (stopping) return;
    fail(`devc web exited (${code})`, child.stderr());
    if (shown) win.navigate(statusUrl);
  });
}

/** Stops `devc web`, waiting for it, then exits. Closing the last window would end the app at
 * once, before any cleanup, so the close is cancelled until the child is gone. */
async function shutdown(): Promise<never> {
  stopping = true;
  await current?.stop();
  Deno.exit(0);
}

win.addEventListener('close', (e) => {
  e.preventDefault();
  void shutdown();
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  try {
    Deno.addSignalListener(sig, () => void shutdown());
  } catch { /* signal unsupported on this platform */ }
}

void start();
