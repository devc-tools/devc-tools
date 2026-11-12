// What a host tile's tab shows (`.plans/archived/devc-web-host-tile-tabs.md`): devc-desktop reads its own
// Herdr session's panes and posts each host tile's facts here (`POST /desktop/host-tiles`, the
// desktop token), and the server hands them to the pages (`host_tiles`) so a host tile's tab reads
// like a terminal tile's: its folder or title, the agent's status, its repo and branch.
//
// Display only. devc web still never learns the app's Herdr session, nor any pane id: a tile is
// named by the slot id the app issued, and nothing here can reach the shell. Only while the page
// is devc's built-in copy (not `--live`, `--live-yolo` or `--source`): under those the route
// answers 409 and nothing is sent, so a page a container could have written sees none of it.

import { UNSHOWABLE } from './desktop_requests.ts';

/** One host tile's facts, as its pane reports them. Every field is text the page shows as text. */
export interface HostTileFacts {
  cwd: string;
  foreground_cwd: string;
  /** The terminal's title, with the agents' status glyphs stripped (Herdr's `_stripped`). */
  title: string;
  /** The agent Herdr detected in the pane (`claude`, say), or `''`. */
  agent: string;
  /** That agent's status (`idle`, `working`, `blocked`, `done`, …), or `''`. */
  agent_status: string;
}

/** The most host tiles one post may name. */
export const MAX_HOST_TILES = 64;

/** A slot id: 32 lowercase hex, as the app issues them (`SLOT_ID` in devc-desktop). */
const SLOT_ID = /^[0-9a-f]{32}$/;

/** Each field's longest value. */
const MAX_LEN: Record<keyof HostTileFacts, number> = {
  cwd: 4096,
  foreground_cwd: 4096,
  title: 512,
  agent: 64,
  agent_status: 32,
};

/** {@link UNSHOWABLE}, every one. */
const UNSHOWABLE_ALL = new RegExp(UNSHOWABLE.source, 'g');

/**
 * `POST /desktop/host-tiles`'s body as the facts by slot id, or null when it is not one:
 * `{"tiles": {"<slot id>": {cwd, foreground_cwd, title, agent, agent_status}}}`, at most
 * {@link MAX_HOST_TILES} tiles, every field a string of at most its length. Controls, bidi
 * overrides and zero-width characters in a value become U+FFFD.
 */
export function parseHostTiles(
  text: string,
): Record<string, HostTileFacts> | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const tiles = (v as { tiles?: unknown } | null)?.tiles;
  if (typeof tiles !== 'object' || tiles === null || Array.isArray(tiles)) {
    return null;
  }
  const entries = Object.entries(tiles);
  if (entries.length > MAX_HOST_TILES) return null;
  const out: Record<string, HostTileFacts> = {};
  for (const [slot, raw] of entries) {
    if (!SLOT_ID.test(slot) || typeof raw !== 'object' || raw === null) {
      return null;
    }
    const facts = {} as HostTileFacts;
    for (const k of Object.keys(MAX_LEN) as (keyof HostTileFacts)[]) {
      const value = (raw as Record<string, unknown>)[k];
      if (typeof value !== 'string' || value.length > MAX_LEN[k]) return null;
      facts[k] = value.replace(UNSHOWABLE_ALL, '�');
    }
    out[slot] = facts;
  }
  return out;
}

/** The `host_tiles` message every page gets, on connecting and on each change. */
export function hostTilesMessage(
  tiles: Readonly<Record<string, HostTileFacts>>,
): { type: 'host_tiles'; tiles: Record<string, HostTileFacts> } {
  return { type: 'host_tiles', tiles: { ...tiles } };
}
