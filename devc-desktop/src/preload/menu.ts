// The overlay menu view's bridge, `window.overlayMenu`: its items come in, and its size, a pick or
// a dismissal go out. Only the overlay view loads this; every channel is checked on the main side
// against the sender (`fromView` in `policy.ts`).

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('overlayMenu', {
  onShow: (cb: (items: unknown) => void) => {
    ipcRenderer.on('menu:show', (_e, items: unknown) => cb(items));
  },
  size: (width: number, height: number) =>
    ipcRenderer.send('menu:size', Number(width), Number(height)),
  pick: (index: number) => ipcRenderer.send('menu:pick', Number(index)),
  dismiss: () => ipcRenderer.send('menu:dismiss'),
});
