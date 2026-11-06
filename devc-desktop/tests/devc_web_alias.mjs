// `devc-web/…` for the tests, as `build.mjs`'s esbuild alias resolves it for the app: devc web's
// page modules (`../devc/web/static/`). Loaded with `node --import` before the tests.

import { registerHooks } from 'node:module';

const BASE = new URL('../../devc/web/static/', import.meta.url);

registerHooks({
  resolve(specifier, context, next) {
    return specifier.startsWith('devc-web/')
      ? next(new URL(specifier.slice('devc-web/'.length), BASE).href, context)
      : next(specifier, context);
  },
});
