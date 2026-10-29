// The `devc web` page at `/containers`: the sidebar's Containers section (`containers.js`) alone,
// its tiling area another page's (`/main` with the same view id, `#…&view=<id>`) and its In use
// another's (`/sidebar` with the same view id), both reached through the server (`remote.js`).
// With neither open it lists the containers as ever; what it opens goes nowhere, and no card is a
// stand-in for one In use shows.

import { connect, SAFE_MODE, showSafeBanner } from './client.js';
import { mountContainers } from './containers.js';
import { remoteInUse, remoteTileArea, serveContainers } from './remote.js';

if (SAFE_MODE) showSafeBanner();
const remote = remoteTileArea();
const inUse = remoteInUse();
const section = mountContainers(
  /** @type {HTMLElement} */ (document.getElementById('containers')),
  { tileArea: remote.tileArea, inUse: inUse.link, standalone: true },
);
serveContainers(remote, inUse, section);
connect();
