// The host status strip across the foot of a page: host-level indicators, the account-wide
// agent usage limits (`usage`) then devc-bridge's (`bridge_status`); at its far end, in live mode
// a button that pauses live reload, then the connection dot. `/` draws it under the sidebar and
// the tiles alike, `/main` under the tiles.

import { bridgeStatusItems, CONN_TEXT, usageItems } from './lib/host_status.js';
import { liveReloadItem } from './lib/live_reload.js';
import { h } from './ui.js';
import {
  hostBridgeStatus,
  hostUsage,
  liveMode,
  liveReloadHeld,
  liveReloadPaused,
  onConnectionChange,
  onLiveReloadChange,
  onServerMessage,
  setLiveReloadPaused,
} from './client.js';

/** Appends the strip to `$parent` and keeps it up to date. @param {HTMLElement} $parent */
export function mountHostStatus($parent) {
  const $hostStatus = h('footer', {
    class: 'host-status',
    id: 'host-status',
    'aria-label': 'Host status',
  });
  /** @type {import('./client.js').ConnectionState} */
  let connState = 'connecting';
  $parent.append($hostStatus);
  // Usage windows reset and observations age with no server traffic: re-evaluate every minute.
  setInterval(() => {
    if (hostUsage?.length) render();
  }, 60_000);
  onServerMessage((msg) => {
    if (
      msg.type === 'bridge_status' || msg.type === 'usage' ||
      msg.type === 'hello'
    ) render();
  });
  onLiveReloadChange(render);
  onConnectionChange((state) => {
    connState = state;
    render();
  });
  render();

  /**
   * Fills the strip from the last usage and devc-bridge status, live reload's state and the
   * connection's. Marker names and usage labels come from the host's filesystem, so every item
   * is text.
   */
  function render() {
    const items = [
      ...(hostUsage ? usageItems(hostUsage, Date.now() / 1000) : []),
      ...(hostBridgeStatus ? bridgeStatusItems(hostBridgeStatus) : []),
    ];
    const live = liveMode
      ? liveReloadItem({ paused: liveReloadPaused, held: liveReloadHeld })
      : null;
    $hostStatus.replaceChildren(
      ...items.map((item) =>
        h('span', {
          class: 'host-status-item',
          'data-state': item.state,
          title: item.title,
        }, item.text)
      ),
    );
    const $end = h('span', { class: 'host-status-end' });
    if (live) {
      $end.append(
        h('button', {
          type: 'button',
          class: 'host-status-item host-status-live',
          'data-state': live.state,
          'aria-pressed': String(liveReloadPaused),
          title: live.title,
          onclick: () => setLiveReloadPaused(!liveReloadPaused),
        }, live.text),
      );
    }
    $end.append(
      h('span', {
        class: 'conn',
        // `no-token` is drawn like `closed`.
        'data-state': connState === 'no-token' ? 'closed' : connState,
        role: 'img',
        'aria-label': CONN_TEXT[connState],
        title: CONN_TEXT[connState],
      }),
    );
    $hostStatus.append($end);
  }
}
