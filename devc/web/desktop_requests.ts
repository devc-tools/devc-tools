// What devc web's page asks devc-desktop to do (`request_push`, `request_project`), held until
// the app reads it (`GET /desktop/requests`) and dismisses it. The page can only ask: the app
// works out the push plan or the start itself, and the user confirms it in its HOST drawer,
// where devc web cannot draw. So a request carries no more than what to look at. See
// `.plans/devc-desktop-host-actions.md`.

/** What a request asks for: a push of one repo, or a project's start, stop or removal. */
export type DesktopRequestKind = 'push' | 'start' | 'stop' | 'down';

export interface DesktopRequest {
  id: string;
  kind: DesktopRequestKind;
  /** The project's folder on this machine, as devc web lists it. */
  localFolder: string;
  /** The repo folder to push (one of the project's repos); `null` for the project kinds. */
  folder: string | null;
  /** When it was asked, in ms since the epoch. */
  at: number;
}

/** What `GET /desktop/requests` answers: every pending request, and the queue's version. */
export interface DesktopRequestsAnswer {
  seq: number;
  requests: DesktopRequest[];
}

/** The most requests pending at once. */
export const MAX_PENDING = 20;
/** How long a request waits for the app before it is dropped. */
export const REQUEST_TTL_MS = 10 * 60_000;
/** The asks allowed per {@link RATE_WINDOW_MS}, repeats of a pending one included. */
export const RATE_LIMIT = 10;
export const RATE_WINDOW_MS = 10_000;
/** The longest a `GET /desktop/requests` waits for a change. */
export const LONG_POLL_MS = 25_000;

/** What the page is told once a request is queued (or already was). */
export const ASKED = 'asked devc-desktop: confirm in the HOST drawer';

/** Controls, bidi overrides and zero-width characters: devc-desktop would refuse to show them. */
const UNSHOWABLE = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/;

export type AddResult = { ok: true; id: string } | {
  ok: false;
  problem: string;
};

/**
 * The pending requests: at most one per kind and folder (asking again answers with the pending
 * one), at most {@link MAX_PENDING} in all, each dropped after {@link REQUEST_TTL_MS} or when the
 * app dismisses it, and at most {@link RATE_LIMIT} asks per {@link RATE_WINDOW_MS}. `seq` goes up
 * on every change, which wakes the app's long poll.
 */
export class DesktopRequests {
  #pending: DesktopRequest[] = [];
  #asks: number[] = [];
  #seq = 0;
  #waiters = new Set<() => void>();
  #closed = false;
  readonly #now: () => number;
  readonly #mintId: () => string;

  constructor(
    opts: { now?: () => number; mintId?: () => string } = {},
  ) {
    this.#now = opts.now ?? Date.now;
    this.#mintId = opts.mintId ?? mintRequestId;
  }

  /** Queues a request, or names why not. */
  add(
    kind: DesktopRequestKind,
    localFolder: string,
    folder: string | null,
  ): AddResult {
    const now = this.#now();
    this.#expire(now);
    this.#asks = this.#asks.filter((t) => now - t < RATE_WINDOW_MS);
    if (this.#asks.length >= RATE_LIMIT) {
      return {
        ok: false,
        problem: 'too many requests to devc-desktop: wait a few seconds',
      };
    }
    this.#asks.push(now);
    if (UNSHOWABLE.test(localFolder) || UNSHOWABLE.test(folder ?? '')) {
      return { ok: false, problem: "the folder's name can't be shown safely" };
    }
    const key = kind === 'push' ? folder : localFolder;
    const same = this.#pending.find((r) =>
      r.kind === kind && (r.kind === 'push' ? r.folder : r.localFolder) === key
    );
    if (same) return { ok: true, id: same.id };
    if (this.#pending.length >= MAX_PENDING) {
      return {
        ok: false,
        problem: `devc-desktop already has ${MAX_PENDING} requests waiting`,
      };
    }
    const id = this.#mintId();
    this.#pending.push({ id, kind, localFolder, folder, at: now });
    this.#changed();
    return { ok: true, id };
  }

  /** Drops a request; `false` when none has that id. */
  dismiss(id: string): boolean {
    const before = this.#pending.length;
    this.#pending = this.#pending.filter((r) => r.id !== id);
    if (this.#pending.length === before) return false;
    this.#changed();
    return true;
  }

  /** The pending requests now, oldest first. */
  list(): DesktopRequestsAnswer {
    this.#expire(this.#now());
    return { seq: this.#seq, requests: this.#pending.map((r) => ({ ...r })) };
  }

  /**
   * The list once `seq` is past `after`, waiting up to `ms` (or until `signal` aborts, or the
   * queue closes) for a change; the list as it is then either way.
   */
  async wait(
    after: number,
    ms = LONG_POLL_MS,
    signal?: AbortSignal,
  ): Promise<DesktopRequestsAnswer> {
    if (this.list().seq !== after || this.#closed) return this.list();
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      // A request expiring while the app waits shows on its next poll.
      const timer = setTimeout(done, Math.min(ms, this.#untilExpiry()));
      this.#waiters.add(done);
      signal?.addEventListener('abort', done);
    });
    return this.list();
  }

  /** Wakes every waiter and answers later waits at once: the server is stopping. */
  close(): void {
    this.#closed = true;
    for (const w of [...this.#waiters]) w();
  }

  #untilExpiry(): number {
    const first = this.#pending[0];
    return first === undefined
      ? Infinity
      : Math.max(0, first.at + REQUEST_TTL_MS - this.#now());
  }

  #expire(now: number): void {
    const kept = this.#pending.filter((r) => now - r.at < REQUEST_TTL_MS);
    if (kept.length === this.#pending.length) return;
    this.#pending = kept;
    this.#changed();
  }

  #changed(): void {
    this.#seq++;
    for (const w of [...this.#waiters]) w();
  }
}

/** A request's id: 16 random hex digits. */
export function mintRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
