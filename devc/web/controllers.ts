// Pane streams for `devc web`: at most one `herdr terminal session control <pane> --takeover`
// per (container, pane), shared by every browser connection that has the pane open. Herdr
// allows one controller per terminal, so a second viewer joining restarts the controller with
// `--takeover` — that is how the new viewer gets a `full:true` frame — and the replaced
// process's own "taken over" close is expected and ignored.

import { herdrArgv, type HerdrTarget } from './herdr_bridge.ts';
import { closeGracefully, type LineProc, spawnLines } from './proc.ts';

/** A browser connection, as far as the controllers are concerned. */
export interface Subscriber {
  send(text: string): void;
}

/** A stdin command for `terminal session control`, written to its stdin as is. */
export type TerminalCommand =
  | { type: 'terminal.input'; bytes: string }
  | { type: 'terminal.resize'; cols: number; rows: number }
  | { type: 'terminal.scroll'; direction: 'up' | 'down'; lines: number }
  | {
    type: 'terminal.mouse';
    action: 'down' | 'up' | 'drag' | 'move';
    button?: 'left' | 'right' | 'middle';
    column: number;
    row: number;
  };

interface Controller {
  container: string;
  paneId: string;
  proc: LineProc;
  subscribers: Set<Subscriber>;
  /** Set once devc itself sent `terminal.release` or replaced this process. */
  ending: boolean;
}

const RELEASE_GRACE_MS = 2000;

function key(container: string, paneId: string): string {
  return `${container}\n${paneId}`;
}

export class ControllerManager {
  #controllers = new Map<string, Controller>();

  /**
   * Starts or joins the pane's controller. Resolves once the first frame has been fanned out;
   * rejects with the reason when Herdr refuses or the process dies first.
   */
  async open(
    sub: Subscriber,
    target: HerdrTarget,
    paneId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    const k = key(target.containerId, paneId);
    const existing = this.#controllers.get(k);
    const subscribers = new Set(existing?.subscribers ?? []);
    subscribers.add(sub);
    if (existing) existing.ending = true;

    const proc = spawnLines(
      'docker',
      herdrArgv(target, [
        'terminal',
        'session',
        'control',
        paneId,
        '--takeover',
        '--cols',
        String(cols),
        '--rows',
        String(rows),
      ]),
    );
    const ctl: Controller = {
      container: target.containerId,
      paneId,
      proc,
      subscribers,
      ending: false,
    };
    this.#controllers.set(k, ctl);
    // The old process is told nothing: the takeover closes it, and its stdin is closed after.
    if (existing) void closeGracefully(existing.proc, RELEASE_GRACE_MS);

    let first!: (err: string | null) => void;
    const firstP = new Promise<string | null>((r) => (first = r));
    void this.#pump(ctl, sub, first);
    const err = await firstP;
    if (err !== null) {
      // Only this opener hears about it. Viewers carried over from an earlier controller get the
      // `pane_closed` that #pump sends.
      throw new Error(err);
    }
  }

  async #pump(
    ctl: Controller,
    opener: Subscriber,
    first: (err: string | null) => void,
  ): Promise<void> {
    let gotFirst = false;
    let closedReason: string | null = null;
    for await (const line of ctl.proc.lines) {
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.type === 'terminal.frame') {
        if (!gotFirst) {
          gotFirst = true;
          first(null);
        }
        const text = JSON.stringify({
          type: 'frame',
          container: ctl.container,
          pane_id: ctl.paneId,
          seq: rec.seq,
          full: rec.full,
          cols: rec.width,
          rows: rec.height,
          bytes: rec.bytes,
        });
        for (const s of ctl.subscribers) s.send(text);
      } else if (rec.type === 'terminal.closed') {
        closedReason = String(rec.reason ?? 'closed');
        break;
      }
    }
    if (closedReason === null) {
      const stderr = (await ctl.proc.stderr).trim();
      closedReason = stderr || 'terminal controller exited';
    }
    void closeGracefully(ctl.proc, RELEASE_GRACE_MS);
    if (!gotFirst) first(closedReason);

    // Our own release, or a process we replaced: expected, nothing to report.
    if (ctl.ending) return;
    const k = key(ctl.container, ctl.paneId);
    if (this.#controllers.get(k) === ctl) this.#controllers.delete(k);
    // A failure before the first frame reaches the opener as its `open`'s error result instead.
    this.#notifyClosed(ctl, closedReason, gotFirst ? null : opener);
  }

  #notifyClosed(
    ctl: Controller,
    reason: string,
    skip: Subscriber | null | undefined,
  ): void {
    const text = JSON.stringify({
      type: 'pane_closed',
      container: ctl.container,
      pane_id: ctl.paneId,
      reason,
    });
    for (const s of ctl.subscribers) if (s !== skip) s.send(text);
  }

  /** Unsubscribes `sub`; the last one out releases the terminal. */
  close(sub: Subscriber, container: string, paneId: string): void {
    const k = key(container, paneId);
    const ctl = this.#controllers.get(k);
    if (!ctl || !ctl.subscribers.delete(sub)) return;
    if (ctl.subscribers.size > 0) return;
    this.#controllers.delete(k);
    void this.#release(ctl);
  }

  /** Whether `sub` has the pane open. */
  isOpen(sub: Subscriber, container: string, paneId: string): boolean {
    return this.#controllers.get(key(container, paneId))?.subscribers.has(
      sub,
    ) ??
      false;
  }

  /** Sends a stdin command to the pane's controller, if `sub` has it open. */
  send(
    sub: Subscriber,
    container: string,
    paneId: string,
    cmd: TerminalCommand,
  ): void {
    const ctl = this.#controllers.get(key(container, paneId));
    if (!ctl || !ctl.subscribers.has(sub)) return;
    void ctl.proc.write(JSON.stringify(cmd));
  }

  /** Closes everything `sub` has open (its WebSocket closed). */
  closeAll(sub: Subscriber): void {
    for (const ctl of [...this.#controllers.values()]) {
      if (ctl.subscribers.has(sub)) this.close(sub, ctl.container, ctl.paneId);
    }
  }

  /** Drops every controller for `container`, telling its viewers `reason`. */
  closeContainer(container: string, reason: string): Promise<void> {
    const ctls = [...this.#controllers.values()].filter((c) =>
      c.container === container
    );
    for (const ctl of ctls) {
      this.#controllers.delete(key(ctl.container, ctl.paneId));
      this.#notifyClosed(ctl, reason, undefined);
    }
    return Promise.all(ctls.map((c) => this.#release(c))).then(() => {});
  }

  /** Releases every controller (shutdown). */
  releaseAll(): Promise<void> {
    const ctls = [...this.#controllers.values()];
    this.#controllers.clear();
    return Promise.all(ctls.map((c) => this.#release(c))).then(() => {});
  }

  /** `terminal.release`, then stdin closed — never a bare kill (see `proc.ts`). */
  async #release(ctl: Controller): Promise<void> {
    ctl.ending = true;
    await ctl.proc.write(JSON.stringify({ type: 'terminal.release' }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      ctl.proc.status,
      new Promise<void>((r) => (timer = setTimeout(r, RELEASE_GRACE_MS))),
    ]);
    clearTimeout(timer);
    await closeGracefully(ctl.proc, RELEASE_GRACE_MS);
  }
}
