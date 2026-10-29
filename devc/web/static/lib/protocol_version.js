// The version of the `/ws` messages `containers.js` (and what it imports) relies on. The server
// sends it in `hello` (`protocol`); devc-desktop bundles the Containers section with the value it
// was built from, and draws nothing when its server speaks another. Bump it with any change to
// those messages, on either side.

/** The `/ws` protocol version. */
export const PROTOCOL = 1;
