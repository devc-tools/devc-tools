// The `devc web` page at `/main`: the tiling area (`tiles.js`) alone, its sidebar another page's
// (`/sidebar` with the same view id, `#…&view=<id>`), reached through the server (`remote.js`).
// With no sidebar open it works on its own; Reveal in Containers goes nowhere. The host status
// strip (`host-status.js`) runs under the tiles, unless `#…&status=external` says it is drawn
// elsewhere (devc-desktop's `/host-status` view, across its whole window). `#…&sidebar=hidden`
// draws the corner toggle that shows devc-desktop's left column again.

import { connect, SAFE_MODE, showSafeBanner } from './client.js';
import { closeHostTile, mountTiles, openHostTile } from './tiles.js';
import { mountHostStatus } from './host-status.js';
import { remoteSidebar, sendViewState, serveTileArea } from './remote.js';
import {
  hostGoneFromHash,
  hostPlacementFromHash,
  hostSlotFromHash,
  statusExternalFromHash,
  withoutHostSlot,
} from './lib/view.js';
import { mountSidebarCorner } from './sidebar-corner.js';

if (SAFE_MODE) showSafeBanner();
const tileArea = mountTiles(
  /** @type {HTMLElement} */ (document.getElementById('tiles')),
  { sidebar: remoteSidebar(), onViewChange: sendViewState, zenByDefault: true },
);
serveTileArea(tileArea);
if (!statusExternalFromHash(location.hash)) {
  mountHostStatus(/** @type {HTMLElement} */ (document.querySelector('.app')));
}
mountSidebarCorner(/** @type {HTMLElement} */ (document.querySelector('.app')));
connect();

/**
 * devc-desktop's **New Host Tile** sets `#…&host-slot=<id>` (a hash change: nothing reloads): a
 * host tile for that slot, which the app then covers with its terminal. Its **Move to Bottom
 * Panel** sets `#…&host-gone=<id>`: that tile closes. The parameters are taken out again, so a
 * reload does not act on them twice.
 */
function takeHostSlot() {
  const id = hostSlotFromHash(location.hash);
  const gone = hostGoneFromHash(location.hash);
  if (id === null && gone === null) return;
  const place = hostPlacementFromHash(location.hash);
  history.replaceState(
    history.state,
    '',
    `${location.pathname}${location.search}${withoutHostSlot(location.hash)}`,
  );
  if (gone !== null) closeHostTile(gone);
  if (id !== null) openHostTile(id, place);
}
takeHostSlot();
window.addEventListener('hashchange', takeHostSlot);
