// Pure helpers for the `devc web` host status strip at the foot of the sidebar: host-level
// indicators, starting with devc-bridge's (`bridge_status`). Shared with the Deno tests
// (`devc/tests/web_host_status_test.ts`). No DOM access here.
//
// Marker names come from the host's filesystem: the page inserts every `text` and `title` as
// text, never HTML.

/** The active marker keepawake's default command leaves while it holds the host awake. */
export const AWAKE_MARKER = 'caffeinate';

/**
 * A `bridge_status` message's fields, checked: `null` when it isn't one this page understands.
 * @param {any} msg
 * @returns {{running: boolean, active: string[]} | null}
 */
export function parseBridgeStatus(msg) {
  if (typeof msg?.running !== 'boolean' || !Array.isArray(msg.active)) {
    return null;
  }
  return {
    running: msg.running,
    active: msg.active.filter((a) => typeof a === 'string'),
  };
}

/**
 * The strip's items for devc-bridge's status, in order: the bridge itself, then `☕ awake` when
 * keepawake's marker is present, then any other marker by name.
 * @param {{running: boolean, active: string[]}} status
 * @returns {{key: string, state: string, text: string, title: string}[]}
 */
export function bridgeStatusItems(status) {
  const items = [
    status.running
      ? {
        key: 'bridge',
        state: 'on',
        text: 'bridge ●',
        title: 'devc-bridge is running',
      }
      : {
        key: 'bridge',
        state: 'off',
        text: 'bridge ○ off',
        title: 'devc-bridge is not running',
      },
  ];
  for (const name of status.active) {
    items.push(
      name === AWAKE_MARKER
        ? {
          key: 'awake',
          state: 'awake',
          text: '☕ awake',
          title: 'keepawake is holding the host awake (caffeinate)',
        }
        : {
          key: `marker:${name}`,
          state: 'marker',
          text: name,
          title: `devc-bridge active marker: ${name}`,
        },
    );
  }
  return items;
}
