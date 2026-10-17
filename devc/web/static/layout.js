// The `devc web` tiling area: browser-owned window management on Golden Layout. The only module
// that imports Golden Layout, so replacing it is a change to this file alone (the same boundary
// `renderer.js` draws around xterm.js). See `.plans/devc-web-golden-layout.md`.
//
// Vocabulary: a *tile* is one Golden Layout component showing at most one Herdr pane; tiles sit
// in *stacks* (Golden Layout's tab groups), inside rows and columns. None of this is Herdr's
// layout — a Herdr tab is a different thing, and nothing here ever changes it.

import {
  GoldenLayout,
  ItemConfig,
  LayoutConfig,
  ResolvedItemConfig,
} from './vendor/golden-layout/golden-layout.mjs';
import { paneRefFromState } from './lib/layout_state.js';

/** The one component type. Its state is exactly a PaneRef, or `{}` for an empty tile. */
const COMPONENT_TYPE = 'pane';

/** @typedef {import('./lib/layout_state.js').PaneRef} PaneRef */
/** @typedef {import('./lib/layout_state.js').LayoutNode} LayoutNode */

/**
 * @typedef {object} Tile
 * @property {string} id                 stable for the tile's lifetime
 * @property {PaneRef | null} ref        the pane this tile shows
 * @property {HTMLElement} element       where app.js mounts the renderer and overlay
 * @property {(ref: PaneRef | null) => void} setRef   persists into the component state
 * @property {(title: string) => void} setTitle
 * @property {(el: Node | null) => void} setBadge     agent badge shown in the tile's tab
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

/** An empty layout carrying our settings. */
function emptyConfig() {
  return { settings: SETTINGS, header: HEADER, root: undefined };
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

  /** Puts `tile`'s badge into its current tab element (tabs are recreated on moves). */
  const applyBadge = (container, tile) => {
    const tab = container.tab;
    if (!tab) return;
    tab.element.querySelector('.tile-badge')?.remove();
    const badge = badges.get(tile);
    if (!badge) return;
    const slot = document.createElement('span');
    slot.className = 'tile-badge';
    slot.append(badge);
    tab.titleElement.after(slot);
  };

  layout.registerComponentFactoryFunction(
    COMPONENT_TYPE,
    (container, state) => {
      /** @type {Tile} */
      const tile = {
        id: `t${++nextTileId}`,
        ref: paneRefFromState(state),
        element: container.element,
        setRef(ref) {
          tile.ref = ref;
          container.setState(ref ? { ...ref } : {});
        },
        setTitle(title) {
          if (container.title !== title) container.setTitle(title);
        },
        setBadge(el) {
          badges.set(tile, el);
          applyBadge(container, tile);
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
        hooks.unmount(tile);
      });
      hooks.mount(tile);
      return undefined;
    },
  );

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
  layout.on('focus', () => hooks.focused(focusedTile()));
  layout.on('stateChanged', () => hooks.changed());

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

  /** @param {PaneRef | null} ref @param {string} title */
  const itemConfig = (ref, title) => ({
    type: 'component',
    componentType: COMPONENT_TYPE,
    componentState: ref ? { ...ref } : {},
    title,
  });

  layout.loadLayout(emptyConfig());

  return {
    /**
     * A new tile, in the focused stack when there is one, else wherever Golden Layout's default
     * location selectors put it (the root, for an empty layout).
     *
     * @param {PaneRef | null} ref
     * @returns {Tile}
     */
    add(ref) {
      const item = layout.newComponent(
        COMPONENT_TYPE,
        ref ? { ...ref } : {},
        '',
      );
      const tile = byContainer.get(item.container);
      item.focus();
      return /** @type {Tile} */ (tile);
    },

    /**
     * Makes `el` draggable into the layout; a drop creates a tile for `ref()`. `title()` names
     * the drag preview (app.js keeps the tile's title current once it is placed).
     *
     * @param {HTMLElement} el
     * @param {() => PaneRef} ref
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
     * A new tile showing `ref`, placed relative to the item with id `id`:
     * - a tile: 'right' / 'below' split beside its stack (inserting into the parent row or
     *   column when its direction matches, else wrapping the stack in a new one, as a drop on
     *   the stack's edge would); 'stack' adds it to the tile's stack;
     * - a stack: the same, relative to that stack;
     * - a row or column: a new stack at its end (`where` ignored).
     * `id` null (or unknown) behaves like `add(ref)`. The new tile is focused.
     *
     * @param {string | null} id
     * @param {PaneRef | null} ref
     * @param {'right' | 'below' | 'stack'} where
     * @returns {Tile}
     */
    addBeside(id, ref, where) {
      const target = id === null ? null : itemById(id);
      if (!target) return this.add(ref);
      const config = itemConfig(ref, '');
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
            COMPONENT_TYPE,
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
      hooks.changed();
      return /** @type {Tile} */ (tile);
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
      try {
        layout.loadLayout({
          .../** @type {object} */ (saved),
          settings: SETTINGS,
          header: HEADER,
        });
        return true;
      } catch {
        try {
          layout.loadLayout(emptyConfig());
        } catch { /* nothing more to try */ }
        return false;
      }
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
