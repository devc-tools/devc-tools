import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1';
import {
  applyFences,
  applySelection,
  type WizardSelection,
} from '../wizard_apply.ts';
import { findArraySpan, parseFenceEntries, parseJsonc } from '../jsonc_edit.ts';
import { parseEntries } from '../mounts.ts';
import {
  loadGlobalConfig,
  makeGlobalConfig,
  saveGlobalConfig,
} from '../config.ts';
import { withTemp } from './helpers.ts';

const SEL: WizardSelection = {
  source: [{ source: '${localEnv:HOME}/code/p', target: '/workspaces/p' }],
  skills: [{
    source: '/srv/skills/agent',
    target: '/home/vscode/.claude/skills/agent',
  }],
};

/** Read the source/skills fence rows back out of a written overlay. */
function fenceRows(text: string) {
  const span = findArraySpan(text, 'mounts')!;
  return {
    source: parseEntries(parseFenceEntries(text, span, 'source')),
    skills: parseEntries(parseFenceEntries(text, span, 'skills')),
  };
}

/** A project dir with an empty `.devcontainer/`, so the overlay lands beside the config. */
async function projectWithDevcontainer(dir: string): Promise<string> {
  await Deno.mkdir(`${dir}/.devcontainer`, { recursive: true });
  return dir;
}

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true).catch(() => false);
}

Deno.test('first creation: overlay beside the config, both fences populated', async () => {
  await withTemp(async (dir) => {
    await projectWithDevcontainer(dir);
    const cfgPath = `${dir}/config.json`;
    const result = await applySelection(dir, SEL, {
      globalConfigPath: cfgPath,
    });
    assert(result.created);
    assertEquals(result.overlayPath, `${dir}/.devcontainer/devc.jsonc`);

    const text = await Deno.readTextFile(result.overlayPath);
    assertStringIncludes(text, 'devc:source');
    assertStringIncludes(text, 'devc:skills');
    const rows = fenceRows(text);
    assertEquals(rows.source, SEL.source);
    assertEquals(rows.skills, SEL.skills);

    // The overlay is valid JSONC holding exactly the two mounts and nothing else.
    const parsed = parseJsonc(text) as { mounts: string[] };
    assertEquals(parsed.mounts.length, 2);

    // recentSkills persisted (raw host paths).
    const cfg = await loadGlobalConfig(cfgPath);
    assertEquals(cfg.recentSkills, ['/srv/skills/agent']);
  });
});

// The point of the whole change: `devc config` has no code path that writes `.devcontainer/`,
// so the folder stays exactly as standalone as it was before the wizard ran.
Deno.test('devcontainer.json is never created, scaffolded, or modified', async () => {
  await withTemp(async (dir) => {
    await projectWithDevcontainer(dir);
    const configPath = `${dir}/.devcontainer/devcontainer.json`;
    const original = '{\n  "name": "mine",\n  "mounts": []\n}\n';
    await Deno.writeTextFile(configPath, original);

    await applySelection(dir, SEL, { globalConfigPath: `${dir}/config.json` });

    assertEquals(await Deno.readTextFile(configPath), original);
    for (const gone of ['Dockerfile', 'post-create.sh', 'scripts']) {
      assertEquals(
        await exists(`${dir}/.devcontainer/${gone}`),
        false,
        `${gone} should not have been scaffolded`,
      );
    }
  });
});

Deno.test('no .devcontainer/ ⇒ the overlay goes to .devc/, and none is created', async () => {
  await withTemp(async (dir) => {
    const result = await applySelection(dir, SEL, {
      globalConfigPath: `${dir}/config.json`,
    });
    assertEquals(result.overlayPath, `${dir}/.devc/devc.jsonc`);
    assert(result.created);
    assertEquals(fenceRows(await Deno.readTextFile(result.overlayPath)), SEL);
    assertEquals(
      await exists(`${dir}/.devcontainer`),
      false,
      'recording a mount must not drag in a .devcontainer/',
    );
  });
});

// Only the first hit is ever read, so writing a second overlay would silently do nothing.
Deno.test('an existing overlay is written in place, whatever its name', async () => {
  for (const rel of ['.devc/devc.json', '.devcontainer/devc.json']) {
    await withTemp(async (dir) => {
      await projectWithDevcontainer(dir);
      const path = `${dir}/${rel}`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), {
        recursive: true,
      });
      await Deno.writeTextFile(path, '{\n  "mounts": []\n}\n');

      const result = await applySelection(dir, SEL, {
        globalConfigPath: `${dir}/config.json`,
      });
      assertEquals(result.overlayPath, path);
      assertEquals(result.created, false);
      assertEquals(
        await exists(`${dir}/.devcontainer/devc.jsonc`),
        false,
        'a second overlay must not be created beside an existing one',
      );
    });
  }
});

Deno.test('idempotence: applying the same selection twice is byte-identical', async () => {
  await withTemp(async (dir) => {
    const cfgPath = `${dir}/config.json`;
    const { overlayPath } = await applySelection(dir, SEL, {
      globalConfigPath: cfgPath,
    });
    const first = await Deno.readTextFile(overlayPath);
    const result2 = await applySelection(dir, SEL, {
      globalConfigPath: cfgPath,
    });
    assert(!result2.created, 'second apply must be an update');
    assertEquals(await Deno.readTextFile(overlayPath), first);
  });
});

Deno.test('update preserves hand-written mounts, keys and comments', async () => {
  await withTemp(async (dir) => {
    const cfgPath = `${dir}/config.json`;
    await projectWithDevcontainer(dir);
    const path = `${dir}/.devcontainer/devc.jsonc`;
    await Deno.writeTextFile(
      path,
      `{
  // my own notes
  "mounts": [
    "type=bind,source=/host/mine,target=/mnt/mine"
  ],
  "remoteEnv": { "MY_VAR": "value" },
  // Deliberately the retired \`additionalFeatures\` name, not \`features\`: this asserts
  // that keys devc does NOT manage survive byte-for-byte. Swapping it for a known key
  // would weaken the test.
  "additionalFeatures": { "ghcr.io/x/y:1": { "version": "latest" } }
}
`,
    );

    await applySelection(dir, SEL, { globalConfigPath: cfgPath });
    const after = await Deno.readTextFile(path);

    assertStringIncludes(after, '  // my own notes\n');
    assertStringIncludes(
      after,
      '"type=bind,source=/host/mine,target=/mnt/mine"',
    );
    const parsed = parseJsonc(after) as {
      mounts: string[];
      remoteEnv: Record<string, string>;
      additionalFeatures: Record<string, unknown>;
    };
    assertEquals(parsed.remoteEnv, { MY_VAR: 'value' });
    assertEquals(parsed.additionalFeatures, {
      'ghcr.io/x/y:1': { version: 'latest' },
    });
    // The hand-written mount plus the two fenced ones.
    assertEquals(parsed.mounts.length, 3);
    assertEquals(fenceRows(after), SEL);
  });
});

Deno.test('applyFences inserts fences into an overlay that lacks them', () => {
  const src =
    '{\n  "name": "x",\n  "mounts": [\n    "type=bind,source=/a,target=/b"\n  ]\n}\n';
  const out = applyFences(src, SEL);
  assertStringIncludes(out, 'devc:source');
  assertStringIncludes(out, 'devc:skills');
  const parsed = parseJsonc(out) as { mounts: string[]; name: string };
  assertEquals(parsed.name, 'x');
  assert(parsed.mounts.includes('type=bind,source=/a,target=/b'));
});

Deno.test("remembered list seeds a fresh project's skills (existing host paths only)", async () => {
  await withTemp(async (dir) => {
    const cfgPath = `${dir}/config.json`;
    // Project 1 applies skills A and B, persisting them to recentSkills.
    const a = `${dir}/skillA`;
    const b = `${dir}/skillB`;
    await Deno.mkdir(a);
    await Deno.mkdir(b);
    const sel: WizardSelection = {
      source: [],
      skills: [
        { source: a, target: '/home/vscode/.claude/skills/skillA' },
        { source: b, target: '/home/vscode/.claude/skills/skillB' },
      ],
    };
    await applySelection(`${dir}/proj1`, sel, { globalConfigPath: cfgPath });
    const cfg = await loadGlobalConfig(cfgPath);
    assertEquals(cfg.recentSkills, [a, b]);

    // Now remove skillB's host dir; only A should still exist for the seed filter.
    await Deno.remove(b, { recursive: true });
    const existing = [];
    for (const p of cfg.recentSkills) {
      try {
        await Deno.stat(p);
        existing.push(p);
      } catch {
        // dropped
      }
    }
    assertEquals(existing, [a]);
  });
});

Deno.test('saveGlobalConfig round-trips recentSkills and preserves unknown keys', async () => {
  await withTemp(async (dir) => {
    const path = `${dir}/config.json`;
    const cfg = makeGlobalConfig(['~/code'], ['~/skills'], path, { misc: 1 }, [
      '~/skills/x',
    ]);
    await saveGlobalConfig(cfg);
    const loaded = await loadGlobalConfig(path);
    assertEquals(loaded.recentSkills, ['~/skills/x']);
    assertEquals(loaded.codeRoots, ['~/code']);
    assertEquals(loaded.extra, { misc: 1 });
  });
});

Deno.test('changed: true on creation, false when the selection round-trips identically', async () => {
  await withTemp(async (dir) => {
    const cfgPath = `${dir}/config.json`;
    const first = await applySelection(dir, SEL, { globalConfigPath: cfgPath });
    assert(first.created);
    assert(first.changed, 'first creation must count as a change');

    const path = first.overlayPath;
    const before = await Deno.readTextFile(path);
    const beforeMtime = (await Deno.stat(path)).mtime;

    // Re-applying the same rows produces the same bytes: no change, and no write at all.
    const again = await applySelection(dir, SEL, { globalConfigPath: cfgPath });
    assert(!again.created);
    assertEquals(again.changed, false);
    assertEquals(await Deno.readTextFile(path), before);
    assertEquals(
      (await Deno.stat(path)).mtime?.getTime(),
      beforeMtime?.getTime(),
    );
  });
});

Deno.test('changed: true when the selection differs from what is on disk', async () => {
  await withTemp(async (dir) => {
    const cfgPath = `${dir}/config.json`;
    const { overlayPath } = await applySelection(dir, SEL, {
      globalConfigPath: cfgPath,
    });

    const edited: WizardSelection = {
      source: SEL.source,
      skills: [], // drop the skills mount
    };
    const result = await applySelection(dir, edited, {
      globalConfigPath: cfgPath,
    });
    assert(result.changed, 'dropping a mount must count as a change');
    assertEquals(fenceRows(await Deno.readTextFile(overlayPath)).skills, []);
  });
});

Deno.test('changed: false leaves the fences and a toggled-and-restored row intact', async () => {
  await withTemp(async (dir) => {
    const cfgPath = `${dir}/config.json`;
    const { overlayPath } = await applySelection(dir, SEL, {
      globalConfigPath: cfgPath,
    });

    // Toggle the skills mount off, then back on — the end state matches the start state, so
    // the second apply reports no change even though the user did touch the selection.
    await applySelection(dir, { source: SEL.source, skills: [] }, {
      globalConfigPath: cfgPath,
    });
    const restored = await applySelection(dir, SEL, {
      globalConfigPath: cfgPath,
    });
    assert(restored.changed, 'restoring the row is itself a change from disk');

    const noop = await applySelection(dir, SEL, { globalConfigPath: cfgPath });
    assertEquals(noop.changed, false);
    assertEquals(
      fenceRows(await Deno.readTextFile(overlayPath)).skills,
      SEL.skills,
    );
  });
});
