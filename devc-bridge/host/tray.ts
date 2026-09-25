// Tray front-end for the command bridge: runs the headless core (core.ts) and, on a
// host with the `deno desktop` runtime, adds a macOS menu-bar icon reflecting
// idle-vs-active state. This module has no top-level side effects — main.ts calls
// runTray() only on the `run` path, so the short-lived CLI paths (start/stop/status)
// never touch the desktop/tray APIs.
//
// The functional bridge (socket server, dispatch, state watch, pidfile, signals) is
// set up first and unconditionally; the tray is a best-effort layer on top. If the
// Tray API is unavailable (no `deno desktop` runtime), we log a warning and keep
// running headless rather than crashing — which also lets the lifecycle be tested
// in-container without a GUI.

import { startServer } from './core.ts';
import { resetToken } from './token.ts';
import { appendLog, type Config, errMsg } from './config.ts';

// Icons are embedded (base64) rather than read from disk: the compiled binary runs
// from a temp dir, so a path relative to import.meta.url would point at a nonexistent
// file. Keep these in sync with icons/*.png (tiny template PNGs; regenerate with:
// base64 -w0 icons/idle.png).
const ICON_IDLE_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAmElEQVR42sWVyxGAIAxE7YQ+6IFeuKcFmqMDGmE0h1xckQmjq5l5Fz5LWCBs288RlGiEN8SK0pQdaNa3vEhW+kAQ6TbWFcUhiBRPpjipKqIkQ6wNx+WZp7h9mSQhA1uCxwJx2CYeSxps3xsVbsvFhtVs77I+2RGhMy0IJ5gbPxGmWUE7POp1oz0Q2pOmFiFq2aQWeurX9CgOudGk4ZXdJwgAAAAASUVORK5CYII=';
const ICON_ACTIVE_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAeklEQVR42sWVwQ3AIAhF3cQ9nMpBGJJFCOXApcQarfyW5J00T/NVLOXnqkZzaoaMDDY0wD62vUg3ZCCMiM9dKloQRmhlp/qSPstUDsTylDkdSKeRcIKYRzFoErc4WqK4fSKGRQE7POh1gz0Q2JOGNiFo24Q2eujXdFQXv7QL2NPzn44AAAAASUVORK5CYII=';

function decodeIcon(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Run the bridge (+ tray when available) until quit/terminated. Never returns. */
export async function runTray(cfg: Config): Promise<void> {
  // Launched via `open`, this process has no visible console — mirror startup and any
  // fatal error into the log file so `devc-bridge start` can explain a failed launch.
  try {
    await runTrayInner(cfg);
  } catch (e) {
    await appendLog(cfg.logfile, `FATAL: ${errMsg(e)}`);
    throw e;
  }
}

async function runTrayInner(cfg: Config): Promise<void> {
  // paint() is the tray repaint hook; a no-op until/unless the tray comes up, so the
  // server can emit active-set changes safely from the moment it starts.
  let paint: (active: string[]) => void = () => {};

  const token = await resetToken(cfg.token);
  const server = await startServer({
    hostname: cfg.hostname,
    port: cfg.port,
    token,
    keysDir: cfg.keys,
    commandsDir: cfg.commands,
    stateDir: cfg.state,
    policyDir: cfg.policy,
    onActiveChange: (active) => paint(active),
    keepawake: cfg.keepawake,
  });

  // Record our PID so `devc-bridge stop`/`status` can find us however we were launched
  // (backgrounded by `start`, or run/double-clicked directly).
  try {
    await Deno.writeTextFile(cfg.pidfile, `${Deno.pid}\n`);
  } catch (e) {
    await appendLog(
      cfg.logfile,
      `could not write pidfile ${cfg.pidfile}: ${errMsg(e)}`,
    );
  }

  const shutdown = async () => {
    await server.close();
    try {
      Deno.removeSync(cfg.pidfile);
    } catch { /* already gone */ }
    Deno.exit(0);
  };
  // `devc-bridge stop` sends SIGTERM; also handle Ctrl-C in the foreground `run`.
  Deno.addSignalListener('SIGINT', shutdown);
  Deno.addSignalListener('SIGTERM', shutdown);

  const painted = trySetupTray(cfg, server.active(), shutdown);
  paint = painted ?? (() => {});
  await appendLog(
    cfg.logfile,
    `listening on ${server.address} (commands: ${cfg.commands})` +
      (painted ? '' : ' — tray unavailable, running headless'),
  );

  // Keep the process alive; the tray event loop and signal handlers drive shutdown.
  await new Promise<void>(() => {});
}

/**
 * Best-effort menu-bar tray. Returns a repaint function, or null if the desktop/Tray
 * runtime isn't available (in which case the bridge keeps running headless).
 */
function trySetupTray(
  cfg: Config,
  initialActive: string[],
  shutdown: () => void,
): ((active: string[]) => void) | null {
  // deno-lint-ignore no-explicit-any
  const D = Deno as any;
  if (typeof D.Tray !== 'function') return null;

  try {
    const idleIcon = decodeIcon(ICON_IDLE_B64);
    const activeIcon = decodeIcon(ICON_ACTIVE_B64);

    // Menu-bar-only accessory app: no dock icon, no window. Under the default
    // (webview) backend `deno desktop` creates an implicit window that waits on a
    // local HTTP server we don't run; adopt+hide it and bind a no-op server so the
    // launch handshake completes. All guarded so the raw backend (no webview) — which
    // has no implicit window — is unaffected.
    try {
      D.dock?.setVisible(false);
    } catch { /* non-macOS */ }
    try {
      const win = new D.BrowserWindow();
      win.navigate('data:text/html,<html></html>');
      win.hide();
    } catch { /* no implicit window (raw backend) */ }
    try {
      Deno.serve({ onListen() {} }, () => new Response(''));
    } catch { /* backend doesn't expect a server */ }

    const tray = new D.Tray();

    const render = (active: string[]) => {
      const awake = active.length > 0;
      tray.setIcon(awake ? activeIcon : idleIcon);
      tray.setTooltip(
        awake
          ? `devc-bridge: active — ${active.join(', ')}`
          : 'devc-bridge: idle',
      );
      const menu: unknown[] = [];
      if (awake) {
        for (const name of active) {
          menu.push({
            item: { label: `● ${name}`, id: `active:${name}`, enabled: false },
          });
        }
        menu.push('separator');
      } else {
        menu.push({ item: { label: 'idle', id: 'idle', enabled: false } });
        menu.push('separator');
      }
      menu.push({
        item: {
          label: 'Open commands folder',
          id: 'open-commands',
          enabled: true,
        },
      });
      menu.push({ item: { label: 'Quit', id: 'quit', enabled: true } });
      tray.setMenu(menu);
    };

    tray.addEventListener('menuclick', (e: { detail: { id: string } }) => {
      switch (e.detail.id) {
        case 'quit':
          shutdown();
          break;
        case 'open-commands':
          new Deno.Command('open', { args: [cfg.commands] }).spawn();
          break;
      }
    });

    render(initialActive);
    return render;
  } catch (e) {
    console.error(
      `devc-bridge: tray setup failed (${errMsg(e)}); running headless`,
    );
    return null;
  }
}
