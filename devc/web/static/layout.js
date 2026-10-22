// The `devc web` tiling area: browser-owned window management on Golden Layout. The only module
// that imports Golden Layout, so replacing it is a change to this file alone (the same boundary
// `renderer.js` draws around xterm.js). See `.plans/devc-web-golden-layout.md`.
//
// Vocabulary: a *tile* is one Golden Layout component showing at most one Herdr pane (a pane
// tile) or one project file (a file tile, see `viewer.js`); tiles sit in *stacks* (Golden Layout's tab groups), inside rows and columns. None of this is Herdr's
// layout — a Herdr tab is a different thing, and nothing here ever changes it.

import {
  GoldenLayout,
  ItemConfig,
  LayoutConfig,
  ResolvedItemConfig,
} from './vendor/golden-layout/golden-layout.mjs';
import {
  diffRefFromState,
  fileRefFromState,
  paneRefFromState,
  previewFromState,
  tileContent,
} from './lib/layout_state.js';

/**
 * The component types: `pane`, whose state is a PaneRef (or `{}` for an empty tile), `file`,
 * whose state is a FileRef, and `diff`, whose state is a DiffRef (a pull request file); any of
 * them with `preview: true` on a preview tile.
 */
const COMPONENT_TYPES = /** @type {const} */ (['pane', 'file', 'diff']);

/** @typedef {import('./lib/layout_state.js').PaneRef} PaneRef */
/** @typedef {import('./lib/layout_state.js').FileRef} FileRef */
/** @typedef {import('./lib/layout_state.js').DiffRef} DiffRef */
/** What a new tile shows: a pane, a file, a PR file's diff, or nothing (an empty pane tile). */
/** @typedef {PaneRef | {file: FileRef} | {diff: DiffRef} | null} TileRef */
/** @typedef {import('./lib/layout_state.js').LayoutNode} LayoutNode */

/**
 * @typedef {object} Tile
 * @property {string} id                 stable for the tile's lifetime
 * @property {'pane' | 'file' | 'diff'} kind  a pane tile (a terminal), a file tile (a viewer)
 *   or a diff tile (a pull request file)
 * @property {PaneRef | null} ref        the pane this tile shows; always null on other tiles
 * @property {FileRef | null} file       the file a file tile shows; null on other tiles
 * @property {DiffRef | null} diff       the PR file a diff tile shows; null on other tiles
 * @property {HTMLElement} element       where app.js mounts the renderer and overlay
 * @property {(ref: PaneRef | null) => void} setRef   persists into the component state (pane tiles)
 * @property {boolean} preview           a preview tile: the next sidebar click replaces what it
 *   shows; its tab title is italic. Saved with the layout.
 * @property {(on: boolean) => void} setPreview  persists into the component state
 * @property {(title: string, muted?: string) => void} setTitle  `muted` follows the title, muted
 * @property {(text: string) => void} setTooltip  the tab's tooltip (default: the title)
 * @property {(el: Node | null) => void} setBadge     agent badge shown in the tile's tab
 * @property {(el: Node | null) => void} setActions   buttons last in the tile's tab, left of its ×
 * @property {(el: Node | null) => void} setContext   where the tile is (repo, branch, container),
 *   after its title in the tab
 * @property {() => void} focus
 */

/**
 * @typedef {object} TilingHooks
 * @property {(tile: Tile) => void} mount     a tile was created (also on restore)
 * @property {(tile: Tile) => void} unmount   a tile is about to be destroyed
 * @property {(tile: Tile, visible: boolean) => void} visibility  its stack tab was hidden/shown
 * @property {(tile: Tile | null) => void} focused
 * @property {() => void} changed             the layout changed: persist it
 * @property {(tile: Tile, e: MouseEvent) => void} tileMenu   right-click on a tile's header tab
 * @property {(stackId: string, e: MouseEvent) => void} stackMenu  right-click on a stack
 *   header's empty area
 * @property {(tile: Tile) => void} tabDoubleClick  double-click on a tile's header tab
 */

/** Settings and header controls: no popouts (each window would need its own WebSocket). */
const SETTINGS = {
  constrainDragToContainer: true,
  reorderEnabled: true,
  showPopoutIcon: false,
  showMaximiseIcon: true,
  showCloseIcon: true,
};
const HEADER = { popout: false };
/** A tile header's height in px, whatever a saved layout says (style.css lays the header out for it). */
const HEADER_HEIGHT = 29;

/**
 * The page's custom property `name` (style.css's `:root`) in px, or `fallback` when it is unset
 * or not a px length.
 *
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function cssPx(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(
    name,
  ).trim();
  const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
  return px ? Number(px[1]) : fallback;
}

/** The gap between tiles in px: style.css's `--tile-gap`, whatever a saved layout says. */
function borderWidth() {
  return cssPx('--tile-gap', 10);
}

/** An empty layout carrying our settings. */
function emptyConfig() {
  return {
    settings: SETTINGS,
    header: HEADER,
    dimensions: { headerHeight: HEADER_HEIGHT, borderWidth: borderWidth() },
    root: undefined,
  };
}

let nextTileId = 0;
let nextNodeId = 0;

/**
 * Mounts the tiling area into `root`.
 *
 * @param {HTMLElement} root
 * @param {TilingHooks} hooks
 */
export function createTiling(root, hooks) {
  const layout = new GoldenLayout(root);
  layout.resizeWithContainerAutomatically = true;

  /** @type {Map<object, Tile>} by ComponentContainer */
  const byContainer = new Map();
  /** @type {Map<Tile, Node | null>} each tile's badge, re-applied when its tab is rebuilt */
  const badges = new Map();
  /** @type {Map<Tile, Node | null>} */
  const contexts = new Map();
  /** @type {Map<Tile, Node | null>} each tile's tab buttons, the same way */
  const actions = new Map();
  /** @type {Map<Tile, string>} each tile's tooltip, re-applied the same way */
  const tooltips = new Map();
  /** @type {Map<Tile, {title: string, muted: string}>} titles with a muted part, the same way */
  const splitTitles = new Map();
  /** @type {Map<string, any>} ComponentContainer by Tile.id */
  const containerById = new Map();
  /**
   * Runtime ids of rows, columns and stacks, by content item. Not Golden Layout's own `id`
   * config field: that one is saved with the layout.
   * @type {WeakMap<object, string>}
   */
  const nodeIds = new WeakMap();

  /** @returns {string} */
  const nodeId = (item) => {
    let id = nodeIds.get(item);
    if (id === undefined) {
      id = `n${++nextNodeId}`;
      nodeIds.set(item, id);
    }
    return id;
  };

  /**
   * Puts `tile`'s context, badge, tooltip, muted title part and preview styling into its current tab
   * element (tabs are recreated on moves, and a title change resets the tooltip).
   */
  const applyBadge = (container, tile) => {
    const tab = container.tab;
    if (!tab) return;
    // app.js finds the tile a tab's × closes by it.
    tab.element.dataset.tile = tile.id;
    tab.element.classList.toggle('tile-preview', tile.preview);
    // Golden Layout writes the title as plain text, muted part and all: the title element keeps
    // the label, and after it come the context, the muted part (the first to give way when the
    // tab is short of room) and the badge.
    const split = splitTitles.get(tile);
    if (split) tab.titleElement.textContent = split.title;
    for (
      const old of tab.element.querySelectorAll(
        ':scope > :is(.tile-context, .tile-title-muted, .tile-badge, .tile-actions)',
      )
    ) old.remove();
    const tooltip = tooltips.get(tile);
    if (tooltip !== undefined) tab.element.title = tooltip;
    /** @type {HTMLElement} */
    let last = tab.titleElement;
    const place = (className, content) => {
      const el = document.createElement('span');
      el.className = className;
      el.append(content);
      last.after(el);
      last = el;
    };
    const context = contexts.get(tile);
    if (context) place('tile-context', context);
    if (split) place('tile-title-muted', split.muted);
    const badge = badges.get(tile);
    if (badge) place('tile-badge', badge);
    const buttons = actions.get(tile);
    if (buttons) place('tile-actions', buttons);
  };

  for (const type of COMPONENT_TYPES) {
    layout.registerComponentFactoryFunction(type, (container, state) => {
      const file = type === 'file' ? fileRefFromState(state) : null;
      const diff = type === 'diff' ? diffRefFromState(state) : null;
      /** @type {Tile} */
      const tile = {
        id: `t${++nextTileId}`,
        kind: type,
        ref: type === 'pane' ? paneRefFromState(state) : null,
        file,
        diff,
        preview: previewFromState(state),
        element: container.element,
        setRef(ref) {
          if (tile.kind !== 'pane') return;
          tile.ref = ref;
          container.setState(tileContent(ref, tile.preview).state);
        },
        setPreview(on) {
          if (tile.preview === on) return;
          tile.preview = on;
          container.setState(
            tileContent(
              tile.file
                ? { file: tile.file }
                : tile.diff
                ? { diff: tile.diff }
                : tile.ref,
              on,
            ).state,
          );
          applyBadge(container, tile);
        },
        setTitle(title, muted = '') {
          if (muted) splitTitles.set(tile, { title, muted });
          else splitTitles.delete(tile);
          const text = muted ? `${title} · ${muted}` : title;
          if (container.title !== text) {
            container.setTitle(text);
            applyBadge(container, tile);
          }
        },
        setTooltip(text) {
          tooltips.set(tile, text);
          applyBadge(container, tile);
        },
        setBadge(el) {
          badges.set(tile, el);
          applyBadge(container, tile);
        },
        setActions(el) {
          if (actions.get(tile) === el) return;
          actions.set(tile, el);
          applyBadge(container, tile);
          container.parent?.parentItem?.header?.updateTabSizes();
        },
        setContext(el) {
          const changed = contexts.get(tile)?.textContent !== el?.textContent;
          contexts.set(tile, el);
          applyBadge(container, tile);
          // A new context widens or narrows the tab: Golden Layout measured it without, and
          // would otherwise leave a sibling tab in its dropdown until the next resize.
          if (changed) container.parent?.parentItem?.header?.updateTabSizes();
        },
        focus() {
          container.focus();
        },
      };
      byContainer.set(container, tile);
      containerById.set(tile.id, container);
      container.on('show', () => hooks.visibility(tile, true));
      container.on('hide', () => hooks.visibility(tile, false));
      container.on('beforeComponentRelease', () => {
        byContainer.delete(container);
        containerById.delete(tile.id);
        badges.delete(tile);
        contexts.delete(tile);
        actions.delete(tile);
        tooltips.delete(tile);
        splitTitles.delete(tile);
        hooks.unmount(tile);
      });
      hooks.mount(tile);
      return undefined;
    });
  }

  layout.on('tabCreated', (tab) => {
    const container = tab.componentItem?.container;
    const tile = container && byContainer.get(container);
    if (!tile) return;
    queueMicrotask(() => applyBadge(container, tile));
    // Tabs are rebuilt on every move, and each new one fires this again.
    tab.element.addEventListener(
      'contextmenu',
      (/** @type {MouseEvent} */ e) => {
        e.preventDefault();
        hooks.tileMenu(tile, e);
      },
    );
    tab.element.addEventListener('dblclick', () => hooks.tabDoubleClick(tile));
  });
  // A tile dragged to a new place (its tab, or a sidebar row) was placed on purpose: it stays.
  layout.on('itemDropped', (item) => {
    const tile = item?.container && byContainer.get(item.container);
    tile?.setPreview(false);
    // Golden Layout's drop zones include the stacks under zen mode's: the dropped tile is shown.
    if (tile && zenOn) item.focus();
  });
  // A right-click on a stack header outside its tabs (tabs handle their own, above).
  root.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;
    const target = /** @type {HTMLElement} */ (e.target);
    const header = target.closest?.('.lm_header');
    if (!header || target.closest('.lm_tab')) return;
    const stack = allItems().find((item) =>
      item.isStack && item.header?.element === header
    );
    if (!stack) return;
    e.preventDefault();
    hooks.stackMenu(nodeId(stack), e);
  });
  layout.on('focus', () => {
    syncZen();
    hooks.focused(focusedTile());
  });
  layout.on('stateChanged', () => {
    // A drop, a close or a new tile may have moved the focused tile out of the zen stack.
    if (zenOn) queueMicrotask(syncZen);
    hooks.changed();
  });

  /*
   * Zen mode: the focused tile's stack maximised, its header hidden, so the focused tile fills
   * the tiling area alone with no chrome. It follows the focus to another stack.
   */
  let zenOn = false;
  /** The stack zen mode maximised; null when none. */
  let zenStack = null;

  /**
   * Golden Layout can't hide a stack's header once it is built: its header's own flag, which
   * the stack's sizing reads (the header takes no height while it is off), is set directly.
   */
  const showHeader = (stack, show) => {
    stack.header._show = show;
    stack.element.classList.toggle('tile-zen', !show);
  };

  const leaveZenStack = () => {
    const stack = zenStack;
    if (!stack) return;
    zenStack = null;
    showHeader(stack, true);
    if (stack.isMaximised) stack.minimise();
    else if (stack.element.isConnected) stack.updateSize(false);
  };

  /** Puts zen mode on the focused tile's stack (or off, while it is off). */
  function syncZen() {
    if (!zenOn) {
      leaveZenStack();
      return;
    }
    const component = layout.focusedComponentItem ??
      layout.maximisedStack?.getActiveComponentItem() ??
      allItems().find((item) => item.isComponent);
    const stack = component?.parentItem;
    if (!stack?.isStack) {
      leaveZenStack();
      return;
    }
    if (stack === zenStack && stack.isMaximised) return;
    leaveZenStack();
    zenStack = stack;
    showHeader(stack, false);
    if (stack.isMaximised) stack.updateSize(true);
    else stack.maximise();
  }

  /** @returns {Tile | null} */
  function focusedTile() {
    const item = layout.focusedComponentItem;
    return (item && byContainer.get(item.container)) ?? null;
  }

  /** Every row, column, stack and component in the layout, depth first. */
  function allItems() {
    const out = [];
    const walk = (item) => {
      out.push(item);
      for (const child of item.contentItems ?? []) walk(child);
    };
    if (layout.rootItem) walk(layout.rootItem);
    return out;
  }

  /** The row, column or stack with runtime id `id`, or the component showing tile `id`. */
  function itemById(id) {
    const container = containerById.get(id);
    if (container) return container.parent;
    return allItems().find((item) => nodeIds.get(item) === id) ?? null;
  }

  /** @returns {LayoutNode | null} */
  function toNode(item) {
    if (item.isComponent) {
      const tile = byContainer.get(item.container);
      if (!tile) return null;
      return {
        kind: 'tile',
        id: tile.id,
        active: item.parentItem?.getActiveComponentItem?.() === item,
      };
    }
    if (!item.isStack && !item.isRow && !item.isColumn) return null;
    return {
      kind: item.isStack ? 'stack' : item.isRow ? 'row' : 'column',
      id: nodeId(item),
      children: item.contentItems.map(toNode).filter((n) => n !== null),
    };
  }

  /** @param {TileRef} ref @param {string} title @param {boolean} [preview] */
  const itemConfig = (ref, title, preview = false) => {
    const { type, state } = tileContent(ref, preview);
    return {
      type: 'component',
      componentType: type,
      componentState: state,
      title,
    };
  };

  layout.loadLayout(emptyConfig());

  return {
    /**
     * A new tile, in the focused stack when there is one, else wherever Golden Layout's default
     * location selectors put it (the root, for an empty layout).
     *
     * @param {TileRef} ref
     * @param {{preview?: boolean}} [opts]  create it as a preview tile
     * @returns {Tile}
     */
    add(ref, opts = {}) {
      const { type, state } = tileContent(ref, opts.preview);
      const item = layout.newComponent(type, state, '');
      const tile = byContainer.get(item.container);
      item.focus();
      return /** @type {Tile} */ (tile);
    },

    /**
     * Makes `el` draggable into the layout; a drop creates a tile for `ref()` (a pane, or
     * `{file}` for a file tile). `title()` names the drag preview (app.js keeps the tile's title
     * current once it is placed).
     *
     * @param {HTMLElement} el
     * @param {() => PaneRef | {file: FileRef}} ref
     * @param {() => string} [title]
     * @returns {() => void} unregisters the drag source
     */
    dragSource(el, ref, title = () => '') {
      const source = layout.newDragSource(
        el,
        () => itemConfig(ref(), title()),
      );
      return () => layout.removeDragSource(source);
    },

    /**
     * A new tile showing `ref` (a pane, `{file}`, or null for an empty tile), placed relative to the item with id `id`:
     * - a tile: 'right' / 'below' split beside its stack (inserting into the parent row or
     *   column when its direction matches, else wrapping the stack in a new one, as a drop on
     *   the stack's edge would); 'stack' adds it to the tile's stack;
     * - a stack: the same, relative to that stack;
     * - a row or column: a new stack at its end (`where` ignored).
     * `id` null (or unknown) behaves like `add(ref)`. The new tile is focused.
     *
     * @param {string | null} id
     * @param {TileRef} ref
     * @param {'right' | 'below' | 'stack'} where
     * @param {{preview?: boolean}} [opts]  create it as a preview tile
     * @returns {Tile}
     */
    addBeside(id, ref, where, opts = {}) {
      const target = id === null ? null : itemById(id);
      if (!target) return this.add(ref, opts);
      // A maximised stack sits outside its place in the tree: put it back before moving things.
      leaveZenStack();
      const config = itemConfig(ref, '', opts.preview);
      let component;
      if (target.isRow || target.isColumn) {
        const index = target.addItem(
          { type: 'stack', content: [config] },
          undefined,
        );
        component = target.contentItems[index].contentItems[0];
      } else {
        const stack = target.isStack ? target : target.parentItem;
        if (where === 'stack') {
          component = stack.newComponent(
            config.componentType,
            config.componentState,
            '',
          );
        } else {
          const type = where === 'right' ? 'row' : 'column';
          const parent = stack.parent;
          const newStack = layout.createAndInitContentItem(
            ItemConfig.resolve({ type: 'stack', content: [config] }, false),
            parent,
          );
          if (parent.type === type) {
            const index = parent.contentItems.indexOf(stack);
            parent.addChild(newStack, index + 1);
          } else {
            const rowOrColumn = layout.createContentItem(
              ResolvedItemConfig.createDefault(type),
              stack,
            );
            parent.replaceChild(stack, rowOrColumn);
            rowOrColumn.addChild(stack, 0, true);
            rowOrColumn.addChild(newStack, undefined, true);
            stack.size = 50;
            newStack.size = 50;
            rowOrColumn.updateSize(false);
          }
          component = newStack.contentItems[0];
        }
      }
      const tile = byContainer.get(component.container);
      component.parentItem.setActiveComponentItem(component, true);
      syncZen();
      hooks.changed();
      return /** @type {Tile} */ (tile);
    },

    /**
     * Swaps tile `tileId` for a new tile showing `ref`, in the same stack and position, keeping
     * its preview flag: for content of another kind (a pane where a file was), which a tile can't
     * switch to in place. The new tile is focused. `null` for an unknown id.
     *
     * @param {string} tileId
     * @param {TileRef} ref
     * @returns {Tile | null}
     */
    replace(tileId, ref) {
      const container = containerById.get(tileId);
      const component = container?.parent;
      const stack = component?.parentItem;
      if (!stack) return null;
      const old = byContainer.get(container);
      const index = stack.contentItems.indexOf(component);
      const config = itemConfig(ref, '', old?.preview ?? false);
      const added = stack.newComponent(
        config.componentType,
        config.componentState,
        '',
        index + 1,
      );
      component.close();
      stack.setActiveComponentItem(added, true);
      hooks.changed();
      return byContainer.get(added.container) ?? null;
    },

    /** Brings tile `tileId` to the front of its stack and focuses it. No-op for an unknown id. */
    reveal(tileId) {
      const component = containerById.get(tileId)?.parent;
      if (!component) return;
      component.parentItem.setActiveComponentItem(component, true);
    },

    /** Closes a tile, or a whole stack, row or column, by id. */
    close(id) {
      const item = itemById(id);
      if (!item) return;
      if (item.isComponent) item.close();
      else item.remove();
    },

    /** @returns {LayoutNode | null} the unfolded tree (app.js folds it) */
    tree() {
      return layout.rootItem ? toNode(layout.rootItem) : null;
    },

    /** @returns {unknown} a JSON-serializable LayoutConfig */
    save() {
      return LayoutConfig.fromResolved(layout.saveLayout());
    },

    /**
     * Replaces the layout with `saved`. `false` (and an empty layout) when it is unusable.
     *
     * @param {unknown} saved
     * @returns {boolean}
     */
    load(saved) {
      // The old layout's stacks go with it.
      zenStack = null;
      try {
        layout.loadLayout({
          .../** @type {object} */ (saved),
          settings: SETTINGS,
          header: HEADER,
          dimensions: {
            .../** @type {any} */ (saved)?.dimensions,
            headerHeight: HEADER_HEIGHT,
            borderWidth: borderWidth(),
          },
        });
        syncZen();
        return true;
      } catch {
        try {
          layout.loadLayout(emptyConfig());
        } catch { /* nothing more to try */ }
        return false;
      }
    },

    /**
     * Turns zen mode on or off: the focused tile alone, filling the tiling area with no header
     * (its stack maximised); it follows the focus. The layout under it is kept as it was.
     *
     * @param {boolean} on
     */
    setZen(on) {
      zenOn = on;
      syncZen();
    },

    /** @returns {Tile[]} */
    tiles() {
      return [...byContainer.values()];
    },

    focusedTile,

    /** Whether the layout has no tiles. */
    isEmpty() {
      return byContainer.size === 0;
    },
  };
}
