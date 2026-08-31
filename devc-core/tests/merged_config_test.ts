import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from 'jsr:@std/assert@^1';
import {
  ensureMergedConfig,
  mergedConfigPath,
  projectKey,
} from '../merged_config.ts';
import { containerNameForLocalFolder } from '../container.ts';
import { DEVC_CONFIG_FEATURE } from '../overlay.ts';
import { withTemp } from './helpers.ts';

/** Write `text` to `path`, creating parent directories. */
async function write(path: string, text: string): Promise<void> {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(path, text);
}

/** A project dir, a cache root and a config dir under one temp dir. */
async function withProject<T>(
  fn: (
    dirs: { project: string; cacheRoot: string; configDir: string },
  ) => Promise<T>,
): Promise<T> {
  return await withTemp(async (dir) => {
    const project = `${dir}/proj`;
    await Deno.mkdir(project, { recursive: true });
    return await fn({
      project,
      cacheRoot: `${dir}/cache`,
      configDir: `${dir}/config`,
    });
  });
}

/** `ensureMergedConfig` with every real path redirected into the temp dirs. */
function merge(
  dirs: { project: string; cacheRoot: string; configDir: string },
) {
  return ensureMergedConfig(dirs.project, {
    cacheRoot: dirs.cacheRoot,
    templatesDir: `${dirs.cacheRoot}/no-templates`,
    configDir: dirs.configDir,
  });
}

// ── the cache path ──────────────────────────────────────────────────────────────────────────

// Container identity is keyed on the config path, and the CLI strands (never removes) a
// container whose config_file label no longer matches — so this path moving is a bug with a
// permanent cost, not a cosmetic one.
Deno.test('the merged config path is stable across calls for one project', async () => {
  await withProject(async (dirs) => {
    const first = await mergedConfigPath(dirs.project, dirs.cacheRoot);
    await write(`${dirs.project}/.devc/devc.json`, '{"name":"changed"}');
    assertEquals(await mergedConfigPath(dirs.project, dirs.cacheRoot), first);
  });
});

Deno.test('two projects sharing a basename get different cache directories', async () => {
  await withTemp(async (dir) => {
    const a = await mergedConfigPath(`${dir}/one/proj`, `${dir}/cache`);
    const b = await mergedConfigPath(`${dir}/two/proj`, `${dir}/cache`);
    assert(a !== b, 'want distinct paths');
  });
});

// The container and its config directory are meant to be recognizably about the same project.
Deno.test('the container name is the project key with devc- in front', async () => {
  assertEquals(
    await containerNameForLocalFolder('/home/me/src/myproject'),
    `devc-${await projectKey('/home/me/src/myproject')}`,
  );
});

Deno.test('the merged file is written 0600', async () => {
  await withProject(async (dirs) => {
    await write(
      `${dirs.project}/.devcontainer/devcontainer.json`,
      '{"image":"x"}',
    );
    const merged = await merge(dirs);
    const mode = (await Deno.stat(merged.path)).mode;
    if (mode !== null) assertEquals(mode & 0o777, 0o600);
  });
});

Deno.test('concurrent calls leave one complete file', async () => {
  await withProject(async (dirs) => {
    await write(
      `${dirs.project}/.devcontainer/devcontainer.json`,
      '{"image":"x"}',
    );
    const results = await Promise.all([merge(dirs), merge(dirs), merge(dirs)]);
    assertEquals(new Set(results.map((r) => r.path)).size, 1);
    const text = await Deno.readTextFile(results[0].path);
    assertEquals(JSON.parse(text).image, 'x');
    // No staging file left behind.
    const dir = results[0].path.slice(0, results[0].path.lastIndexOf('/'));
    const left: string[] = [];
    for await (const e of Deno.readDir(dir)) left.push(e.name);
    assertEquals(left, ['devcontainer.json']);
  });
});

// ── modes ───────────────────────────────────────────────────────────────────────────────────

Deno.test('a project with its own config is project mode, and the base is that config', async () => {
  await withProject(async (dirs) => {
    const base = `${dirs.project}/.devcontainer/devcontainer.json`;
    await write(base, '{"image":"ubuntu"}');
    const merged = await merge(dirs);
    assertEquals(merged.mode, 'project');
    assertEquals(merged.baseConfigPath, base);
    assertEquals(merged.config.image, 'ubuntu');
  });
});

Deno.test('a project with a root .devcontainer.json is project mode too', async () => {
  await withProject(async (dirs) => {
    await write(`${dirs.project}/.devcontainer.json`, '{"image":"ubuntu"}');
    const merged = await merge(dirs);
    assertEquals(merged.mode, 'project');
  });
});

Deno.test('a project with no config is zero-config, on the bundled default', async () => {
  await withProject(async (dirs) => {
    const merged = await merge(dirs);
    assertEquals(merged.mode, 'zero-config');
    assert(
      merged.baseConfigPath.startsWith(`${dirs.cacheRoot}/default-`),
      merged.baseConfigPath,
    );
    assertEquals(merged.config.name, 'Default');
  });
});

// In project mode the CLI still records the project's own config path, so a relative value
// already resolves where the project meant — rewriting it there would be wrong.
Deno.test('project mode leaves relative build paths untouched', async () => {
  await withProject(async (dirs) => {
    await write(
      `${dirs.project}/.devcontainer/devcontainer.json`,
      JSON.stringify({ build: { dockerfile: 'Dockerfile', context: '..' } }),
    );
    const merged = await merge(dirs);
    assertEquals(merged.config.build, {
      dockerfile: 'Dockerfile',
      context: '..',
    });
  });
});

// In zero-config the merged file *is* the config path, so a relative value would resolve into
// the per-project cache dir beside it instead of the materialized default tree.
Deno.test('zero-config resolves build.dockerfile and context into the default tree', async () => {
  await withProject(async (dirs) => {
    const merged = await merge(dirs);
    const build = merged.config.build as Record<string, string>;
    const baseDir = merged.baseConfigPath.slice(
      0,
      merged.baseConfigPath.lastIndexOf('/'),
    );
    assertEquals(build.dockerfile, `${baseDir}/Dockerfile`);
    assertEquals(build.context, baseDir);
    // And the file it points at is really there.
    assert((await Deno.stat(build.dockerfile)).isFile);
  });
});

// ── the layers ──────────────────────────────────────────────────────────────────────────────

Deno.test('project overlay beats user overlay beats base config', async () => {
  await withProject(async (dirs) => {
    await write(
      `${dirs.project}/.devcontainer/devcontainer.json`,
      JSON.stringify({ image: 'x', remoteEnv: { A: 'base', B: 'base' } }),
    );
    await write(
      `${dirs.configDir}/devc.json`,
      JSON.stringify({ remoteEnv: { A: 'user', C: 'user' } }),
    );
    await write(
      `${dirs.project}/.devc/devc.json`,
      JSON.stringify({ remoteEnv: { A: 'project' } }),
    );
    const merged = await merge(dirs);
    assertEquals(merged.config.remoteEnv, {
      A: 'project',
      B: 'base',
      C: 'user',
    });
  });
});

Deno.test('overlay mounts append to the base config, user first', async () => {
  await withProject(async (dirs) => {
    await write(
      `${dirs.project}/.devcontainer/devcontainer.json`,
      JSON.stringify({
        image: 'x',
        mounts: ['type=bind,source=/base,target=/base'],
      }),
    );
    await write(
      `${dirs.configDir}/devc.json`,
      JSON.stringify({ mounts: ['type=bind,source=/user,target=/user'] }),
    );
    await write(
      `${dirs.project}/.devc/devc.json`,
      JSON.stringify({ mounts: ['type=bind,source=/proj,target=/proj'] }),
    );
    assertEquals(await (await merge(dirs)).config.mounts, [
      'type=bind,source=/base,target=/base',
      'type=bind,source=/user,target=/user',
      'type=bind,source=/proj,target=/proj',
    ]);
  });
});

// What the flag-era overlay could not do at all: replace something the base config declares.
Deno.test('an overlay mount on a base mount target replaces it, read-only and all', async () => {
  await withProject(async (dirs) => {
    await write(
      `${dirs.project}/.devcontainer/devcontainer.json`,
      JSON.stringify({
        image: 'x',
        mounts: ['type=bind,source=/base,target=/shared'],
      }),
    );
    await write(
      `${dirs.project}/.devc/devc.json`,
      JSON.stringify({
        mounts: ['type=bind,source=/mine,target=/shared,readonly'],
      }),
    );
    assertEquals(await (await merge(dirs)).config.mounts, [
      'type=bind,source=/mine,target=/shared,readonly',
    ]);
  });
});

Deno.test('an overlay can delete a base config key outright', async () => {
  await withProject(async (dirs) => {
    await write(
      `${dirs.project}/.devcontainer/devcontainer.json`,
      JSON.stringify({ image: 'x', initializeCommand: 'setup.sh' }),
    );
    await write(
      `${dirs.project}/.devc/devc.json`,
      '{"initializeCommand":null}',
    );
    const merged = await merge(dirs);
    assertEquals('initializeCommand' in merged.config, false);
  });
});

// ── devc's own layer ────────────────────────────────────────────────────────────────────────

Deno.test('the baseline Feature is merged in under everything else', async () => {
  await withProject(async (dirs) => {
    await write(
      `${dirs.project}/.devcontainer/devcontainer.json`,
      JSON.stringify({ image: 'x', features: { 'ghcr.io/x/rust:1': {} } }),
    );
    const features = (await merge(dirs)).config.features as Record<
      string,
      unknown
    >;
    assertEquals(features[DEVC_CONFIG_FEATURE], {});
    assertEquals(features['ghcr.io/x/rust:1'], {});
  });
});

Deno.test('a config declaring devc-config itself suppresses the injected one', async () => {
  await withProject(async (dirs) => {
    await write(
      `${dirs.project}/.devcontainer/devcontainer.json`,
      JSON.stringify({
        image: 'x',
        features: { 'ghcr.io/devc-tools/features/devc-config:0': {} },
      }),
    );
    assertEquals(
      Object.keys((await merge(dirs)).config.features as object),
      ['ghcr.io/devc-tools/features/devc-config:0'],
    );
  });
});

Deno.test('baselineFeatures:false leaves the config without devc-config', async () => {
  await withProject(async (dirs) => {
    await write(
      `${dirs.project}/.devcontainer/devcontainer.json`,
      '{"image":"x"}',
    );
    await write(
      `${dirs.project}/.devc/devc.json`,
      '{"baselineFeatures":false}',
    );
    const merged = await merge(dirs);
    assertEquals(merged.config.features, undefined);
    // And the devc-only key never reaches the config.
    assertEquals('baselineFeatures' in merged.config, false);
  });
});

// The bridge mount used to reach zero-config containers only, because injecting it meant writing
// into the materialized cache config and devc will not write into a project's .devcontainer/.
Deno.test('a devc-bridge opt-in gets the token mount in project mode', async () => {
  await withProject(async (dirs) => {
    await write(
      `${dirs.project}/.devcontainer/devcontainer.json`,
      '{"image":"x"}',
    );
    await write(
      `${dirs.project}/.devc/devc.json`,
      JSON.stringify({
        features: { 'ghcr.io/devc-tools/features/devc-bridge:0': {} },
      }),
    );
    const mounts = (await merge(dirs)).config.mounts as string[];
    const bridge = mounts.filter((m) => m.includes('/run/devc-bridge'));
    assertEquals(bridge.length, 1);
    assertEquals(bridge[0].split(',').includes('readonly'), true);
  });
});

Deno.test('no bridge opt-in, no token mount', async () => {
  await withProject(async (dirs) => {
    await write(
      `${dirs.project}/.devcontainer/devcontainer.json`,
      '{"image":"x"}',
    );
    const mounts = ((await merge(dirs)).config.mounts ?? []) as string[];
    assertEquals(mounts.filter((m) => m.includes('/run/devc-bridge')), []);
  });
});

// ── failure ─────────────────────────────────────────────────────────────────────────────────

Deno.test('an unparseable base config fails, naming the file', async () => {
  await withProject(async (dirs) => {
    const base = `${dirs.project}/.devcontainer/devcontainer.json`;
    await write(base, '{ not json at all');
    const err = await assertRejects(() => merge(dirs), Error);
    assertStringIncludes(err.message, base);
  });
});

Deno.test('an unparseable overlay fails, naming the overlay', async () => {
  await withProject(async (dirs) => {
    await write(
      `${dirs.project}/.devcontainer/devcontainer.json`,
      '{"image":"x"}',
    );
    const overlay = `${dirs.project}/.devc/devc.json`;
    await write(overlay, '{ nope');
    const err = await assertRejects(() => merge(dirs), Error);
    assertStringIncludes(err.message, overlay);
  });
});

// ── the standalone invariant ────────────────────────────────────────────────────────────────

Deno.test('merging writes nothing into the project', async () => {
  await withProject(async (dirs) => {
    const base = `${dirs.project}/.devcontainer/devcontainer.json`;
    const original = '{\n  // hand-written\n  "image": "x",\n}\n';
    await write(base, original);
    await write(
      `${dirs.project}/.devc/devc.json`,
      '{"mounts":["type=bind,source=/a,target=/b"]}',
    );

    const before = await Deno.stat(base);
    const merged = await merge(dirs);

    assertEquals(await Deno.readTextFile(base), original);
    assertEquals((await Deno.stat(base)).mtime, before.mtime);
    // The merged file is in the cache, not in the project.
    assert(merged.path.startsWith(dirs.cacheRoot), merged.path);

    const entries: string[] = [];
    for await (const e of Deno.readDir(dirs.project)) entries.push(e.name);
    assertEquals(entries.sort(), ['.devc', '.devcontainer']);
  });
});
