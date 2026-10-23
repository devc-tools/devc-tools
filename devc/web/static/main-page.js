// The `devc web` page at `/main`: the tiling area (`tiles.js`) alone, its sidebar another page's
// (`/sidebar` with the same view id, `#…&view=<id>`), reached through the server (`remote.js`).
// With no sidebar open it works on its own; Reveal in Containers and the zen items go nowhere.
// `?zen=…` starts it in zen mode or out of it (`zenFromSearch`); the sidebar's zen then rules.

import { connect, SAFE_MODE, showSafeBanner } from './client.js';
import { mountTiles } from './tiles.js';
import { remoteSidebar, sendViewState, serveTileArea } from './remote.js';
import { zenFromSearch } from './lib/view.js';

if (SAFE_MODE) showSafeBanner();
const tileArea = mountTiles(
  /** @type {HTMLElement} */ (document.getElementById('tiles')),
  { sidebar: remoteSidebar(), onViewChange: sendViewState },
);
const zen = zenFromSearch(location.search);
if (zen) tileArea.setZen(zen.on);
serveTileArea(tileArea);
connect();
