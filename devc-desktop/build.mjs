// Bundles devc-desktop for Electron: the main process and the three preloads as CommonJS for Node,
// the three bundled pages as classic browser scripts (a module would not load from file:), plus
// their HTML and CSS and xterm.js's stylesheet. Output in build/, which electron-builder packs.
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const out = 'build';
await rm(out, { recursive: true, force: true });
await mkdir(`${out}/renderer`, { recursive: true });

const node = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'node-pty'],
  logLevel: 'warning',
};
await Promise.all([
  build({
    ...node,
    entryPoints: ['src/main/main.ts'],
    outfile: `${out}/main.js`,
  }),
  build({
    ...node,
    entryPoints: ['src/preload/host.ts'],
    outfile: `${out}/preload-host.js`,
  }),
  build({
    ...node,
    entryPoints: ['src/preload/status.ts'],
    outfile: `${out}/preload-status.js`,
  }),
  build({
    ...node,
    entryPoints: ['src/preload/titlebar.ts'],
    outfile: `${out}/preload-titlebar.js`,
  }),
  build({
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome140',
    entryPoints: {
      host: 'src/renderer/host.ts',
      status: 'src/renderer/status.ts',
      titlebar: 'src/renderer/titlebar.ts',
    },
    outdir: `${out}/renderer`,
    logLevel: 'warning',
  }),
]);
for (
  const f of [
    'host.html',
    'host.css',
    'status.html',
    'status.css',
    'titlebar.html',
    'titlebar.css',
  ]
) {
  await cp(`src/renderer/${f}`, `${out}/renderer/${f}`);
}
await cp(
  'node_modules/@xterm/xterm/css/xterm.css',
  `${out}/renderer/xterm.css`,
);
