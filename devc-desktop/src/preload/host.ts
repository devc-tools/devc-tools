// The host views' bridge to the main process: `window.hostTerm`, the only door to the host
// shells. Only the drawer and the host tiles' views load this; the devc views have no preload.
// Every channel is checked on the main side against the sender (`fromView` in `policy.ts`).

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('hostTerm', {
  start: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('host-term:start', id, cols, rows),
  input: (id: string, data: string) =>
    ipcRenderer.send('host-term:input', id, String(data)),
  resize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('host-term:resize', id, cols, rows),
  close: (id: string) => ipcRenderer.send('host-term:close', id),
  hide: () => ipcRenderer.send('host-term:hide'),
  onOutput: (cb: (id: string, data: string) => void) => {
    ipcRenderer.on(
      'host-term:output',
      (_e, id: string, data: string) => cb(id, data),
    );
  },
  onExit: (cb: (id: string, code: number) => void) => {
    ipcRenderer.on(
      'host-term:exit',
      (_e, id: string, code: number) => cb(id, code),
    );
  },
  onCommand: (cb: (name: string, id: string) => void) => {
    ipcRenderer.on(
      'host-term:command',
      (_e, name: string, id: string) => cb(name, id),
    );
  },
  info: () => ipcRenderer.invoke('host-term:info'),
  dragDrawer: (dy: number) => ipcRenderer.send('host-term:drag', dy),
  contextMenu: (id: string) => ipcRenderer.send('host-term:context-menu', id),
  // The host color (View → Host Terminal Color), as its background hex.
  onColor: (cb: (background: string) => void) => {
    ipcRenderer.on('host-term:color', (_e, bg: unknown) => cb(String(bg)));
  },
  // A host tile's view: input paused after an ambiguous press (the app drops its keys).
  onGuard: (cb: (on: boolean) => void) => {
    ipcRenderer.on('host-term:guard', (_e, on: unknown) => cb(on === true));
  },
  onShown: (cb: (open: boolean) => void) => {
    ipcRenderer.on('host-term:shown', (_e, open: unknown) => cb(open === true));
  },
  // The Actions column: requests devc web's page made, as the app checked them.
  onActions: (cb: (cards: unknown) => void) => {
    ipcRenderer.on('host-actions:list', (_e, cards: unknown) => cb(cards));
  },
  onActionProgress: (cb: (id: string, line: string) => void) => {
    ipcRenderer.on(
      'host-actions:progress',
      (_e, id: unknown, line: unknown) => cb(String(id), String(line)),
    );
  },
  confirmAction: (id: string) =>
    ipcRenderer.send('host-actions:confirm', String(id)),
  dismissAction: (id: string) =>
    ipcRenderer.send('host-actions:dismiss', String(id)),
});
