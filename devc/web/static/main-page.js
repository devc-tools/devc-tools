// The `devc web` page at `/main`: the tiling area (`tiles.js`) alone, its sidebar another page's
// (`/sidebar` with the same view id, `#…&view=<id>`), reached through the server (`remote.js`).
// With no sidebar open it works on its own; Reveal in Containers goes nowhere.

import { connect, SAFE_MODE, showSafeBanner } from './client.js';
import { mountTiles } from './tiles.js';
import { remoteSidebar, sendViewState, serveTileArea } from './remote.js';

if (SAFE_MODE) showSafeBanner();
const tileArea = mountTiles(
  /** @type {HTMLElement} */ (document.getElementById('tiles')),
  { sidebar: remoteSidebar(), onViewChange: sendViewState, zenByDefault: true },
);
serveTileArea(tileArea);
connect();
