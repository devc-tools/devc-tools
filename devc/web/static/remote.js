// The remote halves of `lib/view.js`'s contracts, for the split pages: on `/sidebar`, a tiling area
// that is another page's (`remoteTileArea`), and on `/main`, a sidebar that is another page's
// (`remoteSidebar`). The server relays between pages with the same view id (`VIEW_ID`) as
// `view_state`, `view_intent` and `sidebar_intent` messages; see
// `.plans/devc-web-sidebar-main-routes.md`. `/` wires the halves in-process and never loads this.

import { onServerMessage, send, VIEW_ID } from './client.js';
import {
  DRAG_MIME,
  emptyViewState,
  encodeDrag,
  relayedIntent,
  relayedState,
  SIDEBAR_INTENT_NAMES,
  VIEW_INTENT_NAMES,
} from './lib/view.js';

/** @typedef {import('./lib/view.js').ViewState} ViewState */
/** @typedef {import('./lib/view.js').TileArea} TileArea */
/** @typedef {import('./lib/view.js').SidebarIntents} SidebarIntents */

// ---------------------------------------------------------------------------------------------
// `/main`: the tiling area here, its sidebar elsewhere
// ---------------------------------------------------------------------------------------------

/**
 * The sidebar as the `/main` page's tiling area holds it: each call goes to the view's sidebars
 * as a `sidebar_intent` (nowhere, while none is open).
 *
 * @returns {SidebarIntents}
 */
export function remoteSidebar() {
  /** @param {string} name @param {unknown[]} args */
  const intent = (name, args) =>
    send({ type: 'sidebar_intent', view: VIEW_ID, name, args });
  return {
    revealInContainers: (ref) => intent('revealInContainers', [ref]),
    prViewed: (diff, viewed) => intent('prViewed', [diff, viewed]),
  };
}

/** Sends the tiling area's state to the view's sidebars: `mountTiles`'s `onViewChange`. */
export function sendViewState(/** @type {ViewState} */ state) {
  send({ type: 'view_state', view: VIEW_ID, state });
}

/**
 * Joins the view as its tiling area on every `hello` (a connect or a reconnect), sending the state
 * as it is, and carries out the sidebars' `view_intent`s on `tileArea`.
 *
 * @param {TileArea} tileArea
 */
export function serveTileArea(tileArea) {
  onServerMessage((msg) => {
    if (msg.type === 'hello') {
      send({ type: 'view_join', view: VIEW_ID, role: 'tiles' });
      sendViewState(tileArea.state());
      return;
    }
    const intent = relayedIntent(
      msg,
      'view_intent',
      VIEW_ID,
      VIEW_INTENT_NAMES,
    );
    if (intent) {
      /** @type {any} */ (tileArea)[intent.name](...intent.args);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// `/sidebar`: the sidebar here, its tiling area elsewhere
// ---------------------------------------------------------------------------------------------

/**
 * The tiling area as the `/sidebar` page's sidebar holds it: its state is the last `view_state`
 * relayed (no tiles before any), and each intent goes to the view's tiling areas as a
 * `view_intent`. Rows are native drag sources (`DRAG_MIME`), dropped on another page's tiling
 * area: Golden Layout's drag can't leave its page.
 *
 * @returns {{tileArea: TileArea, setState: (state: ViewState) => void}}
 *   `setState` keeps a relayed state
 */
export function remoteTileArea() {
  let state = emptyViewState();
  /** @param {string} name @param {unknown[]} args */
  const intent = (name, args) =>
    send({ type: 'view_intent', view: VIEW_ID, name, args });
  /** @type {TileArea} */
  const tileArea = {
    state: () => state,
    openPane: (ref, opts) => intent('openPane', opts ? [ref, opts] : [ref]),
    openFile: (file, where) => intent('openFile', [file, where]),
    openDiff: (diff, where, opts) =>
      intent('openDiff', opts ? [diff, where, opts] : [diff, where]),
    reveal: (id) => intent('reveal', [id]),
    close: (id) => intent('close', [id]),
    keepOpen: (id) => intent('keepOpen', [id]),
    save: (id) => intent('save', [id]),
    reload: (id) => intent('reload', [id]),
    prViewed: (diff, viewed) => intent('prViewed', [diff, viewed]),
    dragSource: nativeDragSource,
  };
  return {
    tileArea,
    setState: (s) => state = s,
  };
}

/**
 * Makes `el` a native drag source of the tile content `ref()` names, for a tiling area in another
 * page; returns a remover that undoes it.
 *
 * @type {TileArea['dragSource']}
 */
function nativeDragSource(el, ref, title) {
  /** @param {DragEvent} e */
  const start = (e) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData(DRAG_MIME, encodeDrag(ref()));
    e.dataTransfer.setData('text/plain', title());
    e.dataTransfer.effectAllowed = 'copy';
  };
  el.draggable = true;
  el.addEventListener('dragstart', start);
  return () => {
    el.draggable = false;
    el.removeEventListener('dragstart', start);
  };
}

/**
 * Joins the view as a sidebar on every `hello`, keeps each relayed `view_state` (handing it to
 * `sidebar.onViewState`) and carries out the tiling areas' `sidebar_intent`s.
 *
 * @param {ReturnType<typeof remoteTileArea>} remote
 * @param {{intents: SidebarIntents, onViewState: (state: ViewState) => void}} sidebar
 */
export function serveSidebar(remote, sidebar) {
  onServerMessage((msg) => {
    if (msg.type === 'hello') {
      send({ type: 'view_join', view: VIEW_ID, role: 'sidebar' });
      return;
    }
    const state = relayedState(msg, VIEW_ID);
    if (state) {
      remote.setState(state);
      sidebar.onViewState(state);
      return;
    }
    const intent = relayedIntent(
      msg,
      'sidebar_intent',
      VIEW_ID,
      SIDEBAR_INTENT_NAMES,
    );
    if (intent) {
      /** @type {any} */ (sidebar.intents)[intent.name](...intent.args);
    }
  });
}
