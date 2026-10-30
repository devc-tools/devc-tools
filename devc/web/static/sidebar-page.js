// The `devc web` page at `/sidebar`: the sidebar (`sidebar.js`) alone, its tiling area another
// page's (`/main` with the same view id, `#…&view=<id>`), reached through the server
// (`remote.js`). A `/containers` page with the same view id is told In use's cards, and what In
// use asks of Containers, as its own Containers section is. `#…&containers=external` leaves the
// page's own Containers section out (devc-desktop draws its own below this page), and
// `#…&sidebar=shown` draws the corner toggle that hides devc-desktop's left column.

import { connect, SAFE_MODE, showSafeBanner } from './client.js';
import { mountSidebar } from './sidebar.js';
import { containersExternalFromHash } from './lib/view.js';
import { mountSidebarCorner } from './sidebar-corner.js';
import {
  remoteContainers,
  remoteTileArea,
  sendInUse,
  serveSidebar,
} from './remote.js';

if (SAFE_MODE) showSafeBanner();
const remote = remoteTileArea();
const sidebar = mountSidebar(
  /** @type {HTMLElement} */ (document.querySelector('aside.sidebar')),
  {
    tileArea: remote.tileArea,
    containers: remoteContainers(),
    containersExternal: containersExternalFromHash(location.hash),
    onInUse: sendInUse,
  },
);
serveSidebar(remote, sidebar);
mountSidebarCorner(/** @type {HTMLElement} */ (document.querySelector('.app')));
connect();
