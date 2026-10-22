// The title bar's bridge: the window's title as it changes, and which OS draws the window's
// buttons where. Nothing else.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('titleBar', {
  platform: process.platform,
  onTitle: (cb: (title: string) => void) => {
    ipcRenderer.on('titlebar:title', (_e, title) => cb(title));
  },
});
