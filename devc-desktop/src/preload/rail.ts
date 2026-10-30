// The rail view's bridge, `window.rail`: dragging it resizes the left column, and a click shows
// it while hidden. Nothing else.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('rail', {
  drag: (dx: number) => ipcRenderer.send('rail:drag', Number(dx)),
  click: () => ipcRenderer.send('rail:click'),
});
