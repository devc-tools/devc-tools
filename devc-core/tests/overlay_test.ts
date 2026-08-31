import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from 'jsr:@std/assert@^1';
import {
  BRIDGE_MOUNT,
  DEVC_CONFIG_FEATURE,
  devcContributions,
  emptyOverlay,
  findProjectOverlayPath,
  findUserOverlayPath,
  loadOverlayFile,
  loadOverlays,
  resolveProjectOverlayTarget,
} from '../overlay.ts';
import { mergeConfigs } from '../merge.ts';
import { fixture, withTemp } from './helpers.ts';

/** Write `text` to `path`, creating parent directories. */
async function write(path: string, text: string): Promise<void> {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(path, text);
}

/** Run `fn` with `console.error` captured, returning the lines it emitted. */
async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

/** The `remoteEnv` the overlay layers merge to — the shorthand the precedence tests want. */
function mergedRemoteEnv(overlays: { layers: Record<string, unknown>[] }) {
  return mergeConfigs(overlays.layers).remoteEnv;
}

// ── discovery ───────────────────────────────────────────────────────────────────────────────

Deno.test('findProjectOverlayPath is null when the project has no overlay', async () => {
  await withTemp(async (dir) => {
    assertEquals(await findProjectOverlayPath(dir), null);
  });
});

// All four locations are first-class; only the first hit is read, and the losers are never
// merged — so a key unique to a losing file must not show up in the result.
Deno.test('project overlay precedence: .devc/devc.jsonc wins over the other three', async () => {
  await withTemp(async (dir) => {
    await write(`${dir}/.devc/devc.jsonc`, '{"remoteEnv":{"WINNER":"a"}}');
    await write(`${dir}/.devc/devc.json`, '{"remoteEnv":{"ONLY_B":"b"}}');
    await write(
      `${dir}/.devcontainer/devc.jsonc`,
      '{"remoteEnv":{"ONLY_C":"c"}}',
    );
    await write(
      `${dir}/.devcontainer/devc.json`,
      '{"remoteEnv":{"ONLY_D":"d"}}',
    );
    assertEquals(await findProjectOverlayPath(dir), `${dir}/.devc/devc.jsonc`);
    assertEquals(mergedRemoteEnv(await loadOverlays(dir, `${dir}/nouser`)), {
      WINNER: 'a',
    });
  });
});

Deno.test('project overlay precedence: .devc/devc.json wins over both .devcontainer/ forms', async () => {
  await withTemp(async (dir) => {
    await write(`${dir}/.devc/devc.json`, '{"remoteEnv":{"WINNER":"b"}}');
    await write(
      `${dir}/.devcontainer/devc.jsonc`,
      '{"remoteEnv":{"ONLY_C":"c"}}',
    );
    await write(
      `${dir}/.devcontainer/devc.json`,
      '{"remoteEnv":{"ONLY_D":"d"}}',
    );
    assertEquals(await findProjectOverlayPath(dir), `${dir}/.devc/devc.json`);
    assertEquals(mergedRemoteEnv(await loadOverlays(dir, `${dir}/nouser`)), {
      WINNER: 'b',
    });
  });
});

Deno.test('project overlay precedence: .devcontainer/devc.jsonc wins over .devcontainer/devc.json', async () => {
  await withTemp(async (dir) => {
    await write(
      `${dir}/.devcontainer/devc.jsonc`,
      '{"remoteEnv":{"WINNER":"c"}}',
    );
    await write(
      `${dir}/.devcontainer/devc.json`,
      '{"remoteEnv":{"ONLY_D":"d"}}',
    );
    assertEquals(
      await findProjectOverlayPath(dir),
      `${dir}/.devcontainer/devc.jsonc`,
    );
    assertEquals(mergedRemoteEnv(await loadOverlays(dir, `${dir}/nouser`)), {
      WINNER: 'c',
    });
  });
});

Deno.test('user overlay precedence: devc.jsonc wins over devc.json', async () => {
  await withTemp(async (dir) => {
    await write(`${dir}/config/devc.jsonc`, '{"remoteEnv":{"WINNER":"jsonc"}}');
    await write(
      `${dir}/config/devc.json`,
      '{"remoteEnv":{"ONLY_JSON":"json"}}',
    );
    assertEquals(
      await findUserOverlayPath(`${dir}/config`),
      `${dir}/config/devc.jsonc`,
    );
    assertEquals(
      mergedRemoteEnv(await loadOverlays(`${dir}/project`, `${dir}/config`)),
      { WINNER: 'jsonc' },
    );
  });
});

Deno.test('findUserOverlayPath is null when the config dir has neither file', async () => {
  await withTemp(async (dir) => {
    assertEquals(await findUserOverlayPath(dir), null);
  });
});

// The bug this feature exists to fix: the reference only consulted `devc.json` when the project
// had *no* `devcontainer.json`, so a project with its own config silently ignored it.
Deno.test('the overlay is read even when the project has its own devcontainer.json', async () => {
  await withTemp(async (dir) => {
    await write(`${dir}/.devcontainer/devcontainer.json`, '{"image":"x"}');
    await write(
      `${dir}/.devc/devc.json`,
      '{"mounts":["type=bind,source=/a,target=/b"]}',
    );
    const { layers } = await loadOverlays(dir, `${dir}/nouser`);
    assertEquals(layers, [{}, {
      mounts: ['type=bind,source=/a,target=/b'],
    }]);
  });
});

// ── parsing ─────────────────────────────────────────────────────────────────────────────────

Deno.test('loadOverlays returns empty layers when nothing exists anywhere', async () => {
  await withTemp(async (dir) => {
    const overlays = await loadOverlays(`${dir}/project`, `${dir}/config`);
    assertEquals(overlays, { layers: [{}, {}], baselineFeatures: true });
    assertEquals(mergeConfigs(overlays.layers), {});
  });
});

Deno.test('loadOverlayFile parses real JSONC, keeping every key as written', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/devc.jsonc`;
    await write(path, await fixture('devc_overlay.jsonc'));
    const overlay = await loadOverlayFile(path);

    // Nothing is substituted at load: the tokens reach the merged config verbatim and the
    // devcontainer CLI resolves them.
    assertEquals(overlay.config, {
      mounts: [
        'type=bind,source=${localEnv:HOME}/notes,target=${containerWorkspaceFolder}/../notes',
        'type=bind,source=${localWorkspaceFolder}/.cache,target=/cache/${localWorkspaceFolderBasename}',
        'type=bind,source=${localEnv:HOME}/reference,target=/reference,readonly',
      ],
      features: {
        'ghcr.io/devcontainers/features/rust:1': { version: 'latest' },
      },
      remoteEnv: { NOTES_DIR: '${containerWorkspaceFolder}/../notes' },
    });
    assertEquals(overlay.baselineFeatures, true);
  });
});

// The headline capability of the merge: a `readonly` mount, which the flag-era overlay rejected
// at load because `devcontainer up --mount` has no such field.
Deno.test('a readonly mount loads and survives the merge verbatim', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/devc.json`;
    await write(
      path,
      '{"mounts":["type=bind,source=/host/ref,target=/reference,readonly"]}',
    );
    const overlay = await loadOverlayFile(path);
    assertEquals(mergeConfigs([{}, overlay.config]).mounts, [
      'type=bind,source=/host/ref,target=/reference,readonly',
    ]);
  });
});

// Any devcontainer.json key is legal now, not just the old four.
Deno.test('keys the flag-era overlay had no arg for load like any other', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/devc.json`;
    await write(
      path,
      JSON.stringify({
        runArgs: ['--cap-add', 'SYS_PTRACE'],
        containerEnv: { TZ: 'UTC' },
        forwardPorts: [3000],
        remoteUser: 'root',
        postCreateCommand: 'echo hi',
        customizations: { vscode: { extensions: ['ms-python.python'] } },
      }),
    );
    const overlay = await loadOverlayFile(path);
    assertEquals(overlay.config.runArgs, ['--cap-add', 'SYS_PTRACE']);
    assertEquals(overlay.config.remoteUser, 'root');
    assertEquals(overlay.config.forwardPorts, [3000]);
  });
});

Deno.test('loadOverlayFile throws naming the file path when it cannot be parsed', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/devc.json`;
    await write(path, '{ this is not json');
    const err = await assertRejects(() => loadOverlayFile(path), Error);
    assertStringIncludes(err.message, path);
  });
});

Deno.test('loadOverlays propagates the parse failure with the path', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/.devc/devc.json`;
    await write(path, '{ nope');
    const err = await assertRejects(
      () => loadOverlays(dir, `${dir}/nouser`),
      Error,
    );
    assertStringIncludes(err.message, path);
  });
});

Deno.test('an empty overlay file is no overlay, not an error', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/devc.json`;
    await write(path, '   \n');
    assertEquals(await loadOverlayFile(path), emptyOverlay());
  });
});

Deno.test('a comment-only overlay file is no overlay, not an error', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/devc.jsonc`;
    await write(path, '// nothing yet\n/* still nothing */\n');
    assertEquals(await loadOverlayFile(path), emptyOverlay());
  });
});

// The typo guard the four-key schema used to give for free. `mount` is not a devcontainer.json
// key, so it would silently do nothing.
Deno.test('a key that is not a devcontainer.json key warns, naming it', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/devc.json`;
    await write(path, '{"mount":["type=bind,source=/a,target=/b"]}');
    let overlay = emptyOverlay();
    const warnings = await captureStderr(async () => {
      overlay = await loadOverlayFile(path);
    });
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], '"mount"');
    assertStringIncludes(warnings[0], path);
    // Warned about, not dropped: the CLI ignores what it does not know.
    assertEquals(overlay.config.mount, ['type=bind,source=/a,target=/b']);
  });
});

// `additionalFeatures` was the flag-era name for `features`. It is not aliased — the key is
// `features` now — so it lands in the same warning as any other unknown key, which names it.
Deno.test('the retired additionalFeatures key warns like any other unknown key', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/devc.json`;
    await write(path, '{"additionalFeatures":{"ghcr.io/x/rust:1":{}}}');
    const warnings = await captureStderr(async () => {
      await loadOverlayFile(path);
    });
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], '"additionalFeatures"');
  });
});

Deno.test('every known devcontainer.json key loads without a warning', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/devc.json`;
    await write(
      path,
      JSON.stringify({
        name: 'x',
        image: 'y',
        mounts: ['type=bind,source=/a,target=/b'],
        features: {},
        remoteEnv: {},
        containerEnv: {},
        runArgs: [],
        capAdd: [],
        securityOpt: [],
        forwardPorts: [],
        initializeCommand: 'true',
        postCreateCommand: 'true',
        customizations: {},
        hostRequirements: {},
        workspaceMount: 'x',
        workspaceFolder: '/w',
        remoteUser: 'me',
        updateRemoteUserUID: true,
        waitFor: 'postCreateCommand',
        baselineFeatures: true,
        $replace: ['mounts'],
      }),
    );
    assertEquals(
      await captureStderr(async () => {
        await loadOverlayFile(path);
      }),
      [],
    );
  });
});

// ── mount shape checking ────────────────────────────────────────────────────────────────────

// All that is left of the old `MOUNT_SPEC_RE` validation: enough of a check to give a better
// error than Docker's, and nothing that constrains the vocabulary.
Deno.test('a mounts entry with no target fails, naming the file and the index', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/devc.json`;
    await write(path, '{"mounts":["type=bind,source=/a"]}');
    const err = await assertRejects(() => loadOverlayFile(path), Error);
    assertStringIncludes(err.message, path);
    assertStringIncludes(err.message, '"mounts"[0]');
    assertStringIncludes(err.message, 'no mount target');
  });
});

Deno.test('a non-array mounts fails, naming the file', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/devc.json`;
    await write(path, '{"mounts":"type=bind,source=/a,target=/b"}');
    const err = await assertRejects(() => loadOverlayFile(path), Error);
    assertStringIncludes(err.message, path);
    assertStringIncludes(err.message, '"mounts"');
  });
});

Deno.test('object-form mounts are accepted, string and object alike', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/devc.json`;
    await write(
      path,
      JSON.stringify({
        mounts: [
          { type: 'bind', source: '/a', target: '/b' },
          'type=volume,source=v,target=/v',
        ],
      }),
    );
    const overlay = await loadOverlayFile(path);
    assertEquals((overlay.config.mounts as unknown[]).length, 2);
  });
});

// Fields the flag grammar rejected outright are ordinary now — this is the regression guard for
// the retired `RETIRED_MOUNT_FIELDS` complaint.
Deno.test('consistency and any field order load without complaint', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/devc.json`;
    await write(
      path,
      JSON.stringify({
        mounts: [
          'target=/b,source=/a,type=bind',
          'type=bind,source=/c,target=/d,consistency=cached',
        ],
      }),
    );
    assertEquals(
      await captureStderr(async () => {
        await loadOverlayFile(path);
      }),
      [],
    );
  });
});

// ── baselineFeatures ────────────────────────────────────────────────────────────────────────

Deno.test('baselineFeatures defaults true when the key is omitted', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/devc.json`;
    await write(path, '{"mounts":[]}');
    assertEquals((await loadOverlayFile(path)).baselineFeatures, true);
  });
});

Deno.test('baselineFeatures: false is read back as false, and never reaches the config', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/devc.json`;
    await write(path, '{"baselineFeatures":false}');
    const overlay = await loadOverlayFile(path);
    assertEquals(overlay.baselineFeatures, false);
    assertEquals(overlay.config, {});
  });
});

Deno.test('a non-boolean baselineFeatures warns and defaults to true, without failing the load', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/devc.json`;
    await write(path, '{"baselineFeatures":"yes"}');
    let overlay = emptyOverlay();
    const warnings = await captureStderr(async () => {
      overlay = await loadOverlayFile(path);
    });
    assertEquals(overlay.baselineFeatures, true);
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], 'baselineFeatures');
  });
});

// The one key where the project does not win: a machine owner's `false` cannot be talked back
// on by a repo's devc.json.
Deno.test('baselineFeatures is a user-side veto, not project-wins', async () => {
  await withTemp(async (dir) => {
    await write(`${dir}/config/devc.json`, '{"baselineFeatures":false}');
    await write(`${dir}/p/.devc/devc.json`, '{"baselineFeatures":true}');
    const overlays = await loadOverlays(`${dir}/p`, `${dir}/config`);
    assertEquals(overlays.baselineFeatures, false);
  });
});

Deno.test('a project can still turn baselineFeatures off on its own', async () => {
  await withTemp(async (dir) => {
    await write(`${dir}/p/.devc/devc.json`, '{"baselineFeatures":false}');
    const overlays = await loadOverlays(`${dir}/p`, `${dir}/nouser`);
    assertEquals(overlays.baselineFeatures, false);
  });
});

// ── devc's own layer ────────────────────────────────────────────────────────────────────────

Deno.test('devcContributions adds the baseline Feature when nothing else declares it', () => {
  assertEquals(devcContributions({}, true), {
    features: { [DEVC_CONFIG_FEATURE]: {} },
  });
});

Deno.test('devcContributions: baselineFeatures false contributes no Feature', () => {
  assertEquals(devcContributions({}, false), {});
});

// By *name*, not by id: two ids for one Feature are two Features to the CLI, so the hook would
// run twice.
Deno.test('a devc-config Feature at any tag or registry suppresses the injected one', () => {
  for (
    const id of [
      'ghcr.io/devc-tools/devc-config',
      'ghcr.io/devc-tools/devc-config:0',
      'ghcr.io/devc-tools/devc-config:0.1.0',
      './features/devc-config',
      'ghcr.io/someone-else/devc-config:2',
    ]
  ) {
    assertEquals(
      devcContributions({ features: { [id]: {} } }, true),
      {},
      `not suppressed by ${id}`,
    );
  }
});

Deno.test('an unrelated declared Feature does not suppress the baseline', () => {
  assertEquals(
    devcContributions({ features: { 'ghcr.io/x/rust:1': {} } }, true),
    { features: { [DEVC_CONFIG_FEATURE]: {} } },
  );
});

// The bridge token mount used to be spliced into the materialized cache config, which meant it
// reached zero-config containers only. As a merge layer it reaches project mode too, and devc
// still writes nothing into the project.
Deno.test('opting into devc-bridge contributes the read-only token mount', () => {
  const layer = devcContributions({
    features: { 'ghcr.io/devc-tools/devc-bridge:0': {} },
  }, true);
  assertEquals(layer.mounts, [BRIDGE_MOUNT]);

  // A *string*, and read-only. Both halves matter: an object mount cannot express `readonly`,
  // and without it a container can pin the host's token for the next restart.
  assertEquals(BRIDGE_MOUNT.split(',').includes('readonly'), true);
  assertEquals(BRIDGE_MOUNT.startsWith('type=bind,'), true);
  assertEquals(
    BRIDGE_MOUNT.includes('source=${localEnv:HOME}/.config/devc-bridge/run'),
    true,
  );
});

Deno.test('no bridge opt-in, no token mount', () => {
  assertEquals(devcContributions({ features: {} }, true).mounts, undefined);
});

// devc's layer is merged *under* everything else, so a mount someone wrote themselves on the
// same target replaces it through the merge's own target dedupe — no special case needed.
Deno.test("a hand-written /run/devc-bridge mount wins over devc's", () => {
  const own = 'type=bind,source=/custom/run,target=/run/devc-bridge';
  const provisional = {
    features: { 'ghcr.io/devc-tools/devc-bridge:0': {} },
    mounts: [own],
  };
  const merged = mergeConfigs([
    devcContributions(provisional, true),
    provisional,
  ]);
  assertEquals(merged.mounts, [own]);
});

Deno.test('devcContributions never mutates the config it inspects', () => {
  const config = { features: { 'ghcr.io/x/rust:1': {} } };
  const snapshot = JSON.stringify(config);
  devcContributions(config, true);
  assertEquals(JSON.stringify(config), snapshot);
});

// ── where `devc config` writes ──────────────────────────────────────────────────────────────

Deno.test('resolveProjectOverlayTarget: an existing overlay always wins', async () => {
  for (
    const rel of [
      '.devc/devc.jsonc',
      '.devc/devc.json',
      '.devcontainer/devc.jsonc',
      '.devcontainer/devc.json',
    ]
  ) {
    await withTemp(async (dir) => {
      // A `.devcontainer/` exists in every case, so the fallback would pick a *different*
      // file — proving the existing overlay is what's being honored.
      await Deno.mkdir(`${dir}/.devcontainer`, { recursive: true });
      await write(`${dir}/${rel}`, '{}\n');
      assertEquals(await resolveProjectOverlayTarget(dir), {
        path: `${dir}/${rel}`,
        creating: false,
      });
    });
  }
});

Deno.test('resolveProjectOverlayTarget: first hit wins when several overlays exist', async () => {
  await withTemp(async (dir) => {
    await write(`${dir}/.devcontainer/devc.json`, '{}\n');
    await write(`${dir}/.devc/devc.jsonc`, '{}\n');
    const target = await resolveProjectOverlayTarget(dir);
    assertEquals(target.path, `${dir}/.devc/devc.jsonc`);
    // …and it agrees with what the loader will actually read.
    assertEquals(await findProjectOverlayPath(dir), target.path);
  });
});

Deno.test('resolveProjectOverlayTarget: creates beside the config, else in .devc/', async () => {
  await withTemp(async (dir) => {
    await Deno.mkdir(`${dir}/.devcontainer`, { recursive: true });
    assertEquals(await resolveProjectOverlayTarget(dir), {
      path: `${dir}/.devcontainer/devc.jsonc`,
      creating: true,
    });
  });
  await withTemp(async (dir) => {
    assertEquals(await resolveProjectOverlayTarget(dir), {
      path: `${dir}/.devc/devc.jsonc`,
      creating: true,
    });
  });
});

// A file named `.devcontainer` (not a directory) must not be mistaken for one.
Deno.test('resolveProjectOverlayTarget: a .devcontainer *file* falls back to .devc/', async () => {
  await withTemp(async (dir) => {
    await Deno.writeTextFile(`${dir}/.devcontainer`, 'not a dir');
    assertEquals(await resolveProjectOverlayTarget(dir), {
      path: `${dir}/.devc/devc.jsonc`,
      creating: true,
    });
  });
});

// ── the standalone invariant ────────────────────────────────────────────────────────────────

// Whatever lands in `.devcontainer/` must run without devc installed at all, which is only
// structurally true if no code path in this feature writes to the project's config. The overlay
// reads it; it never writes it.
Deno.test('the overlay read path leaves the project devcontainer.json byte-identical', async () => {
  await withTemp(async (dir) => {
    const configPath = `${dir}/.devcontainer/devcontainer.json`;
    const original = '{\n  // hand-written\n  "image": "x",\n}\n';
    await write(configPath, original);
    await write(
      `${dir}/.devcontainer/devc.json`,
      JSON.stringify({
        mounts: ['type=bind,source=${localEnv:HOME}/notes,target=/notes'],
        features: { 'ghcr.io/x/rust:1': {} },
        remoteEnv: { A: '${containerWorkspaceFolder}' },
      }),
    );
    const before = await Deno.stat(configPath);

    const overlays = await loadOverlays(dir, `${dir}/nouser`);
    mergeConfigs(overlays.layers);

    assertEquals(await Deno.readTextFile(configPath), original);
    // Not even the mtime moved — the file was never opened for writing.
    assertEquals((await Deno.stat(configPath)).mtime, before.mtime);
  });
});
