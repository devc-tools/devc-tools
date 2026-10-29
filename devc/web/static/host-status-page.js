// The `devc web` page at `/host-status`: the host status strip (`host-status.js`) alone, the
// whole window. devc-desktop draws it across the foot of its window, under `/sidebar`, `/main`
// and its own views, and opens `/main` with `#…&status=external` so that draws none.

import { connect, SAFE_MODE, showSafeBanner } from './client.js';
import { mountHostStatus } from './host-status.js';

if (SAFE_MODE) showSafeBanner();
mountHostStatus(/** @type {HTMLElement} */ (document.querySelector('.app')));
connect();
