// The views of `devc web`'s split pages: a `/sidebar` page, a `/main` page and a `/containers`
// page with the same view id (the URL hash's `view`) are one view, its sidebar, its tiling area
// and its Containers section, and the server relays `lib/view.js`'s contracts between them
// (`view_state`, `view_intent`, `sidebar_intent`, `containers_intent`, `inuse_intent`). This
// module is pure: it keeps who joined which view in which role and each view's last state, and
// says what to send to whom; the server does the sending. Nothing here is persisted. Specified in
// `.plans/archived/devc-web-sidebar-main-routes.md`,
// `.plans/archived/devc-web-containers-module.md` and `.plans/devc-web-cross-page-drag.md`;
// tested from `devc/tests/web_views_test.ts`.

import type {
  ContainersIntentName,
  InUseIntentName,
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
  /** A sidebar's last In use cards (`inUse`, `pinned`), sent with the state to Containers. */
  inUse: { inUse: unknown; pinned: unknown } | null;
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
   * last state, if any; a Containers section the last state with In use's cards, if either.
   */
  join(member: M, view: string, role: ViewRole): Delivery<M>[] {
    this.leave(member);
    this.#prune();
    let v = this.#views.get(view);
    if (!v) {
      v = { members: new Map(), state: null, inUse: null, emptySince: null };
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
    if (role === 'containers' && (v.state !== null || v.inUse !== null)) {
      return [{
        to: member,
        msg: { type: 'view_state', view, state: withInUse(v) },
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

  /**
   * A `view_state`. A tiling area's is kept as the view's last state, and sent to its sidebars,
   * and with In use's cards to its Containers sections. A sidebar's carries only In use's cards
   * (`inUse`, `pinned`): kept, and sent with the last state to the Containers sections. Anyone
   * else's, a tiling area's without `tiles` or a sidebar's without `inUse`, is ignored.
   */
  state(
    member: M,
    view: string,
    state: Record<string, unknown>,
  ): Delivery<M>[] {
    const tiles = this.#memberOf(member, view, 'tiles');
    if (tiles) {
      // In use's cards alone are a sidebar's to send.
      if (!Array.isArray(state.tiles)) return [];
      const { inUse: _inUse, pinned: _pinned, ...own } = state;
      tiles.state = own;
      return [
        ...this.#to(tiles, 'sidebar', { type: 'view_state', view, state: own }),
        ...this.#to(tiles, 'containers', {
          type: 'view_state',
          view,
          state: withInUse(tiles),
        }),
      ];
    }
    const sidebar = this.#memberOf(member, view, 'sidebar');
    if (!sidebar || !Array.isArray(state.inUse)) return [];
    sidebar.inUse = { inUse: state.inUse, pinned: state.pinned ?? [] };
    return this.#to(sidebar, 'containers', {
      type: 'view_state',
      view,
      state: withInUse(sidebar),
    });
  }

  /** A sidebar's or a Containers section's `ViewIntents` call, sent to the view's tiling areas. */
  viewIntent(
    member: M,
    view: string,
    name: ViewIntentName,
    args: unknown[],
  ): Delivery<M>[] {
    const v = this.#memberOf(member, view, 'sidebar') ??
      this.#memberOf(member, view, 'containers');
    if (!v) return [];
    return this.#to(v, 'tiles', { type: 'view_intent', view, name, args });
  }

  /**
   * A sidebar's `ContainersIntents` call (In use → Containers), sent to the view's Containers
   * sections.
   */
  containersIntent(
    member: M,
    view: string,
    name: ContainersIntentName,
    args: unknown[],
  ): Delivery<M>[] {
    const v = this.#memberOf(member, view, 'sidebar');
    if (!v) return [];
    return this.#to(v, 'containers', {
      type: 'containers_intent',
      view,
      name,
      args,
    });
  }

  /** A Containers section's `InUseLink` call (Containers → In use), sent to the view's sidebars. */
  inUseIntent(
    member: M,
    view: string,
    name: InUseIntentName,
    args: unknown[],
  ): Delivery<M>[] {
    const v = this.#memberOf(member, view, 'containers');
    if (!v) return [];
    return this.#to(v, 'sidebar', { type: 'inuse_intent', view, name, args });
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

/**
 * The view's state as a Containers section takes it: the tiling area's last (no tiles before any)
 * with In use's cards, when a sidebar has sent them.
 */
function withInUse<M>(v: View<M>): Record<string, unknown> {
  return {
    ...(v.state ?? { tiles: [], tree: null, focused: null }),
    ...(v.inUse ?? {}),
  };
}
