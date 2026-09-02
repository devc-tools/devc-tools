// Version of the host-side `devc-bridge` CLI, mirroring `devc/help.ts`'s `VERSION`.
//
// Its own module rather than a const in main.ts so the release workflow's version guard
// can read it with a one-line grep, and so importing it costs nothing (main.ts pulls in
// the server, the tray and the config seeder).
//
// The whole repo moves in lockstep on one `vX.Y.Z` tag (see
// .plans/archived/release-and-installer.md decision 8), so this must equal
// `devc/help.ts`'s VERSION and `devc-bridge/client/version.ts`'s. A tag that disagrees
// with any of the three fails the release workflow before anything is built — the tag is
// the source of truth, and nothing rewrites these files during a build.

/** CLI version. Single source of truth — the compiled binary cannot read `deno.json`. */
export const VERSION = '0.2.0';
