import { assert, assertEquals } from 'jsr:@std/assert';
import {
  canPushPlan,
  pushPlanText,
  pushPlanWarnings,
} from '../web/static/lib/push_plan.js';

const plan = (over: Record<string, unknown> = {}) => ({
  ok: true as const,
  folder: '/w/repo',
  remote: 'git@github.com:acme/widget.git',
  branch: 'feat',
  sha: 'a'.repeat(40),
  remoteSha: null,
  commits: [{ sha: 'b'.repeat(40), subject: 'work', author: 'tester' }],
  totalCommits: 3,
  defaultBranch: false,
  guarded: [] as string[],
  lfs: false,
  fastForward: true,
  upToDate: false,
  ...over,
});

Deno.test('push plan: a plain plan pushes, with no warnings', () => {
  assert(canPushPlan(plan()));
  assertEquals(pushPlanWarnings(plan()), []);
  assertEquals(pushPlanText(plan()), {
    heading:
      'Push feat to git@github.com:acme/widget.git (creates the branch): 3 commits at aaaaaaaaaaaa',
    commits: ['bbbbbbb work — tester', 'and 2 more'],
  });
});

Deno.test('push plan: the waivable warnings still push; refusals do not', () => {
  const waived = plan({
    defaultBranch: true,
    guarded: ['.github/workflows/a.yml'],
    remoteSha: 'c'.repeat(40),
  });
  assert(canPushPlan(waived));
  assertEquals(pushPlanWarnings(waived), [
    'Pushes the default branch (feat)',
    'Changes workflows: .github/workflows/a.yml',
  ]);
  assert(!pushPlanText(waived).heading.includes('creates'));
  assert(!canPushPlan(plan({ lfs: true })));
  assert(!canPushPlan(plan({ fastForward: false })));
  assert(!canPushPlan(plan({ upToDate: true })));
  assert(!canPushPlan({ ok: false, problem: 'x' }));
  assertEquals(pushPlanWarnings({ ok: false, problem: 'x' }), []);
});

Deno.test('push plan: more than five workflow paths are counted', () => {
  const guarded = Array.from({ length: 7 }, (_, i) => `w${i}`);
  assertEquals(
    pushPlanWarnings(plan({ guarded })),
    ['Changes workflows: w0, w1, w2, w3, w4 and 2 more'],
  );
});
