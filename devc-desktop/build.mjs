// Bundles devc-desktop for Electron: the main process and the preloads as CommonJS for Node, the
// bundled pages as classic browser scripts (a module would not load from file:), plus their HTML
// and CSS and xterm.js's stylesheet. The Containers pane is devc web's own Containers section,
// bundled from this checkout's devc/web/static/ (containers.js and what it imports, and
// style.css) into build/containers/, so `devc web --live` never changes it: a change there
// reaches the app at its next build, as do the host terminal's tiles (devc web's layout.js and
// style.css). Output in build/, which electron-builder packs.
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const out = 'build';
/** devc web's page, in this checkout. */
const DEVC_WEB = '../devc/web/static';
await rm(out, { recursive: true, force: true });
await mkdir(`${out}/renderer`, { recursive: true });
await mkdir(`${out}/containers`, { recursive: true });

const node = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'node-pty'],
  // The main process uses devc web's theme palettes (`lib/themes.js`).
  alias: { 'devc-web': DEVC_WEB },
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
    ...node,
    entryPoints: ['src/preload/containers.ts'],
    outfile: `${out}/preload-containers.js`,
  }),
  build({
    ...node,
    entryPoints: ['src/preload/menu.ts'],
    outfile: `${out}/preload-menu.js`,
  }),
  build({
    ...node,
    entryPoints: ['src/preload/rail.ts'],
    outfile: `${out}/preload-rail.js`,
  }),
  build({
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome140',
    entryPoints: {
      host: 'src/renderer/host.ts',
      slot: 'src/renderer/slot.ts',
      status: 'src/renderer/status.ts',
      titlebar: 'src/renderer/titlebar.ts',
      menu: 'src/renderer/menu.ts',
      rail: 'src/renderer/rail.ts',
    },
    alias: { 'devc-web': DEVC_WEB },
    outdir: `${out}/renderer`,
    logLevel: 'warning',
  }),
  build({
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome140',
    entryPoints: { containers: 'src/renderer/containers.ts' },
    alias: { 'devc-web': DEVC_WEB },
    outdir: `${out}/containers`,
    logLevel: 'warning',
  }),
]);
for (
  const f of [
    'host.html',
    'host.css',
    'slot.html',
    'slot.css',
    'status.html',
    'status.css',
    'titlebar.html',
    'titlebar.css',
    'actions.css',
    'menu.html',
    'menu.css',
    'rail.html',
    'rail.css',
  ]
) {
  await cp(`src/renderer/${f}`, `${out}/renderer/${f}`);
}
for (const f of ['containers.html', 'pane.css', 'actions.css']) {
  await cp(`src/renderer/${f}`, `${out}/containers/${f}`);
}
await cp(`${DEVC_WEB}/style.css`, `${out}/containers/style.css`);
// The host terminal's tiles are devc web's: its Golden Layout wrapper and how it draws them.
await cp(`${DEVC_WEB}/style.css`, `${out}/renderer/style.css`);
await cp(
  `${DEVC_WEB}/vendor/golden-layout/css/goldenlayout-base.css`,
  `${out}/renderer/goldenlayout-base.css`,
);
await cp(
  `${DEVC_WEB}/vendor/golden-layout/css/themes/goldenlayout-dark-theme.css`,
  `${out}/renderer/goldenlayout-dark-theme.css`,
);
await cp(
  'node_modules/@xterm/xterm/css/xterm.css',
  `${out}/renderer/xterm.css`,
);
