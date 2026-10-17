// The `devc web` tiling area: browser-owned window management on Golden Layout. The only module
// that imports Golden Layout, so replacing it is a change to this file alone (the same boundary
// `renderer.js` draws around xterm.js). See `.plans/devc-web-golden-layout.md`.
//
// Vocabulary: a *tile* is one Golden Layout component showing at most one Herdr pane; tiles sit
// in *stacks* (Golden Layout's tab groups), inside rows and columns. None of this is Herdr's
// layout — a Herdr tab is a different thing, and nothing here ever changes it.

import {
  GoldenLayout,
  LayoutConfig,
} from './vendor/golden-layout/golden-layout.mjs';
import { paneRefFromState } from './lib/layout_state.js';

/** The one component type. Its state is exactly a PaneRef, or `{}` for an empty tile. */
const COMPONENT_TYPE = 'pane';

/** @typedef {import('./lib/layout_state.js').PaneRef} PaneRef */

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
      container.on('show', () => hooks.visibility(tile, true));
      container.on('hide', () => hooks.visibility(tile, false));
      container.on('beforeComponentRelease', () => {
        byContainer.delete(container);
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
    if (tile) queueMicrotask(() => applyBadge(container, tile));
  });
  layout.on('focus', () => hooks.focused(focusedTile()));
  layout.on('stateChanged', () => hooks.changed());

  /** @returns {Tile | null} */
  function focusedTile() {
    const item = layout.focusedComponentItem;
    return (item && byContainer.get(item.container)) ?? null;
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
