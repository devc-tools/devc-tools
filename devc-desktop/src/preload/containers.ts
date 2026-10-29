// The Containers pane's bridge, `window.containersPane`. The pane is devc web's Containers
// section bundled into the app (`containers.ts`): it reaches devc web's `/ws` with the desktop
// token, which comes to it only here (`token()`), never in its URL. Every channel is checked on
// the main side against the sender (`fromView` in `policy.ts`).

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('containersPane', {
  /** devc web's origin and the desktop token, or `null` while devc web isn't running. */
  token: () => ipcRenderer.invoke('containers:token'),
  dragStrip: (dy: number) => ipcRenderer.send('containers:drag', Number(dy)),
  resetStrip: () => ipcRenderer.send('containers:reset'),
  /** The section opened, or folded to `height` (the pane down to its heading). */
  fold: (open: boolean, height: number) =>
    ipcRenderer.send('containers:fold', open === true, Number(height)),
  /** Opens the app's overlay menu: `items` are `{label, danger}` or `null` (a divider). */
  menu: (seq: number, items: unknown, x: number, y: number) =>
    ipcRenderer.send('containers:menu', Number(seq), { items, x, y }),
  onMenuPick: (cb: (seq: number, index: number) => void) => {
    ipcRenderer.on(
      'containers:menu-pick',
      (_e, seq: unknown, index: unknown) => cb(Number(seq), Number(index)),
    );
  },
  push: (localFolder: string, folder: string) =>
    ipcRenderer.send('containers:push', String(localFolder), String(folder)),
  project: (action: string, localFolder: string) =>
    ipcRenderer.send('containers:project', String(action), String(localFolder)),
  // The pane's Actions column: the pushes and container actions its clicks asked for.
  onActions: (cb: (cards: unknown) => void) => {
    ipcRenderer.on('containers:actions', (_e, cards: unknown) => cb(cards));
  },
  onActionProgress: (cb: (id: string, line: string) => void) => {
    ipcRenderer.on(
      'containers:action-progress',
      (_e, id: unknown, line: unknown) => cb(String(id), String(line)),
    );
  },
  confirmAction: (id: string) =>
    ipcRenderer.send('containers:confirm', String(id)),
  dismissAction: (id: string) =>
    ipcRenderer.send('containers:dismiss', String(id)),
});
