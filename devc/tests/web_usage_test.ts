import { assertEquals } from 'jsr:@std/assert';
import { fromFileUrl } from 'jsr:@std/path';
import {
  mergeUsageSources,
  parseUsageFile,
  readUsage,
  usageFiles,
  type UsageSource,
  watchUsage,
} from '../web/usage.ts';

const env = (vars: Record<string, string>) => ({
  get: (k: string) => vars[k],
});

const TAP = fromFileUrl(
  new URL('../../scripts/devc-usage-tap', import.meta.url),
);

/** A usage file as a reporter writes it. */
const file = (observedAt: number, pct = 42, agent = 'claude') => ({
  v: 1,
  agent,
  observed_at: observedAt,
  windows: [
    {
      id: 'five_hour',
      label: '5h',
      used_percentage: pct,
      resets_at: 1760000000,
    },
    { id: 'seven_day', label: '7d', used_percentage: 18, resets_at: null },
  ],
});

const source = (observedAt: number, pct = 42, agent = 'claude') => ({
  agent,
  observedAt,
  windows: [
    {
      id: 'five_hour',
      label: '5h',
      usedPercentage: pct,
      resetsAt: 1760000000,
    },
    { id: 'seven_day', label: '7d', usedPercentage: 18, resetsAt: null },
  ],
});

/** Writes `json` to `path` the way a reporter does: a temp file in the same dir, then rename. */
async function writeAtomic(path: string, json: unknown) {
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.writeTextFile(tmp, JSON.stringify(json));
  await Deno.rename(tmp, path);
}

Deno.test("usageFiles: devc containers' Claude home, then the host's", () => {
  assertEquals(usageFiles(env({}), '/home/u', '/home/u/.config/devc/.claude'), [
    '/home/u/.config/devc/.claude/devc-usage.json',
    '/home/u/.claude/devc-usage.json',
  ]);
  assertEquals(
    usageFiles(env({ CLAUDE_CONFIG_DIR: '/c' }), '/home/u', '/d'),
    ['/d/devc-usage.json', '/c/devc-usage.json'],
  );
  // The same dir twice is watched once.
  assertEquals(
    usageFiles(env({ CLAUDE_CONFIG_DIR: '/d' }), '/home/u', '/d'),
    ['/d/devc-usage.json'],
  );
});

Deno.test('parseUsageFile accepts the contract and keeps window order', () => {
  assertEquals(parseUsageFile(file(1760000123)), source(1760000123));
  // A missing resets_at is null.
  assertEquals(
    parseUsageFile({
      v: 1,
      agent: 'claude',
      observed_at: 1,
      windows: [{ id: 'm', label: '1mo', used_percentage: 0 }],
    })?.windows,
    [{ id: 'm', label: '1mo', usedPercentage: 0, resetsAt: null }],
  );
});

Deno.test('parseUsageFile refuses anything malformed or with an unknown v', () => {
  const ok = file(1);
  const bad: unknown[] = [
    null,
    'x',
    [],
    { ...ok, v: 2 },
    { ...ok, v: undefined },
    { ...ok, agent: '' },
    { ...ok, agent: 3 },
    { ...ok, observed_at: '1760000000' },
    { ...ok, observed_at: NaN },
    { ...ok, windows: {} },
    { ...ok, windows: [null] },
    { ...ok, windows: [{ ...ok.windows[0], id: '' }] },
    { ...ok, windows: [{ ...ok.windows[0], label: 5 }] },
    { ...ok, windows: [{ ...ok.windows[0], used_percentage: '42' }] },
    { ...ok, windows: [{ ...ok.windows[0], resets_at: '2025-10-13' }] },
  ];
  for (const b of bad) assertEquals(parseUsageFile(b), null, JSON.stringify(b));
});

Deno.test('mergeUsageSources: one per agent, the newest observation wins', () => {
  const merged = mergeUsageSources([
    source(100, 10),
    null,
    source(50, 5, 'copilot'),
    source(200, 20),
    source(150, 15),
  ]);
  assertEquals(merged, [source(200, 20), source(50, 5, 'copilot')]);
});

Deno.test('readUsage: missing and malformed files are simply absent', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/a.json`, '{not json');
    await Deno.writeTextFile(`${dir}/b.json`, JSON.stringify(file(7)));
    assertEquals(
      await readUsage([`${dir}/a.json`, `${dir}/b.json`, `${dir}/none.json`]),
      [source(7)],
    );
    assertEquals(await readUsage([`${dir}/none.json`]), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Resolves with the next sources `next()` is handed, or rejects after `ms`. */
function sourcesFeed() {
  const seen: UsageSource[][] = [];
  let waiter: ((s: UsageSource[]) => void) | null = null;
  return {
    seen,
    onChange(s: UsageSource[]) {
      seen.push(s);
      waiter?.(s);
      waiter = null;
    },
    next(ms = 3000): Promise<UsageSource[]> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no change')), ms);
        waiter = (s) => {
          clearTimeout(timer);
          resolve(s);
        };
      });
    },
  };
}

Deno.test('watchUsage reports the first read, then each change once, newest file winning', async () => {
  const root = await Deno.makeTempDir();
  const a = `${root}/a/devc-usage.json`;
  const b = `${root}/b/devc-usage.json`;
  await Deno.mkdir(`${root}/a`);
  await Deno.mkdir(`${root}/b`);
  const feed = sourcesFeed();
  const first = feed.next();
  const w = watchUsage([a, b], (s) => feed.onChange(s), { debounceMs: 20 });
  try {
    assertEquals(await first, []);

    let next = feed.next();
    await writeAtomic(a, file(100, 10));
    assertEquals(await next, [source(100, 10)]);

    // A newer observation in the other file takes over.
    next = feed.next();
    await writeAtomic(b, file(200, 20));
    assertEquals(await next, [source(200, 20)]);

    // An older one in the first file changes nothing; nor does an unrelated file, nor a
    // malformed rewrite of the losing file.
    await writeAtomic(a, file(150, 15));
    await Deno.writeTextFile(`${root}/b/other.json`, '{}');
    await new Promise((r) => setTimeout(r, 150));
    assertEquals(feed.seen.length, 3);

    // A malformed newest file drops out, and the other file shows through.
    next = feed.next();
    await writeAtomic(b, { v: 99 });
    assertEquals(await next, [source(150, 15)]);
  } finally {
    w.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('watchUsage picks up a dir created after it starts, without creating it', async () => {
  const root = await Deno.makeTempDir();
  const dir = `${root}/claude`;
  const path = `${dir}/devc-usage.json`;
  const feed = sourcesFeed();
  const first = feed.next();
  const w = watchUsage([path], (s) => feed.onChange(s), {
    debounceMs: 20,
    pollMs: 100,
  });
  try {
    assertEquals(await first, []);
    assertEquals(await Deno.stat(dir).then(() => true, () => false), false);

    await Deno.mkdir(dir);
    await writeAtomic(path, file(1));
    assertEquals(await feed.next(), [source(1)]);

    // Later changes keep arriving once the dir is watched.
    await new Promise((r) => setTimeout(r, 250));
    const next = feed.next(1000);
    await writeAtomic(path, file(2, 50));
    assertEquals(await next, [source(2, 50)]);
  } finally {
    w.stop();
    await Deno.remove(root, { recursive: true });
  }
});

async function tap(dir: string, stdin: string) {
  const child = new Deno.Command('bash', {
    args: [TAP],
    env: { CLAUDE_CONFIG_DIR: dir },
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(stdin));
  await writer.close();
  const out = await child.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

const hasJq = new Deno.Command('sh', { args: ['-c', 'command -v jq'] })
  .outputSync().success;

Deno.test({
  name: 'devc-usage-tap writes a file parseUsageFile accepts, silently',
  ignore: !hasJq,
  async fn() {
    const dir = await Deno.makeTempDir();
    try {
      const r = await tap(
        dir,
        JSON.stringify({
          model: { display_name: 'Opus' },
          rate_limits: {
            five_hour: { used_percentage: 42.5, resets_at: 1760000000 },
            seven_day: {
              used_percentage: 18,
              resets_at: '2025-10-13T10:00:00.123Z',
            },
            seven_day_opus: { used_percentage: 3, resets_at: 1760400000000 },
          },
        }),
      );
      assertEquals(r, { code: 0, stdout: '', stderr: '' });
      const parsed = parseUsageFile(
        JSON.parse(await Deno.readTextFile(`${dir}/devc-usage.json`)),
      );
      assertEquals(parsed?.agent, 'claude');
      assertEquals(
        parsed?.windows.map((
          w,
        ) => [w.id, w.label, w.usedPercentage, w.resetsAt]),
        [
          ['five_hour', '5h', 42.5, 1760000000],
          ['seven_day', '7d', 18, 1760349600],
          ['seven_day_opus', '7d opus', 3, 1760400000],
        ],
      );
      const now = Date.now() / 1000;
      assertEquals(Math.abs(parsed!.observedAt - now) < 60, true);
      // Only the file itself is left: the temp file was renamed over it.
      const names = [];
      for await (const e of Deno.readDir(dir)) names.push(e.name);
      assertEquals(names, ['devc-usage.json']);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: 'devc-usage-tap never erases a good observation, and never fails',
  ignore: !hasJq,
  async fn() {
    const dir = await Deno.makeTempDir();
    try {
      const good = JSON.stringify(file(5));
      await Deno.writeTextFile(`${dir}/devc-usage.json`, good);
      for (
        const input of [
          '{"model":{}}',
          '{"rate_limits":{}}',
          '{"rate_limits":null}',
          '{"rate_limits":{"five_hour":{}}}',
          'not json',
          '',
        ]
      ) {
        assertEquals(await tap(dir, input), {
          code: 0,
          stdout: '',
          stderr: '',
        }, input);
      }
      assertEquals(await Deno.readTextFile(`${dir}/devc-usage.json`), good);
      // A Claude home that does not exist is not created.
      assertEquals((await tap(`${dir}/none`, good)).code, 0);
      assertEquals(
        await Deno.stat(`${dir}/none`).then(() => true, () => false),
        false,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
