// The rail view's bridge, `window.rail`: dragging it resizes the left column. Nothing else.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('rail', {
  drag: (dx: number) => ipcRenderer.send('rail:drag', Number(dx)),
});
