// The host views' bridge to the main process: `window.hostTerm`, the only door to the host
// shells. Only the drawer and the host tiles' views load this; the devc views have no preload.
// Every channel is checked on the main side against the sender (`fromView` in `policy.ts`).

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('hostTerm', {
  // Panes of the app's Herdr session (`main/herdr.ts`): the main process checks every id.
  create: () => ipcRenderer.invoke('host-term:create'),
  unshown: () => ipcRenderer.invoke('host-term:unshown'),
  attach: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('host-term:attach', String(id), cols, rows),
  paneCommand: (id: string, cmd: unknown) =>
    ipcRenderer.send('host-term:pane-command', String(id), cmd),
  readSelection: (id: string, anchor: unknown, cursor: unknown) =>
    ipcRenderer.invoke('host-term:read-selection', String(id), anchor, cursor),
  release: (id: string) => ipcRenderer.send('host-term:release', String(id)),
  end: (id: string, label: string) =>
    ipcRenderer.send('host-term:end', String(id), String(label)),
  openFile: (file: unknown) => ipcRenderer.send('host-term:open-file', file),
  onFrame: (cb: (id: string, frame: unknown) => void) => {
    ipcRenderer.on(
      'host-term:frame',
      (_e, id: unknown, frame: unknown) => cb(String(id), frame),
    );
  },
  onClosed: (cb: (id: string, reason: string) => void) => {
    ipcRenderer.on(
      'host-term:closed',
      (_e, id: unknown, reason: unknown) => cb(String(id), String(reason)),
    );
  },
  onPanes: (cb: (panes: unknown) => void) => {
    ipcRenderer.on('host-term:panes', (_e, panes: unknown) => cb(panes));
  },
  hide: () => ipcRenderer.send('host-term:hide'),
  onCommand: (cb: (name: string, id: string) => void) => {
    ipcRenderer.on(
      'host-term:command',
      (_e, name: string, id: string) => cb(name, id),
    );
  },
  info: () => ipcRenderer.invoke('host-term:info'),
  dragDrawer: (dy: number) => ipcRenderer.send('host-term:drag', dy),
  contextMenu: (id: string) => ipcRenderer.send('host-term:context-menu', id),
  // Moving a pane between the drawer and `/main`'s layout: the app takes a tile away (`remove`,
  // its pane keeps running) and gives the drawer one (`adopt`).
  onRemove: (cb: (id: string) => void) => {
    ipcRenderer.on('host-term:remove', (_e, id: unknown) => cb(String(id)));
  },
  onAdopt: (cb: (id: string) => void) => {
    ipcRenderer.on('host-term:adopt', (_e, id: unknown) => cb(String(id)));
  },
  // A host tile's split or new tab: a new host tile beside it.
  command: (name: string) =>
    ipcRenderer.send('host-term:slot-command', String(name)),
  // The terminals' colors in View → Host Terminal Color's theme and the current mode: xterm.js's
  // `theme` and `minimumContrastRatio`, to replace outright.
  onColor: (cb: (colors: unknown) => void) => {
    ipcRenderer.on('host-term:color', (_e, colors: unknown) => cb(colors));
  },
  // A host tile's view: input paused after an ambiguous press (the app drops its keys).
  onGuard: (cb: (on: boolean) => void) => {
    ipcRenderer.on('host-term:guard', (_e, on: unknown) => cb(on === true));
  },
  // The drawer opened or closed; `byUser`: the user opened it (not a request).
  onShown: (cb: (open: boolean, byUser: boolean) => void) => {
    ipcRenderer.on(
      'host-term:shown',
      (_e, open: unknown, byUser: unknown) =>
        cb(open === true, byUser === true),
    );
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
