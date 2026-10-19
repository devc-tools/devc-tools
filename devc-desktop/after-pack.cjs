// electron-builder afterPack hook. node-pty ships macOS prebuilds whose `spawn-helper` npm
// unpacks without its execute bit (node-pty's own postinstall only fixes the current
// platform's), and node-pty starts every shell through that helper: without the bit the host
// terminal fails with "posix_spawnp failed". So every spawn-helper in the packed app is made
// executable, whichever OS packed it.
const { chmod, readdir } = require('node:fs/promises');
const { join } = require('node:path');

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name === 'spawn-helper') yield p;
  }
}

exports.default = async function afterPack({ appOutDir }) {
  for await (const helper of walk(appOutDir)) await chmod(helper, 0o755);
};
