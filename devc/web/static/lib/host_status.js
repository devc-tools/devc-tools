// Pure helpers for the `devc web` host status strip at the foot of the sidebar: host-level
// indicators: the account-wide agent usage limits (`usage`) and devc-bridge's status
// (`bridge_status`). Shared with the Deno tests (`devc/tests/web_host_status_test.ts`). No DOM
// access here.
//
// Marker names come from the host's filesystem and usage labels from whatever wrote the usage
// file: the page inserts every `text` and `title` as text, never HTML.

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

/**
 * @typedef {{id: string, label: string, usedPercentage: number, resetsAt: number | null}} UsageWindow
 * @typedef {{agent: string, observedAt: number, windows: UsageWindow[]}} UsageSource
 */

/** An observation older than this (seconds) is de-emphasized. */
export const USAGE_STALE_S = 15 * 60;
/** A window at or above this share used is highlighted. */
export const USAGE_HIGH_PERCENT = 90;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v !== '';

/**
 * A `usage` message's sources, checked: `null` when it isn't one this page understands. A
 * malformed source or window is dropped.
 * @param {any} msg
 * @returns {UsageSource[] | null}
 */
export function parseUsage(msg) {
  if (!Array.isArray(msg?.sources)) return null;
  /** @type {UsageSource[]} */
  const sources = [];
  for (const s of msg.sources) {
    if (!isStr(s?.agent) || !isNum(s.observedAt) || !Array.isArray(s.windows)) {
      continue;
    }
    const windows = s.windows.filter((w) =>
      isStr(w?.id) && isStr(w.label) && isNum(w.usedPercentage) &&
      (w.resetsAt === null || isNum(w.resetsAt))
    ).map((w) => ({
      id: w.id,
      label: w.label,
      usedPercentage: w.usedPercentage,
      resetsAt: w.resetsAt,
    }));
    sources.push({ agent: s.agent, observedAt: s.observedAt, windows });
  }
  return sources;
}

/**
 * How long until something, tersely, from seconds ahead: `12m`, `2h`, `2h5m`, `3d`, `3d4h`.
 * @param {number} seconds
 */
export function formatIn(seconds) {
  const m = Math.max(0, Math.floor(seconds / 60));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d${h % 24}h` : `${d}d`;
}

/**
 * The strip's items for the usage sources, one per source: its windows' percentages in the
 * source's order, slash-separated, as `77/11%` (prefixed by the agent when there is more than
 * one source). A window whose reset has passed with no newer report is `—`, never the old
 * percentage. The tooltip is the time to each reset in the same pattern, `1h5m/3d4h` (`—`
 * passed, `?` unknown). Rendered from
 * `label`, `usedPercentage` and `resetsAt` alone, never by window id. Re-evaluate as `now`
 * moves on.
 * @param {UsageSource[]} sources
 * @param {number} now epoch seconds
 * @returns {{key: string, state: string, text: string, title: string}[]}
 */
export function usageItems(sources, now) {
  const multi = sources.length > 1;
  const items = [];
  for (const s of sources) {
    if (s.windows.length === 0) continue;
    const stale = now - s.observedAt > USAGE_STALE_S;
    const parts = [];
    const resets = [];
    let high = false;
    let live = false;
    for (const w of s.windows) {
      if (w.resetsAt !== null && w.resetsAt <= now) {
        parts.push('—');
        resets.push('—');
        continue;
      }
      const pct = Math.round(w.usedPercentage);
      live = true;
      if (pct >= USAGE_HIGH_PERCENT) high = true;
      parts.push(String(pct));
      resets.push(w.resetsAt === null ? '?' : formatIn(w.resetsAt - now));
    }
    const prefix = multi ? `${s.agent} ` : '';
    items.push({
      key: `usage:${s.agent}`,
      state: high ? 'high' : !live ? 'reset' : stale ? 'stale' : 'usage',
      text: `${prefix}${parts.join('/')}%`,
      title: `${prefix}${resets.join('/')}`,
    });
  }
  return items;
}
