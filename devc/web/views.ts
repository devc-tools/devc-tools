// The views of `devc web`'s split pages: a `/sidebar` page and a `/main` page with the same view
// id (the URL hash's `view`) are one view, its sidebar and its tiling area, and the server relays
// `lib/view.js`'s contracts between them (`view_state`, `view_intent`, `sidebar_intent`). This
// module is pure: it keeps who joined which view in which role and each view's last state, and
// says what to send to whom; the server does the sending. Nothing here is persisted. Specified in
// `.plans/devc-web-sidebar-main-routes.md`; tested from `devc/tests/web_views_test.ts`.

import type {
  SidebarIntentName,
  ViewIntentName,
  ViewRole,
} from './protocol.ts';

/** How long a view with no members left keeps its last state: a reloading `/main` page's. */
export const VIEW_IDLE_MS = 10 * 60 * 1000;

/** One message for one member. */
export interface Delivery<M> {
  to: M;
  msg: Record<string, unknown>;
}

interface View<M> {
  members: Map<M, ViewRole>;
  /** The tiling area's last `view_state`, verbatim. */
  state: Record<string, unknown> | null;
  /** When the last member left (`now()`'s), or null while it has members. */
  emptySince: number | null;
}

/** The views by id, with their members (any value standing for a client, e.g. its socket). */
export class ViewRegistry<M> {
  readonly #views = new Map<string, View<M>>();
  /** Each member's one view. */
  readonly #joined = new Map<M, string>();
  readonly #now: () => number;
  readonly #idleMs: number;

  constructor(opts: { now?: () => number; idleMs?: number } = {}) {
    this.#now = opts.now ?? Date.now;
    this.#idleMs = opts.idleMs ?? VIEW_IDLE_MS;
  }

  /**
   * `member` joins `view` as `role`, leaving any view it had joined. A sidebar is sent the view's
   * last state, if any.
   */
  join(member: M, view: string, role: ViewRole): Delivery<M>[] {
    this.leave(member);
    this.#prune();
    let v = this.#views.get(view);
    if (!v) {
      v = { members: new Map(), state: null, emptySince: null };
      this.#views.set(view, v);
    }
    v.members.set(member, role);
    v.emptySince = null;
    this.#joined.set(member, view);
    if (role === 'sidebar' && v.state !== null) {
      return [{
        to: member,
        msg: { type: 'view_state', view, state: v.state },
      }];
    }
    return [];
  }

  /** `member` leaves its view (a closed socket). A view left empty keeps its state a while. */
  leave(member: M): void {
    const view = this.#joined.get(member);
    if (view === undefined) return;
    this.#joined.delete(member);
    const v = this.#views.get(view);
    if (!v) return;
    v.members.delete(member);
    if (v.members.size === 0) v.emptySince = this.#now();
    this.#prune();
  }

  /** A tiling area's state: kept as the view's last, and sent to its sidebars. */
  state(
    member: M,
    view: string,
    state: Record<string, unknown>,
  ): Delivery<M>[] {
    const v = this.#memberOf(member, view, 'tiles');
    if (!v) return [];
    v.state = state;
    return this.#to(v, 'sidebar', { type: 'view_state', view, state });
  }

  /** A sidebar's `ViewIntents` call, sent to the view's tiling areas. */
  viewIntent(
    member: M,
    view: string,
    name: ViewIntentName,
    args: unknown[],
  ): Delivery<M>[] {
    const v = this.#memberOf(member, view, 'sidebar');
    if (!v) return [];
    return this.#to(v, 'tiles', { type: 'view_intent', view, name, args });
  }

  /** A tiling area's `SidebarIntents` call, sent to the view's sidebars. */
  sidebarIntent(
    member: M,
    view: string,
    name: SidebarIntentName,
    args: unknown[],
  ): Delivery<M>[] {
    const v = this.#memberOf(member, view, 'tiles');
    if (!v) return [];
    return this.#to(v, 'sidebar', { type: 'sidebar_intent', view, name, args });
  }

  /** The view ids held now (members, or a last state not yet dropped). */
  views(): string[] {
    this.#prune();
    return [...this.#views.keys()];
  }

  /** The view `member` joined as `role`, when it is `view`; else undefined. */
  #memberOf(member: M, view: string, role: ViewRole): View<M> | undefined {
    if (this.#joined.get(member) !== view) return undefined;
    const v = this.#views.get(view);
    return v?.members.get(member) === role ? v : undefined;
  }

  #to(v: View<M>, role: ViewRole, msg: Record<string, unknown>): Delivery<M>[] {
    const out: Delivery<M>[] = [];
    for (const [m, r] of v.members) {
      if (r === role) out.push({ to: m, msg });
    }
    return out;
  }

  /** Drops the views that have been empty for longer than the idle time. */
  #prune(): void {
    const now = this.#now();
    for (const [id, v] of this.#views) {
      if (v.emptySince !== null && now - v.emptySince >= this.#idleMs) {
        this.#views.delete(id);
      }
    }
  }
}
