// The Containers pane: devc web's Containers section (`devc/web/static/containers.js`, the
// `/containers` page's code), bundled into the app at build time, so `devc web --live` never
// changes it. It sits below devc web's `/sidebar` view, under its own HOST strip, and reaches
// devc web's `/ws` with the desktop token (`window.containersPane.token()`, the containers
// preload), which gives it the server's desktop role. What it can't leave to the server goes to
// the app: a push or a container start, stop or removal shows here as a card the user confirms
// (armed, as in the HOST drawer), and its right-click menus are the app's overlay menu, so they
// can spread past the pane. Container-supplied text is only ever inserted as text.

import { connect, useBundledEndpoint } from 'devc-web/client.js';
import { mountContainers } from 'devc-web/containers.js';
import { useAppActions } from 'devc-web/menus.js';
import {
  remoteInUse,
  remoteTileArea,
  serveContainers,
} from 'devc-web/remote.js';
import { type MenuItem, useMenuHost } from 'devc-web/ui.js';
import { PROTOCOL } from 'devc-web/lib/protocol_version.js';
import { badgeText } from '../main/policy.ts';
import { actionColumn } from './actions.ts';

interface ContainersPane {
  token(): Promise<{ origin: string; token: string } | null>;
  dragStrip(dy: number): void;
  menu(
    seq: number,
    items: ({ label: string; danger: boolean } | null)[],
    x: number,
    y: number,
  ): void;
  onMenuPick(cb: (seq: number, index: number) => void): void;
  push(localFolder: string, folder: string): void;
  project(action: string, localFolder: string): void;
  onActions(cb: (cards: unknown) => void): void;
  onActionProgress(cb: (id: string, line: string) => void): void;
  confirmAction(id: string): void;
  dismissAction(id: string): void;
}

declare global {
  interface Window {
    containersPane: ContainersPane;
  }
}

const pane = window.containersPane;
const $ = (id: string) => document.getElementById(id)!;

// ---- the HOST strip: dragging it resizes the pane ------------------------------------------------

const strip = $('strip');
strip.addEventListener('pointerdown', (e) => {
  strip.setPointerCapture(e.pointerId);
  let last = e.screenY;
  const move = (m: PointerEvent) => {
    const dy = m.screenY - last;
    last = m.screenY;
    if (dy !== 0) pane.dragStrip(dy);
  };
  const up = () => {
    strip.removeEventListener('pointermove', move);
    strip.removeEventListener('pointerup', up);
  };
  strip.addEventListener('pointermove', move);
  strip.addEventListener('pointerup', up);
});

// ---- the Actions column ------------------------------------------------------------------------

const column = actionColumn($('actions'), {
  confirm: (id) => pane.confirmAction(id),
  dismiss: (id) => pane.dismissAction(id),
});
pane.onActions((raw) => {
  const { waiting } = column.show(raw);
  $('badge').textContent = badgeText(waiting);
  $('badge').hidden = waiting === 0;
});
pane.onActionProgress(column.progress);

// ---- menus: the app's overlay, never this page's own -------------------------------------------

let menuSeq = 0;
let menuActions: (() => void)[] = [];
useMenuHost((x: number, y: number, items: MenuItem[]) => {
  menuSeq++;
  menuActions = [];
  const entries = items.map((item, i) => {
    if (item === null) return null;
    menuActions[i] = item[1];
    return { label: String(item[0]), danger: item[2] === true };
  });
  pane.menu(menuSeq, entries, Math.round(x), Math.round(y));
});
pane.onMenuPick((seq, index) => {
  if (seq !== menuSeq) return;
  const run = menuActions[index];
  menuActions = [];
  run?.();
});

// Pushes and container actions go to the app, which shows them above as cards to confirm.
useAppActions({
  push: (localFolder, folder) => pane.push(localFolder, folder),
  project: (action, localFolder) => pane.project(action, localFolder),
});

// ---- the section, once the app has handed over devc web's address and the desktop token --------

/** Shows only `text` (a protocol mismatch, or no devc web), or the section when `null`. */
function notice(text: string | null): void {
  $('notice').textContent = text ?? '';
  $('notice').hidden = text === null;
  $('section').hidden = text !== null;
}

void pane.token().then((conn) => {
  if (conn === null) {
    notice("devc web isn't running.");
    return;
  }
  useBundledEndpoint({
    origin: conn.origin,
    desktopToken: conn.token,
    protocol: PROTOCOL,
    onProtocol: (ok, server) =>
      notice(
        ok
          ? null
          : `This devc-desktop was built for protocol ${PROTOCOL}; devc web speaks ${
            typeof server === 'number' ? server : 'none'
          }. Rebuild devc-desktop.`,
      ),
  });
  const remote = remoteTileArea();
  const inUse = remoteInUse();
  const section = mountContainers($('containers'), {
    tileArea: remote.tileArea,
    inUse: inUse.link,
    standalone: true,
  });
  serveContainers(remote, inUse, section);
  connect();
});
