// The status view's bridge: what `devc web` is doing, and a way to restart it. Nothing else.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('devcDesktop', {
  status: () => ipcRenderer.invoke('status:get'),
  onStatus: (cb: (s: unknown) => void) => {
    ipcRenderer.on('status:update', (_e, s) => cb(s));
  },
  restart: () => ipcRenderer.send('status:restart'),
});
