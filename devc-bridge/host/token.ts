// Shared-secret token management for the bridge.
//
// The token file is a *delivery channel*, not an authority. The running server compares
// every request against the token it holds in memory (`core.ts`), so a container writing
// this file grants itself nothing — it only breaks its own next call.
//
// Two consequences shape the code below.
//
// A fresh token is generated on every start rather than adopting whatever is in the file.
// Adoption was the one way a writable run/ became an escalation: a container could pin an
// attacker-chosen secret and have the *next* start take it up, handing bridge access to
// something that was never given the mount. Regenerating costs nothing, because the client
// re-reads the file on every invocation and the mount is a live directory — a running
// container picks the new value up with nothing restarted.
//
// The write must assume the directory is container-writable. devc mounts run/ read-only,
// but that is the consumer's devcontainer.json to get right, and a Docker Compose
// devcontainer cannot have it at all (the CLI drops `readonly` when generating the compose
// file). A container that can write the directory can replace `token` with a symlink to any
// host path, and a plain write would follow it and overwrite that file with the new token.
// So every write goes to a temp file in the *same* directory and is renamed into place:
// rename replaces a symlink instead of following it, and is atomic, so a client never reads
// a half-written token. Mode is 0644 because the container user may map to a different uid
// and must still read it — on a Docker Desktop bind mount the mode is cosmetic anyway.

import { dirname, join } from '@std/path';

/**
 * Generate a new token and write it to `path`, replacing whatever was there.
 *
 * Deliberately *not* "load or create": see the file header. Renamed from `ensureToken` so
 * that a caller expecting the old adopt-if-present behavior fails to compile rather than
 * silently changing meaning.
 */
export async function resetToken(path: string): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  await writeTokenFile(path, token);
  return token;
}

/**
 * Write `token` to `path` without ever following a symlink at `path`.
 *
 * Same-directory temp + rename: `Deno.rename` replaces the link itself, so a planted
 * symlink is destroyed rather than written through, and the swap is atomic for readers.
 */
async function writeTokenFile(path: string, token: string): Promise<void> {
  const dir = dirname(path);
  await Deno.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.token.tmp.${crypto.randomUUID()}`);
  try {
    await Deno.writeTextFile(tmp, token + '\n');
    await Deno.chmod(tmp, 0o644);
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}

// ── per-container tokens ─────────────────────────────────────────────────────────────────────
//
// devc gives each workspace its own directory, `keys/<key>/`, bind-mounted read-only as that
// container's `/run/devc-bridge`. devc creates the directory and never writes a token into it; the
// bridge mints one into **every** key directory it finds — all of them on start, and any that
// appear later — so the generate-never-adopt rule above holds per directory too. `run/token` stays
// the shared legacy token for containers that mount `run/` whole.

// A key is a bare directory name — the same shape devc's `projectKey` produces.
const KEY_RE = /^[A-Za-z0-9._-]+$/;

/** Who a request came from: a workspace key, or `null` for the shared legacy token. */
export interface Caller {
  key: string | null;
}

/**
 * Every token this bridge has issued, and whom each identifies.
 *
 * Tokens are looked up by value, so a request carrying a token found on disk but never minted by
 * this process — a planted one — identifies nobody.
 */
export class TokenRegistry {
  readonly #keysDir: string;
  readonly #byToken = new Map<string, Caller>();
  readonly #byKey = new Map<string, string>();
  #syncing: Promise<string[]> = Promise.resolve([]);

  constructor(sharedToken: string, keysDir: string) {
    this.#keysDir = keysDir;
    this.#byToken.set(sharedToken, { key: null });
  }

  /** The caller `token` identifies, or null when this bridge never issued it. */
  identify(token: unknown): Caller | null {
    if (typeof token !== 'string') return null;
    return this.#byToken.get(token) ?? null;
  }

  /** Keys that currently hold a token, sorted. */
  keys(): string[] {
    return [...this.#byKey.keys()].sort();
  }

  /**
   * Bring the registry in line with `keys/`: mint for every key directory that has no token from
   * this process — new, or whose file no longer holds what was minted (deleted, or rewritten by
   * someone else) — and forget keys whose directory is gone. Serialized, so overlapping watch
   * events cannot mint twice. Returns the keys minted.
   */
  sync(): Promise<string[]> {
    this.#syncing = this.#syncing.catch(() => []).then(() => this.#syncOnce());
    return this.#syncing;
  }

  async #syncOnce(): Promise<string[]> {
    const present = new Set<string>();
    try {
      for await (const entry of Deno.readDir(this.#keysDir)) {
        // `isDirectory` is false for a symlink, even one to a directory: a key dir the bridge
        // writes into must be a real directory under keys/.
        if (!entry.isDirectory || !KEY_RE.test(entry.name)) continue;
        if (entry.name === '.' || entry.name === '..') continue;
        present.add(entry.name);
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }

    for (const [key, token] of this.#byKey) {
      if (present.has(key)) continue;
      this.#byKey.delete(key);
      this.#byToken.delete(token);
    }

    const minted: string[] = [];
    for (const key of present) {
      const path = join(this.#keysDir, key, 'token');
      const held = this.#byKey.get(key);
      if (held !== undefined && await readToken(path) === held) continue;
      let token: string;
      try {
        token = await resetToken(path);
      } catch {
        continue; // removed mid-sync; the next event will settle it
      }
      if (held !== undefined) this.#byToken.delete(held);
      this.#byKey.set(key, token);
      this.#byToken.set(token, { key });
      minted.push(key);
    }
    return minted.sort();
  }
}

async function readToken(path: string): Promise<string | null> {
  try {
    return (await Deno.readTextFile(path)).trim();
  } catch {
    return null;
  }
}
