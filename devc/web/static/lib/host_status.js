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
 * How long ago something was, from its age in seconds: `just now`, `4 min ago`, `3 h ago`,
 * `2 d ago`. A negative age (a clock a little ahead) is `just now`.
 * @param {number} seconds
 */
export function formatAge(seconds) {
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

/**
 * How long until something, from seconds ahead: `in 12 min`, `in 2 h 5 min`, `in 3 d 4 h`.
 * @param {number} seconds
 */
export function formatIn(seconds) {
  const m = Math.max(0, Math.floor(seconds / 60));
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `in ${h} h ${m % 60} min` : `in ${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `in ${d} d ${h % 24} h` : `in ${d} d`;
}

/**
 * A reset time for a tooltip, in the browser's locale: the time alone when it is within a day
 * of `now`, else with the weekday, else (a week or more) with the date.
 * @param {number} at epoch seconds
 * @param {number} now epoch seconds
 */
export function formatResetTime(at, now) {
  const d = new Date(at * 1000);
  const away = Math.abs(at - now);
  /** @type {Intl.DateTimeFormatOptions} */
  const opts = { hour: '2-digit', minute: '2-digit' };
  if (away >= 7 * 86400) {
    Object.assign(opts, { month: 'short', day: 'numeric' });
  } else if (away >= 86400 || d.getDate() !== new Date(now * 1000).getDate()) {
    opts.weekday = 'short';
  }
  return d.toLocaleString([], opts);
}

/**
 * The strip's items for the usage sources, one per source: its windows' percentages in the
 * source's order, slash-separated, as `77/11%` (prefixed by the agent when there is more than
 * one source). A window whose reset has passed with no newer report is `—`, never the old
 * percentage. The tooltip names each window on its own line. Rendered from `label`,
 * `usedPercentage` and `resetsAt` alone, never by window id. Re-evaluate as `now` moves on.
 * @param {UsageSource[]} sources
 * @param {number} now epoch seconds
 * @param {(at: number, now: number) => string} [fmtTime] formats a reset time
 * @returns {{key: string, state: string, text: string, title: string}[]}
 */
export function usageItems(sources, now, fmtTime = formatResetTime) {
  const multi = sources.length > 1;
  const items = [];
  for (const s of sources) {
    if (s.windows.length === 0) continue;
    const asOf = `as of ${formatAge(now - s.observedAt)}`;
    const stale = now - s.observedAt > USAGE_STALE_S;
    const parts = [];
    const lines = [];
    let high = false;
    let live = false;
    for (const w of s.windows) {
      if (w.resetsAt !== null && w.resetsAt <= now) {
        parts.push('—');
        lines.push(
          `${w.label}: reset at ${fmtTime(w.resetsAt, now)}, no newer report`,
        );
        continue;
      }
      const pct = Math.round(w.usedPercentage);
      live = true;
      if (pct >= USAGE_HIGH_PERCENT) high = true;
      parts.push(String(pct));
      lines.push(
        `${w.label}: ${pct}% used` +
          (w.resetsAt === null
            ? ''
            : `, resets ${fmtTime(w.resetsAt, now)} (${
              formatIn(w.resetsAt - now)
            })`),
      );
    }
    items.push({
      key: `usage:${s.agent}`,
      state: high ? 'high' : !live ? 'reset' : stale ? 'stale' : 'usage',
      text: `${multi ? `${s.agent} ` : ''}${parts.join('/')}%`,
      title: [`${s.agent} usage (${asOf})`, ...lines].join('\n'),
    });
  }
  return items;
}
