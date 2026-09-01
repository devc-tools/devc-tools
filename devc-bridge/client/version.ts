// Version of the container-side `devc-bridge` client.
//
// Separate from the host's `host/version.ts` rather than imported from it: the client is
// a standalone compile unit with its own permission set, and "which client is actually
// mounted in here" is a question the container has to be able to answer on its own. The
// release workflow's version guard asserts both equal the tag, so they cannot drift
// apart across a release.

/** Client version. Single source of truth — the compiled binary cannot read `deno.json`. */
export const VERSION = '0.1.1';
