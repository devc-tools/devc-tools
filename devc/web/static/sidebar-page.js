// The `devc web` page at `/sidebar`: the sidebar (`sidebar.js`) alone, its tiling area another
// page's (`/main` with the same view id, `#…&view=<id>`), reached through the server
// (`remote.js`).

import { connect, SAFE_MODE, showSafeBanner } from './client.js';
import { mountSidebar } from './sidebar.js';
import { remoteTileArea, serveSidebar } from './remote.js';

if (SAFE_MODE) showSafeBanner();
const remote = remoteTileArea();
const sidebar = mountSidebar(
  /** @type {HTMLElement} */ (document.querySelector('aside.sidebar')),
  { tileArea: remote.tileArea },
);
serveSidebar(remote, sidebar);
connect();
