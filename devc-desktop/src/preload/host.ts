// The host view's bridge to the main process: `window.hostTerm`, the only door to the host
// shell. Only the host view loads this; the devc view has no preload at all. Every channel is
// checked on the main side against the sender (`fromView` in `policy.ts`).

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('hostTerm', {
  start: (cols: number, rows: number) =>
    ipcRenderer.send('host-term:start', cols, rows),
  input: (data: string) => ipcRenderer.send('host-term:input', String(data)),
  resize: (cols: number, rows: number) =>
    ipcRenderer.send('host-term:resize', cols, rows),
  onOutput: (cb: (data: string) => void) => {
    ipcRenderer.on('host-term:output', (_e, data: string) => cb(data));
  },
  onExit: (cb: (code: number) => void) => {
    ipcRenderer.on('host-term:exit', (_e, code: number) => cb(code));
  },
  info: () => ipcRenderer.invoke('host-term:info'),
  dragDrawer: (dy: number) => ipcRenderer.send('host-term:drag', dy),
});
