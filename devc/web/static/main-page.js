// The `devc web` page at `/main`: the tiling area (`tiles.js`) alone, its sidebar another page's
// (`/sidebar` with the same view id, `#…&view=<id>`), reached through the server (`remote.js`).
// With no sidebar open it works on its own; Reveal in Containers goes nowhere. The host status
// strip (`host-status.js`) runs under the tiles, unless `#…&status=external` says it is drawn
// elsewhere (devc-desktop's `/host-status` view, across its whole window). `#…&sidebar=hidden`
// draws the corner toggle that shows devc-desktop's left column again.

import { connect, SAFE_MODE, showSafeBanner, TILE_WINDOWS } from './client.js';
import {
  closeHostTile,
  mountTiles,
  openHostFile,
  openHostTile,
  openMovedTile,
} from './tiles.js';
import { tellDesktop } from './host-slots.js';
import { mountHostStatus } from './host-status.js';
import { remoteSidebar, sendViewState, serveTileArea } from './remote.js';
import {
  hostGoneFromHash,
  hostOpenFromHash,
  hostPlacementFromHash,
  hostSlotFromHash,
  openTileFromHash,
  statusExternalFromHash,
  withoutHostSlot,
} from './lib/view.js';
import { mountSidebarCorner } from './sidebar-corner.js';
import {
  orchestratorToggleFromHash,
  withoutOrchestratorToggle,
} from './lib/orchestrator.js';
import { toggleOrchestrator } from './orchestrator.js';

if (SAFE_MODE) showSafeBanner();
const tileArea = mountTiles(
  /** @type {HTMLElement} */ (document.getElementById('tiles')),
  { sidebar: remoteSidebar(), onViewChange: sendViewState, zenByDefault: true },
);
// devc-desktop's tile windows: a tile this page showed for the sidebar brings its window forward.
const RAISES = new Set([
  'openPane',
  'openFile',
  'openDiff',
  'reveal',
  'revealLine',
]);
serveTileArea(tileArea, (name) => {
  if (TILE_WINDOWS && RAISES.has(name)) tellDesktop('window raise');
});
if (!statusExternalFromHash(location.hash)) {
  mountHostStatus(/** @type {HTMLElement} */ (document.querySelector('.app')));
}
mountSidebarCorner(/** @type {HTMLElement} */ (document.querySelector('.app')));
connect();

/**
 * devc-desktop's **New Host Tile** sets `#…&host-slot=<id>` (a hash change: nothing reloads): a
 * host tile for that slot, which the app then covers with its terminal. Its **Move to Bottom
 * Panel** sets `#…&host-gone=<id>`: that tile closes. A Cmd/Ctrl+click on a file path in a host
 * terminal sets `#…&open-host-file=<path>`: the file opens in the viewer if it is in a project's
 * repos. A tile moved from another of the app's windows comes as `#…&open-tile=<drag payload>`
 * (with `#…&windows=1` only): it opens in the focused stack. The parameters are taken out again, so
 * a reload does not act on them twice.
 */
function takeHostSlot() {
  const id = hostSlotFromHash(location.hash);
  const gone = hostGoneFromHash(location.hash);
  const file = hostOpenFromHash(location.hash);
  const moved = TILE_WINDOWS ? openTileFromHash(location.hash) : null;
  const hasMove = new URLSearchParams(location.hash.slice(1)).has('open-tile');
  if (id === null && gone === null && file === null && !hasMove) return;
  const place = hostPlacementFromHash(location.hash);
  history.replaceState(
    history.state,
    '',
    `${location.pathname}${location.search}${withoutHostSlot(location.hash)}`,
  );
  if (gone !== null) closeHostTile(gone);
  if (id !== null) openHostTile(id, place);
  if (file !== null) openHostFile(file);
  if (moved !== null) openMovedTile(moved);
}
takeHostSlot();
window.addEventListener('hashchange', takeHostSlot);

/**
 * devc-desktop's **View → Orchestrator** sets `#…&orchestrator=<nonce>`, a fresh nonce each time:
 * the orchestrator panel opens or closes, and the parameter is taken out again.
 */
function takeOrchestratorToggle() {
  if (orchestratorToggleFromHash(location.hash) === null) return;
  history.replaceState(
    history.state,
    '',
    `${location.pathname}${location.search}${
      withoutOrchestratorToggle(location.hash)
    }`,
  );
  toggleOrchestrator();
}
takeOrchestratorToggle();
window.addEventListener('hashchange', takeOrchestratorToggle);
