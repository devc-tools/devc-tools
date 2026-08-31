import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from 'jsr:@std/assert@^1';
import { fromFileUrl } from 'jsr:@std/path@^1';
import {
  declaresBridgeFeature,
  declaresFeatureNamed,
  ensureClaudeSeedDir,
  findOwnDevcontainerConfig,
  installBundledAssets,
  loadConfigStrict,
  materializeDefaultConfig,
  resolveRemoteEnv,
  substituteVars,
} from '../default_config.ts';

async function mkdir(path: string) {
  await Deno.mkdir(path, { recursive: true });
}

/** Drop `//`-to-end-of-line comment lines so a JSONC config parses as JSON. */
function stripLineComments(text: string): string {
  return text.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
}

async function withTempDir(fn: (tmp: string) => Promise<void>) {
  const tmp = await Deno.makeTempDir();
  try {
    await fn(tmp);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

/**
 * A templates dir that cannot exist, so the bundled-only behavior is asserted without depending
 * on whether the machine running the tests happens to have `~/.config/devc/templates`.
 */
const NO_TEMPLATES = '/nonexistent/devc-templates';

Deno.test('findOwnDevcontainerConfig is null for a plain directory', async () => {
  await withTempDir(async (tmp) => {
    assertEquals(await findOwnDevcontainerConfig(tmp), null);
  });
});

Deno.test('findOwnDevcontainerConfig returns the .devcontainer/devcontainer.json path', async () => {
  await withTempDir(async (tmp) => {
    await mkdir(`${tmp}/.devcontainer`);
    await Deno.writeTextFile(`${tmp}/.devcontainer/devcontainer.json`, '{}');
    assertEquals(
      await findOwnDevcontainerConfig(tmp),
      `${tmp}/.devcontainer/devcontainer.json`,
    );
  });
});

Deno.test('findOwnDevcontainerConfig returns the .devcontainer.json path', async () => {
  await withTempDir(async (tmp) => {
    await Deno.writeTextFile(`${tmp}/.devcontainer.json`, '{}');
    assertEquals(
      await findOwnDevcontainerConfig(tmp),
      `${tmp}/.devcontainer.json`,
    );
  });
});

Deno.test('findOwnDevcontainerConfig prefers .devcontainer/devcontainer.json over .devcontainer.json', async () => {
  await withTempDir(async (tmp) => {
    await mkdir(`${tmp}/.devcontainer`);
    await Deno.writeTextFile(`${tmp}/.devcontainer/devcontainer.json`, '{}');
    await Deno.writeTextFile(`${tmp}/.devcontainer.json`, '{}');
    assertEquals(
      await findOwnDevcontainerConfig(tmp),
      `${tmp}/.devcontainer/devcontainer.json`,
    );
  });
});

Deno.test('substituteVars resolves ${containerWorkspaceFolder}', () => {
  assertEquals(
    substituteVars('${containerWorkspaceFolder}/sub', '/workspaces/x'),
    '/workspaces/x/sub',
  );
});

Deno.test('substituteVars resolves ${localEnv:HOME}', () => {
  const home = Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE') ?? '.';
  assertEquals(
    substituteVars('${localEnv:HOME}/foo', '/workspaces/x'),
    `${home}/foo`,
  );
});

Deno.test('substituteVars resolves an arbitrary ${localEnv:VAR}', () => {
  const prev = Deno.env.get('SOME_VAR');
  Deno.env.set('SOME_VAR', '/custom/path');
  Deno.env.delete('UNSET_VAR');
  try {
    assertEquals(
      substituteVars('${localEnv:SOME_VAR}/foo', '/workspaces/x'),
      '/custom/path/foo',
    );
    assertEquals(
      substituteVars('${localEnv:UNSET_VAR}/foo', '/workspaces/x'),
      '/foo',
    );
  } finally {
    if (prev === undefined) Deno.env.delete('SOME_VAR');
    else Deno.env.set('SOME_VAR', prev);
  }
});

Deno.test('substituteVars resolves both variables in one value', () => {
  const home = Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE') ?? '.';
  assertEquals(
    substituteVars(
      '${localEnv:HOME}/data:${containerWorkspaceFolder}/data',
      '/workspaces/x',
    ),
    `${home}/data:/workspaces/x/data`,
  );
});

Deno.test('resolveRemoteEnv resolves ${containerWorkspaceFolder}', () => {
  assertEquals(
    resolveRemoteEnv({
      remoteEnv: {
        PROJECT_PATH: '${containerWorkspaceFolder}',
        TZ: 'America/Chicago',
      },
    }, '/workspaces/myproject'),
    { PROJECT_PATH: '/workspaces/myproject', TZ: 'America/Chicago' },
  );
});

Deno.test('resolveRemoteEnv returns {} when the config has no remoteEnv', () => {
  assertEquals(resolveRemoteEnv({}, '/workspaces/x'), {});
  assertEquals(
    resolveRemoteEnv({ remoteEnv: 'nonsense' }, '/workspaces/x'),
    {},
  );
  assertEquals(resolveRemoteEnv({ remoteEnv: ['a'] }, '/workspaces/x'), {});
});

Deno.test('resolveRemoteEnv skips non-string remoteEnv values', () => {
  assertEquals(
    resolveRemoteEnv(
      { remoteEnv: { OK: 'yes', N: 1, B: true, O: {} } },
      '/workspaces/x',
    ),
    { OK: 'yes' },
  );
});

Deno.test('resolveRemoteEnv resolves ${localWorkspaceFolder} and its basename when given the local folder', () => {
  assertEquals(
    resolveRemoteEnv(
      {
        remoteEnv: {
          LOCAL: '${localWorkspaceFolder}',
          BASE: '${localWorkspaceFolderBasename}',
        },
      },
      '/workspaces/myproject',
      '/home/me/src/myproject',
    ),
    { LOCAL: '/home/me/src/myproject', BASE: 'myproject' },
  );
});

// The overlay's own remoteEnv is merged into the config before this ever runs, so there is no
// second layer to apply here — which is the simplification the merge bought.
Deno.test('resolveRemoteEnv reads one merged object, not a base plus an overlay', () => {
  assertEquals(
    resolveRemoteEnv(
      { remoteEnv: { FROM_BASE: 'a', OVERRIDDEN: 'from-overlay' } },
      '/workspaces/x',
    ),
    { FROM_BASE: 'a', OVERRIDDEN: 'from-overlay' },
  );
});

// A project's own devcontainer.json is hand-written, so the reader has to survive real JSONC —
// not just whole-line `//`.
Deno.test('loadConfigStrict parses trailing commas, block comments, and end-of-line comments', async () => {
  await withTempDir(async (tmp) => {
    await Deno.writeTextFile(
      `${tmp}/devcontainer.json`,
      `{
  /* block
     comment */
  "remoteEnv": {
    "FOO": "bar", // trailing note after a value
    "BAZ": "qux",
  },
}`,
    );
    assertEquals(await loadConfigStrict(`${tmp}/devcontainer.json`), {
      remoteEnv: { FOO: 'bar', BAZ: 'qux' },
    });
  });
});

// Unforgiving, deliberately: this config is a layer of the merge that decides what container
// comes up, so a config devc could not read must fail loudly rather than degrade to `{}`.
Deno.test('loadConfigStrict throws naming the file when the config is unparseable', async () => {
  await withTempDir(async (tmp) => {
    const path = `${tmp}/devcontainer.json`;
    await Deno.writeTextFile(path, '{ not json at all');
    const err = await assertRejects(() => loadConfigStrict(path), Error);
    assertStringIncludes(err.message, path);
    assertStringIncludes(err.message, 'could not parse as JSONC');
  });
});

Deno.test('loadConfigStrict throws naming the file when the config is missing', async () => {
  await withTempDir(async (tmp) => {
    const path = `${tmp}/nope.json`;
    const err = await assertRejects(() => loadConfigStrict(path), Error);
    assertStringIncludes(err.message, path);
  });
});

Deno.test('loadConfigStrict throws when the config is not a JSON object', async () => {
  await withTempDir(async (tmp) => {
    const path = `${tmp}/devcontainer.json`;
    await Deno.writeTextFile(path, '[1, 2, 3]');
    const err = await assertRejects(() => loadConfigStrict(path), Error);
    assertStringIncludes(err.message, 'expected a JSON object');
  });
});

// `${localWorkspaceFolder}` is a prefix of `${localWorkspaceFolderBasename}`, so substituting
// in the wrong order yields `/home/me/src/myprojectBasename}`.
Deno.test('substituteVars substitutes the basename token before the folder token', () => {
  assertEquals(
    substituteVars(
      '${localWorkspaceFolderBasename}:${localWorkspaceFolder}',
      '/workspaces/x',
      '/home/me/src/myproject',
    ),
    'myproject:/home/me/src/myproject',
  );
});

Deno.test('substituteVars leaves local-folder tokens alone when no local folder is given', () => {
  assertEquals(
    substituteVars('${localWorkspaceFolder}/x', '/workspaces/x'),
    '${localWorkspaceFolder}/x',
  );
});

Deno.test('materializeDefaultConfig copies the embedded tree flat to cacheDir and returns the config path', async () => {
  await withTempDir(async (cacheDir) => {
    const path = await materializeDefaultConfig(cacheDir, NO_TEMPLATES);
    // Flat layout: zero-config uses no project `.devcontainer/`, so the cache holds the
    // config, Dockerfile and the one lifecycle entry script directly.
    assertEquals(path, `${cacheDir}/devcontainer.json`);

    for (
      const file of [
        'devcontainer.json',
        'Dockerfile',
        'initialize-command.sh',
      ]
    ) {
      assertEquals((await Deno.stat(`${cacheDir}/${file}`)).isFile, true);
    }
  });
});

Deno.test('materialized (zero-config) devcontainer.json has no local Feature, keeps the ghcr ones, and the baseline runs via agents/git-container-config Features', async () => {
  await withTempDir(async (cacheDir) => {
    await materializeDefaultConfig(cacheDir, NO_TEMPLATES);

    // The cache copy is verbatim JSONC — strip line comments before parsing.
    const dc = JSON.parse(
      stripLineComments(
        await Deno.readTextFile(`${cacheDir}/devcontainer.json`),
      ),
    );
    // No local Feature reference (the baseline is delivered another way)...
    assertEquals(Object.hasOwn(dc.features, './features/devc'), false);
    // ...ghcr features kept...
    assertEquals(
      Object.hasOwn(dc.features, 'ghcr.io/devcontainers/features/node:1'),
      true,
    );
    // ...the agents/git-container-config Features declared statically, with the options
    // Contracts specify (agents' installClaudeCli/installCopilotCli/installHerdr/
    // installPiCli/piPackages; a bare {} for git-container-config)...
    assertEquals(dc.features['ghcr.io/devc-tools/agents:0'], {
      installClaudeCli: true,
      installCopilotCli: false,
      installHerdr: true,
      installPiCli: true,
      piPackages: 'npm:@andrewjacop/pi-herdr',
    });
    assertEquals(
      dc.features['ghcr.io/devc-tools/git-container-config:0'],
      {},
    );
    // ...and the devc-config Feature is deliberately absent here too — devc contributes it
    // dynamically, via withBaselineFeatures/--additional-features, never by declaring it in the
    // bundled config itself. What this Feature does (running a devc-post-create.sh a project
    // committed for devc's own convention) is devc-specific, so unlike the other bundled
    // Features it is fine for a `devc init`-scaffolded project to lose it once `devc` itself is
    // uninstalled — see overlay.ts's DEVC_CONFIG_FEATURE doc comment.
    assertEquals(
      Object.hasOwn(
        dc.features,
        'ghcr.io/devc-tools/devc-config:0.1.0',
      ),
      false,
    );
    // ...and there is no devc-owned create-time orchestrator left at all — both lifecycle
    // command keys are now absent; the baseline runs via the two Features' own
    // postCreateCommands instead, ordered by installsAfter (see overlay.ts).
    assertEquals(dc.postCreateCommand, undefined);
    assertEquals(dc.onCreateCommand, undefined);
  });
});

Deno.test('canonical default devcontainer.json has no local Feature and no devc-owned lifecycle command', async () => {
  // The embedded source is what `devc config` writes into a project, and what the zero-config
  // cache copies verbatim (see the materialize test above) — there is nothing left for
  // materializeDefaultConfig to rewrite here.
  const text = await Deno.readTextFile(
    new URL('../default/devcontainer.json', import.meta.url),
  );
  const dc = JSON.parse(stripLineComments(text));
  assertEquals(Object.hasOwn(dc.features, './features/devc'), false);
  // Neither onCreateCommand nor postCreateCommand: with agents-setup.sh, git-setup.sh and
  // bashrc-additions.sh all gone, devc-core/default/ has no create-time orchestrator of its
  // own left — the baseline is delivered entirely by the agents/git-container-config
  // Features' own postCreateCommands now. See .plans/archived/devc-swap-baseline-features.md.
  assertEquals(dc.postCreateCommand, undefined);
  assertEquals(dc.onCreateCommand, undefined);
});

Deno.test('canonical default devcontainer.json does not install devc-bridge', async () => {
  // The bridge is an opt-in add-on, never part of devc's baseline — neither as a Feature
  // reference nor as mounts of devc's own. Two reasons, and the first is the load-bearing
  // one: a devc container must come up on a host that never installed the bridge, and a
  // Feature ref in the *bundled* default makes every create depend on that ref resolving,
  // so an unpublished (or renamed, or yanked) Feature breaks devc for everyone. Second,
  // carrying mounts here as well as in the Feature would collide for anyone who did opt
  // in — Docker fails a create with `Duplicate mount point` on the same target twice.
  // Opting in is `additionalFeatures` in a user- or project-level devc.json.
  const text = await Deno.readTextFile(
    new URL('../default/devcontainer.json', import.meta.url),
  );
  const dc = JSON.parse(stripLineComments(text));

  assertEquals(
    Object.keys(dc.features).filter((id) => id.includes('devc-bridge')),
    [],
    'devc-bridge must not be a baseline Feature — it is opt-in',
  );

  const mounts: string[] = dc.mounts;
  assertEquals(
    mounts.filter((m) => m.includes('/.config/devc-bridge/')),
    [],
    'devc must not carry bridge mounts of its own',
  );

  // Not even in a comment. This file is what `devc init` copies into a project, and an
  // insertion anchor (with the paragraph that has to explain it) would leave every scaffolded
  // repo carrying a marker for an add-on its author may never opt into. The mount is spliced
  // into the cache copy as the `devc:bridge-mount` fence, which needs nothing here — see
  // `injectBridgeMount`. Keep the bundled config silent about the bridge; devc/README.md is
  // where opting in is explained.
  assertEquals(
    text.includes('devc-bridge') || text.includes('bridge-mount'),
    false,
    'the bundled config must not mention devc-bridge at all, comments included',
  );
});

Deno.test('the devc-bridge Feature declares no mounts at all', async () => {
  // The inverse of what this test used to assert, and deliberately so.
  //
  // The Feature used to carry both bridge mounts as *strings*, because a string mount is
  // passed to Docker verbatim so `readonly` survives, while the object form the published
  // Feature schema allows is re-serialized as `type=,src=,dst=` and silently drops it. That
  // worked, but it put a security guarantee on undocumented CLI behavior: a future CLI that
  // normalized string mounts would quietly make them writable.
  //
  // So the Feature stopped needing mounts. The client is downloaded into an image layer at
  // build time (root-owned, and no shared host file for another container to reach), and the
  // token mount belongs to whoever consumes the Feature — in a `devcontainer.json` `mounts`
  // array, where the string form is in the published schema (`anyOf: [Mount, string]`) and is
  // specified to be Docker's own `--mount` syntax, so `readonly` is a promise rather than an
  // accident.
  //
  // Re-adding a `mounts` key here would reintroduce the off-schema dependency AND collide
  // with the consumer's own mount as Docker's `Duplicate mount point`. See
  // .plans/archived/devc-bridge-client-download.md.
  const meta = JSON.parse(
    await Deno.readTextFile(
      new URL(
        '../../features/devc-bridge/devcontainer-feature.json',
        import.meta.url,
      ),
    ),
  );

  assertEquals(
    Object.hasOwn(meta, 'mounts'),
    false,
    'the Feature must declare no mounts — the consumer owns the token mount',
  );
});

Deno.test('materializeDefaultConfig overwrites an existing copy without erroring', async () => {
  await withTempDir(async (cacheDir) => {
    await Deno.mkdir(cacheDir, { recursive: true });
    await Deno.writeTextFile(
      `${cacheDir}/devcontainer.json`,
      '{"marker":"STALE"}',
    );
    const first = await materializeDefaultConfig(cacheDir, NO_TEMPLATES);
    const second = await materializeDefaultConfig(cacheDir, NO_TEMPLATES);
    assertEquals(first, second);
    const contents = await Deno.readTextFile(`${cacheDir}/devcontainer.json`);
    assertEquals(contents.includes('STALE'), false);
  });
});

Deno.test('materializeDefaultConfig writes the embedded tree to real disk (default cache dir)', async () => {
  const path = await materializeDefaultConfig();
  assertEquals(path.endsWith('/devcontainer.json'), true);

  const stat = await Deno.stat(path);
  assertEquals(stat.isFile, true);

  const dir = path.slice(0, -'/devcontainer.json'.length);
  for (
    const sibling of [
      'Dockerfile',
      'initialize-command.sh',
    ]
  ) {
    const siblingStat = await Deno.stat(`${dir}/${sibling}`);
    assertEquals(siblingStat.isFile, true);
  }
});

Deno.test('materializeDefaultConfig rewrites the initializeCommand host path to the cache copy', async () => {
  await withTempDir(async (tmp) => {
    const cacheDir = `${tmp}/cache`;
    const configPath = await materializeDefaultConfig(cacheDir, NO_TEMPLATES);
    const config = JSON.parse(
      stripLineComments(await Deno.readTextFile(configPath)),
    );
    // initializeCommand runs on the host before create; in zero-config the workspace is the
    // user's project (no `.devcontainer/`), so the `${localWorkspaceFolder}` reference is
    // resolved to this cache dir where initialize-command.sh actually lives.
    assertEquals(
      config.initializeCommand,
      `bash "${cacheDir}/initialize-command.sh"`,
    );
    assertEquals(
      (await Deno.stat(`${cacheDir}/initialize-command.sh`)).isFile,
      true,
    );
  });
});

// ── user template layer ─────────────────────────────────────────────────────────────────────

/** Sorted relative paths of every file under `dir`. */
async function fileTree(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory) {
      out.push(...await fileTree(`${dir}/${entry.name}`, `${rel}/`));
    } else out.push(rel);
  }
  return out.sort();
}

/** The embedded `default/` tree as a real path, for byte-comparison against a cache dir. */
const BUNDLED_DIR = fromFileUrl(new URL('../default', import.meta.url));

/** The path rewrite `materializeDefaultConfig` applies, for a given cache dir. */
function withRewrites(configText: string, cacheDir: string): string {
  return configText.replaceAll(
    '${localWorkspaceFolder}/.devcontainer/initialize-command.sh',
    `${cacheDir}/initialize-command.sh`,
  );
}

/**
 * Assert `cacheDir` is the bundled tree with the two rewrites applied, except for the relative
 * paths in `overridden`, whose expected contents are given explicitly.
 */
async function assertBundledExcept(
  cacheDir: string,
  overridden: Record<string, string> = {},
): Promise<void> {
  assertEquals(await fileTree(cacheDir), await fileTree(BUNDLED_DIR));
  for (const rel of await fileTree(BUNDLED_DIR)) {
    const actual = await Deno.readTextFile(`${cacheDir}/${rel}`);
    if (rel in overridden) {
      assertEquals(actual, overridden[rel], rel);
      continue;
    }
    const bundled = await Deno.readTextFile(`${BUNDLED_DIR}/${rel}`);
    assertEquals(
      actual,
      rel === 'devcontainer.json' ? withRewrites(bundled, cacheDir) : bundled,
      rel,
    );
  }
}

Deno.test('materializeDefaultConfig with no templates dir yields the bundled tree plus the two rewrites', async () => {
  await withTempDir(async (tmp) => {
    // An absent templates dir is a silent no-op, not an error — whether its parent exists or not.
    await materializeDefaultConfig(`${tmp}/a`, NO_TEMPLATES);
    await assertBundledExcept(`${tmp}/a`);
    await materializeDefaultConfig(`${tmp}/b`, `${tmp}/never-created`);
    await assertBundledExcept(`${tmp}/b`);
  });
});

Deno.test('a templates dir holding only a Dockerfile overrides that file and nothing else', async () => {
  await withTempDir(async (tmp) => {
    const templates = `${tmp}/templates`;
    await mkdir(templates);
    await Deno.writeTextFile(`${templates}/Dockerfile`, 'FROM scratch\n');

    const cacheDir = `${tmp}/cache`;
    await materializeDefaultConfig(cacheDir, templates);

    // Sparse overlay: the file list is identical, only the one file's contents changed.
    await assertBundledExcept(cacheDir, { Dockerfile: 'FROM scratch\n' });
  });
});

// `default/` has no `scripts/` subdirectory of its own any more (agents-setup.sh, git-setup.sh
// and bashrc-additions.sh all retired onto Features), so a templates subdirectory the bundle has
// no counterpart for is the case left to cover — the overlay still has to copy it through rather
// than skip it for lack of a bundled sibling. Can't use assertBundledExcept here: that helper
// asserts tree *equality* against the bundle, and this deliberately produces an extra file the
// bundle does not have.
Deno.test('a templates subdirectory file the bundle has no counterpart for is still copied through', async () => {
  await withTempDir(async (tmp) => {
    const templates = `${tmp}/templates`;
    await mkdir(`${templates}/scripts`);
    await Deno.writeTextFile(`${templates}/scripts/node-setup.sh`, '# mine\n');

    const cacheDir = `${tmp}/cache`;
    await materializeDefaultConfig(cacheDir, templates);

    assertEquals(
      await Deno.readTextFile(`${cacheDir}/scripts/node-setup.sh`),
      '# mine\n',
    );
    // The bundled top-level files are untouched by the unrelated overlay addition.
    const bundledDockerfile = await Deno.readTextFile(
      new URL('../default/Dockerfile', import.meta.url),
    );
    assertEquals(
      await Deno.readTextFile(`${cacheDir}/Dockerfile`),
      bundledDockerfile,
    );
  });
});

// The rewrite has to run *after* the overlay, or a user template that keeps the standard
// in-project reference would resolve to a `.devcontainer/` that does not exist in the
// zero-config path.
Deno.test('a templates devcontainer.json still receives the initializeCommand rewrite', async () => {
  await withTempDir(async (tmp) => {
    const templates = `${tmp}/templates`;
    await mkdir(templates);
    await Deno.writeTextFile(
      `${templates}/devcontainer.json`,
      JSON.stringify({
        name: 'mine',
        initializeCommand:
          'bash "${localWorkspaceFolder}/.devcontainer/initialize-command.sh"',
      }),
    );

    const cacheDir = `${tmp}/cache`;
    const configPath = await materializeDefaultConfig(cacheDir, templates);
    const config = JSON.parse(await Deno.readTextFile(configPath));

    assertEquals(config.name, 'mine');
    assertEquals(
      config.initializeCommand,
      `bash "${cacheDir}/initialize-command.sh"`,
    );
  });
});

Deno.test('removing a file from the templates dir restores the bundled version', async () => {
  await withTempDir(async (tmp) => {
    const bundledDockerfile = await Deno.readTextFile(
      new URL('../default/Dockerfile', import.meta.url),
    );
    const templates = `${tmp}/templates`;
    await mkdir(templates);
    await Deno.writeTextFile(`${templates}/Dockerfile`, 'FROM scratch\n');

    const cacheDir = `${tmp}/cache`;
    await materializeDefaultConfig(cacheDir, templates);
    assertEquals(
      await Deno.readTextFile(`${cacheDir}/Dockerfile`),
      'FROM scratch\n',
    );

    // The overlay is re-applied every run, so a deletion takes effect on the next call.
    await Deno.remove(`${templates}/Dockerfile`);
    await materializeDefaultConfig(cacheDir, templates);
    assertEquals(
      await Deno.readTextFile(`${cacheDir}/Dockerfile`),
      bundledDockerfile,
    );
  });
});

Deno.test('a file in a previous cache but in neither bundled nor templates is pruned', async () => {
  await withTempDir(async (tmp) => {
    const cacheDir = `${tmp}/cache`;
    await materializeDefaultConfig(cacheDir, NO_TEMPLATES);
    await Deno.writeTextFile(
      `${cacheDir}/leftover.sh`,
      '# from an older devc\n',
    );
    await mkdir(`${cacheDir}/stale`);
    await Deno.writeTextFile(`${cacheDir}/stale/x.sh`, '# also stale\n');

    await materializeDefaultConfig(cacheDir, NO_TEMPLATES);

    const tree = await fileTree(cacheDir);
    assertEquals(tree.includes('leftover.sh'), false);
    assertEquals(tree.includes('stale/x.sh'), false);
    assertEquals(tree.includes('devcontainer.json'), true);
  });
});

// `devcontainer.json` rides the same per-file overlay as everything else, and is reported first
// in the written list. No special case: the exception that used to exist here was for the
// wizard's mount fences, which now live in the `devc.json` overlay instead.
Deno.test('installBundledAssets overlays templates, devcontainer.json included', async () => {
  await withTempDir(async (tmp) => {
    const templates = `${tmp}/templates`;
    await mkdir(templates);
    await Deno.writeTextFile(`${templates}/Dockerfile`, 'FROM scratch\n');
    await Deno.writeTextFile(
      `${templates}/devcontainer.json`,
      '{"name":"mine"}',
    );
    await Deno.writeTextFile(`${templates}/extra.txt`, 'brought along\n');

    const dest = `${tmp}/.devcontainer`;
    const written = await installBundledAssets(dest, templates);

    assertEquals(written[0], `${dest}/devcontainer.json`);
    assertEquals(
      await Deno.readTextFile(`${dest}/Dockerfile`),
      'FROM scratch\n',
    );
    assertEquals(
      await Deno.readTextFile(`${dest}/extra.txt`),
      'brought along\n',
    );
    assertEquals(
      await Deno.readTextFile(`${dest}/devcontainer.json`),
      '{"name":"mine"}',
    );
    // The one lifecycle entry script left still gets the exec bit.
    assertEquals(
      (await Deno.stat(`${dest}/initialize-command.sh`)).mode! & 0o111,
      0o111,
    );
  });
});

Deno.test('installBundledAssets writes the bundled devcontainer.json when no template overrides it', async () => {
  await withTempDir(async (tmp) => {
    const dest = `${tmp}/.devcontainer`;
    await installBundledAssets(dest, NO_TEMPLATES);
    assertEquals(
      await Deno.readTextFile(`${dest}/devcontainer.json`),
      await Deno.readTextFile(
        new URL('../default/devcontainer.json', import.meta.url),
      ),
    );
  });
});

// The guard for the adjacent-paths mistake: `templates/devc.json` would otherwise be copied to
// `<project>/.devcontainer/devc.json` and read back as that project's own overlay — the
// highest-precedence slot — putting one machine's mounts into every scaffolded repo. It is
// skipped, loudly (the warning is what keeps this from reproducing "my overlay does nothing").
Deno.test('installBundledAssets never copies a devc.json overlay out of templates', async () => {
  await withTempDir(async (tmp) => {
    const templates = `${tmp}/templates`;
    await mkdir(templates);
    for (const name of ['devc.json', 'devc.jsonc']) {
      await Deno.writeTextFile(`${templates}/${name}`, '{"mounts":[]}');
    }

    const dest = `${tmp}/.devcontainer`;
    const warnings: string[] = [];
    const realError = console.error;
    console.error = (...args) => void warnings.push(args.join(' '));
    try {
      await installBundledAssets(dest, templates);
    } finally {
      console.error = realError;
    }

    for (const name of ['devc.json', 'devc.jsonc']) {
      assertEquals(
        await Deno.stat(`${dest}/${name}`).then(() => true).catch(() => false),
        false,
        `expected ${name} not to be copied`,
      );
      // Skipping silently would leave exactly the "my overlay does nothing" this guards against,
      // so the warning has to name the offending file and where the overlay really goes.
      const warning = warnings.find((w) => w.includes(`${templates}/${name}`));
      assertEquals(
        typeof warning,
        'string',
        `expected a warning naming ${name}`,
      );
      assertEquals(warning!.includes('devc.jsonc'), true);
    }
  });
});

// Top-level only: nested files by that name are ordinary data with no overlay meaning.
Deno.test('the templates overlay still copies a nested devc.json', async () => {
  await withTempDir(async (tmp) => {
    const templates = `${tmp}/templates`;
    await mkdir(`${templates}/scripts`);
    await Deno.writeTextFile(`${templates}/scripts/devc.json`, '{"a":1}');

    const dest = `${tmp}/.devcontainer`;
    await installBundledAssets(dest, templates);

    assertEquals(
      await Deno.readTextFile(`${dest}/scripts/devc.json`),
      '{"a":1}',
    );
  });
});

Deno.test('materializeDefaultConfig also refuses a templates devc.json', async () => {
  await withTempDir(async (tmp) => {
    const templates = `${tmp}/templates`;
    await mkdir(templates);
    await Deno.writeTextFile(`${templates}/devc.json`, '{"mounts":[]}');

    const cacheDir = `${tmp}/cache`;
    await materializeDefaultConfig(cacheDir, templates);

    assertEquals(
      await Deno.stat(`${cacheDir}/devc.json`).then(() => true).catch(() =>
        false
      ),
      false,
    );
  });
});

Deno.test('ensureClaudeSeedDir creates the directory and reports it', async () => {
  await withTempDir(async (tmp) => {
    const seed = `${tmp}/seed`;
    const result = await ensureClaudeSeedDir(seed);
    assertEquals(result.created, true);
    assertEquals((await Deno.stat(seed)).isDirectory, true);
  });
});

Deno.test('ensureClaudeSeedDir is idempotent on an existing directory', async () => {
  await withTempDir(async (tmp) => {
    const seed = `${tmp}/seed`;
    await ensureClaudeSeedDir(seed);
    assertEquals((await ensureClaudeSeedDir(seed)).created, false);
  });
});

// Pinned deliberately, and the inverse of what an earlier `devc` did: the seed directory is
// created *empty* and nothing is ever copied out of the host's real `~/.claude`. Publishing a
// machine's personal CLAUDE.md/settings into every container is the user's decision to make by
// putting the file here, so a regression that "helpfully" seeds it must fail.
Deno.test('ensureClaudeSeedDir creates an empty directory, copying nothing from ~/.claude', async () => {
  await withTempDir(async (tmp) => {
    const home = `${tmp}/home/.claude`;
    await mkdir(home);
    for (
      const name of [
        'CLAUDE.md',
        'settings.json',
        'settings.devc.json',
        'statusline.sh',
      ]
    ) {
      await Deno.writeTextFile(`${home}/${name}`, 'personal\n');
    }

    const seed = `${tmp}/seed`;
    assertEquals((await ensureClaudeSeedDir(seed)).created, true);
    assertEquals([...Deno.readDirSync(seed)], []);
  });
});

Deno.test('ensureClaudeSeedDir rejects a seed path that is not a directory', async () => {
  await withTempDir(async (tmp) => {
    const seed = `${tmp}/seed`;
    await Deno.writeTextFile(seed, 'oops\n');
    await assertRejects(
      () => ensureClaudeSeedDir(seed),
      Error,
      'is not a directory',
    );
  });
});

Deno.test('ensureClaudeSeedDir rejects a dangling symlink at the seed path', async () => {
  await withTempDir(async (tmp) => {
    const seed = `${tmp}/seed`;
    // Recursive mkdir reports AlreadyExists here rather than following through, so the
    // not-a-directory guard is what turns this into a readable error.
    await Deno.symlink(`${tmp}/nonexistent`, seed);
    await assertRejects(
      () => ensureClaudeSeedDir(seed),
      Error,
      'is not a directory',
    );
  });
});

// --- the devc-bridge token mount ---------------------------------------------------------
//
// devc injects it into the config it *materializes*, and only when a devc.json opts into the
// Feature. Everything below defends one boundary or the other: the baseline must stay
// bridge-free (a devc container has to come up on a host that never installed the bridge —
// `0d46b51` removed the mkdir that used to paper over a missing mount source), and the mount
// must stay a *string* carrying `readonly`, which is the only reason it lives in a
// devcontainer.json at all rather than in the devc.json overlay.

Deno.test('declaresBridgeFeature matches the Feature by id, whatever the tag', async (t) => {
  const yes = [
    'ghcr.io/devc-tools/devc-bridge',
    'ghcr.io/devc-tools/devc-bridge:0',
    'ghcr.io/devc-tools/devc-bridge:1',
    'ghcr.io/devc-tools/devc-bridge:0.1.0',
    // A local path reference — how this repo consumes its own Feature in development.
    './features/devc-bridge',
    '../devc-tools/features/devc-bridge',
  ];
  const no = [
    'ghcr.io/devcontainers/features/node:1',
    'ghcr.io/devc-tools/devc-bridge-client:0', // near-miss, different Feature
    './features/devc',
    '',
  ];

  for (const id of yes) {
    await t.step(`opts in: ${id || '(empty)'}`, () => {
      assertEquals(declaresBridgeFeature({ [id]: {} }), true);
    });
  }
  for (const id of no) {
    await t.step(`does not: ${id || '(empty)'}`, () => {
      assertEquals(declaresBridgeFeature({ [id]: {} }), false);
    });
  }

  assertEquals(declaresBridgeFeature({}), false);
  // Found among others, not only when it is the sole entry.
  assertEquals(
    declaresBridgeFeature({
      'ghcr.io/devcontainers/features/go:1': {},
      'ghcr.io/devc-tools/devc-bridge:0': {},
    }),
    true,
  );
});

// declaresBridgeFeature is now a one-line wrapper over the general form; this asserts that
// wrapping held, not the matching logic itself (already covered above).
Deno.test('declaresBridgeFeature: an alias for declaresFeatureNamed(_, "devc-bridge")', () => {
  const features = { 'ghcr.io/devc-tools/devc-bridge:0': {} };
  assertEquals(
    declaresBridgeFeature(features),
    declaresFeatureNamed(features, 'devc-bridge'),
  );
});

Deno.test('declaresFeatureNamed matches by name, whatever the tag or registry', async (t) => {
  const yes = [
    'ghcr.io/devc-tools/devc-config',
    'ghcr.io/devc-tools/devc-config:0',
    'ghcr.io/devc-tools/devc-config:0.1.0',
    'ghcr.io/someone-else/devc-config:1',
    './features/devc-config',
  ];
  const no = [
    'ghcr.io/devcontainers/features/node:1',
    'ghcr.io/devc-tools/devc-config-extra:0', // near-miss, different Feature
    './features/devc',
    '',
  ];

  for (const id of yes) {
    await t.step(`matches: ${id}`, () => {
      assertEquals(declaresFeatureNamed({ [id]: {} }, 'devc-config'), true);
    });
  }
  for (const id of no) {
    await t.step(`does not match: ${id || '(empty)'}`, () => {
      assertEquals(declaresFeatureNamed({ [id]: {} }, 'devc-config'), false);
    });
  }

  assertEquals(declaresFeatureNamed({}, 'devc-config'), false);
});

// --- loadDeclaredFeatureIds ------------------------------------------------------------------
//
// The baseline-injection half of the contract: withBaselineFeatures needs the raw ids the
// in-play config already declares, so it can skip injecting a Feature the config names itself.
