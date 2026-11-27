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

/** The primary tiling area's main id: a `/main` page's when its hash names none. */
export const PRIMARY_MAIN = 'main';

/** The intents whose first argument is a tile (or node) id: routed to the main that has it. */
const BY_ID: ReadonlySet<ViewIntentName> = new Set([
  'reveal',
  'close',
  'keepOpen',
  'save',
  'reload',
  'askAgent',
  'restartLanguage',
  'languageSettings',
  'revealLine',
]);

/** The merged tree's root id, when several mains have a tree: no tiling area has it. */
const WINDOWS_ROOT = 'windows';

interface Member {
  role: ViewRole;
  /** A tiling area's main id; {@link PRIMARY_MAIN} for every other role. */
  main: string;
}

interface View<M> {
  members: Map<M, Member>;
  /**
   * Each main's last `view_state`, verbatim, in join order. The primary's is kept after its
   * members leave (a reloading `/main`); an extra main's goes with its last member.
   */
  mains: Map<string, Record<string, unknown> | null>;
  /** The main the view's untargeted opens go to: the one that sent the latest `view_focus`. */
  target: string;
  /**
   * A sidebar's last In use cards (`inUse`, `pinned`) and filter box text (`filter`), sent with
   * the state to Containers.
   */
  inUse: { inUse: unknown; pinned: unknown; filter: string } | null;
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
   * `member` joins `view` as `role` (a tiling area as main `main`, the primary by default),
   * leaving any view it had joined. A sidebar is sent the view's last state, if any; a Containers
   * section the last state with In use's cards, if either. What its leave changed for the view
   * it left is sent too.
   */
  join(
    member: M,
    view: string,
    role: ViewRole,
    main: string = PRIMARY_MAIN,
  ): Delivery<M>[] {
    const out = this.leave(member);
    this.#prune();
    let v = this.#views.get(view);
    if (!v) {
      v = {
        members: new Map(),
        mains: new Map(),
        target: PRIMARY_MAIN,
        inUse: null,
        emptySince: null,
      };
      this.#views.set(view, v);
    }
    const own = role === 'tiles' ? main : PRIMARY_MAIN;
    v.members.set(member, { role, main: own });
    if (role === 'tiles' && !v.mains.has(own)) v.mains.set(own, null);
    v.emptySince = null;
    this.#joined.set(member, view);
    const state = merged(v);
    if (role === 'sidebar' && state !== null) {
      out.push({ to: member, msg: { type: 'view_state', view, state } });
    }
    if (role === 'containers' && (state !== null || v.inUse !== null)) {
      out.push({
        to: member,
        msg: { type: 'view_state', view, state: withInUse(v) },
      });
    }
    return out;
  }

  /**
   * `member` leaves its view (a closed socket). A view left empty keeps its state a while. An
   * extra main left with no members is dropped, and the view's sidebars and Containers sections
   * are sent the state without it.
   */
  leave(member: M): Delivery<M>[] {
    const view = this.#joined.get(member);
    if (view === undefined) return [];
    this.#joined.delete(member);
    const v = this.#views.get(view);
    if (!v) return [];
    const was = v.members.get(member);
    v.members.delete(member);
    let out: Delivery<M>[] = [];
    if (was?.role === 'tiles' && !this.#hasMain(v, was.main)) {
      if (was.main !== PRIMARY_MAIN) {
        const hadState = v.mains.get(was.main) != null;
        v.mains.delete(was.main);
        if (hadState) out = this.#stateOut(v, view);
      }
      if (v.target === was.main) {
        const before = v.target;
        v.target = this.#fallbackTarget(v);
        if (out.length === 0 && v.target !== before) {
          out = this.#stateOut(v, view);
        }
      }
    }
    if (v.members.size === 0) v.emptySince = this.#now();
    this.#prune();
    return out;
  }

  /**
   * A `view_state`. A tiling area's is kept as its main's last state, and the view's merged state
   * sent to its sidebars, and with In use's cards to its Containers sections. A sidebar's carries
   * only In use's cards (`inUse`, `pinned`) and its filter (`filter`): kept, and sent with the
   * last state to the Containers sections. Anyone else's, a tiling area's without `tiles` or a
   * sidebar's without `inUse`, is ignored.
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
      const { inUse: _inUse, pinned: _pinned, filter: _filter, ...own } = state;
      tiles.v.mains.set(tiles.main, own);
      return this.#stateOut(tiles.v, view);
    }
    const sidebar = this.#memberOf(member, view, 'sidebar');
    if (!sidebar || !Array.isArray(state.inUse)) return [];
    sidebar.v.inUse = {
      inUse: state.inUse,
      pinned: state.pinned ?? [],
      filter: typeof state.filter === 'string' ? state.filter : '',
    };
    return this.#to(sidebar.v, 'containers', {
      type: 'view_state',
      view,
      state: withInUse(sidebar.v),
    });
  }

  /**
   * A tiling area's `view_focus`: its main becomes the view's target, and the merged state, whose
   * `focused` and `outline` are the target's, goes out again when that changed it.
   */
  focus(member: M, view: string): Delivery<M>[] {
    const tiles = this.#memberOf(member, view, 'tiles');
    if (!tiles || tiles.v.target === tiles.main) return [];
    tiles.v.target = tiles.main;
    return this.#stateOut(tiles.v, view);
  }

  /**
   * A sidebar's or a Containers section's `ViewIntents` call, sent to the view's tiling areas:
   * one naming a tile to the main that has it (its id unprefixed), `openPane` with `at` likewise,
   * the other opens to the target main, `prViewed` to every main.
   */
  viewIntent(
    member: M,
    view: string,
    name: ViewIntentName,
    args: unknown[],
  ): Delivery<M>[] {
    const m = this.#memberOf(member, view, 'sidebar') ??
      this.#memberOf(member, view, 'containers');
    if (!m) return [];
    const v = m.v;
    const send = (main: string | null, a: unknown[]) =>
      this.#to(v, 'tiles', { type: 'view_intent', view, name, args: a }, main);
    if (name === 'prViewed') return send(null, args);
    if (BY_ID.has(name)) {
      if (typeof args[0] !== 'string' || args[0] === WINDOWS_ROOT) return [];
      const { main, id } = this.#splitId(v, args[0]);
      return send(main, [id, ...args.slice(1)]);
    }
    if (name === 'openPane') {
      const opts = args[1];
      if (
        typeof opts === 'object' && opts !== null &&
        typeof (opts as { at?: unknown }).at === 'string'
      ) {
        const at = (opts as { at: string }).at;
        if (at === WINDOWS_ROOT) {
          return send(v.target, [args[0], { ...opts, at: null }]);
        }
        const { main, id } = this.#splitId(v, at);
        return send(main, [args[0], { ...opts, at: id }, ...args.slice(2)]);
      }
    }
    return send(v.target, args);
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
    const v = this.#memberOf(member, view, 'sidebar')?.v;
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
    const v = this.#memberOf(member, view, 'containers')?.v;
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
    const v = this.#memberOf(member, view, 'tiles')?.v;
    if (!v) return [];
    return this.#to(v, 'sidebar', { type: 'sidebar_intent', view, name, args });
  }

  /** The view ids held now (members, or a last state not yet dropped). */
  views(): string[] {
    this.#prune();
    return [...this.#views.keys()];
  }

  /** The view `member` joined as `role` (and its main), when it is `view`; else undefined. */
  #memberOf(
    member: M,
    view: string,
    role: ViewRole,
  ): { v: View<M>; main: string } | undefined {
    if (this.#joined.get(member) !== view) return undefined;
    const v = this.#views.get(view);
    const m = v?.members.get(member);
    return v && m?.role === role ? { v, main: m.main } : undefined;
  }

  /** `msg` for each member in `role` (of main `main` only, when given). */
  #to(
    v: View<M>,
    role: ViewRole,
    msg: Record<string, unknown>,
    main: string | null = null,
  ): Delivery<M>[] {
    const out: Delivery<M>[] = [];
    for (const [m, r] of v.members) {
      if (r.role === role && (main === null || r.main === main)) {
        out.push({ to: m, msg });
      }
    }
    return out;
  }

  /** The merged state to the view's sidebars, and with In use's cards to its Containers. */
  #stateOut(v: View<M>, view: string): Delivery<M>[] {
    const state = merged(v);
    if (state === null) return [];
    return [
      ...this.#to(v, 'sidebar', { type: 'view_state', view, state }),
      ...this.#to(v, 'containers', {
        type: 'view_state',
        view,
        state: withInUse(v),
      }),
    ];
  }

  #hasMain(v: View<M>, main: string): boolean {
    for (const r of v.members.values()) {
      if (r.role === 'tiles' && r.main === main) return true;
    }
    return false;
  }

  /** The primary when joined, else the main joined last, else the primary. */
  #fallbackTarget(v: View<M>): string {
    if (this.#hasMain(v, PRIMARY_MAIN)) return PRIMARY_MAIN;
    let last = PRIMARY_MAIN;
    for (const r of v.members.values()) if (r.role === 'tiles') last = r.main;
    return last;
  }

  /**
   * A relayed id's main and its own id: `M:<id>` with `M` an extra main of the view is `M`'s
   * `<id>`; anything else is the primary's, unchanged.
   */
  #splitId(v: View<M>, id: string): { main: string; id: string } {
    const at = id.indexOf(':');
    if (at > 0) {
      const main = id.slice(0, at);
      if (main !== PRIMARY_MAIN && this.#hasMain(v, main)) {
        return { main, id: id.slice(at + 1) };
      }
    }
    return { main: PRIMARY_MAIN, id };
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
 * The view's state as a Containers section takes it: the merged state (no tiles before any) with
 * In use's cards, when a sidebar has sent them.
 */
function withInUse<M>(v: View<M>): Record<string, unknown> {
  return {
    ...(merged(v) ?? { tiles: [], tree: null, focused: null }),
    ...(v.inUse ?? {}),
  };
}

/**
 * The view's tiling state as its sidebars see it: with only the primary's (every page before
 * tile windows), that state verbatim. Otherwise each main's tiles, the primary's first, an extra
 * main `M`'s ids prefixed `M:` and its tiles marked `window: M`; the trees under one `windows`
 * row when several have one; `focused` and `outline` the target main's. Null with no state yet.
 */
function merged<M>(v: View<M>): Record<string, unknown> | null {
  const extras = [...v.mains].filter(([main, s]) =>
    main !== PRIMARY_MAIN && s !== null
  ) as [string, Record<string, unknown>][];
  const primary = v.mains.get(PRIMARY_MAIN) ?? null;
  if (extras.length === 0) return primary;
  const parts: [string, Record<string, unknown>][] = [
    ...(primary
      ? [[PRIMARY_MAIN, primary] as [string, Record<string, unknown>]]
      : []),
    ...extras,
  ];
  const tiles: unknown[] = [];
  const trees: unknown[] = [];
  let focused: unknown = null;
  let outline: unknown = null;
  for (const [main, s] of parts) {
    const id = (x: unknown) =>
      main === PRIMARY_MAIN || typeof x !== 'string' ? x : `${main}:${x}`;
    for (const t of Array.isArray(s.tiles) ? s.tiles : []) {
      if (typeof t !== 'object' || t === null) continue;
      const tile = t as Record<string, unknown>;
      tiles.push(
        main === PRIMARY_MAIN
          ? tile
          : { ...tile, id: id(tile.id), window: main },
      );
    }
    if (s.tree != null) trees.push(prefixTree(s.tree, id));
    if (main === v.target) {
      focused = id(s.focused ?? null);
      const o = s.outline;
      outline = typeof o === 'object' && o !== null
        ? { ...o, tile: id((o as Record<string, unknown>).tile) }
        : null;
    }
  }
  const tree = trees.length === 0
    ? null
    : trees.length === 1
    ? trees[0]
    : { kind: 'row', id: WINDOWS_ROOT, children: trees };
  return { tiles, tree, focused, outline };
}

/** A layout tree with every node's id passed through `id`. */
function prefixTree(node: unknown, id: (x: unknown) => unknown): unknown {
  if (typeof node !== 'object' || node === null) return node;
  const n = node as Record<string, unknown>;
  return {
    ...n,
    id: id(n.id),
    ...(Array.isArray(n.children)
      ? { children: n.children.map((c) => prefixTree(c, id)) }
      : {}),
  };
}
