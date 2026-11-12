// The page's push dialog, as text: what a `push_plan` answer (`git_push.ts`'s `PushPlan`) would
// send and what it warns about, for a trusted page's Push (`push: 'user'`). The same warnings as
// devc-desktop's push card (`devc-desktop/src/main/policy.ts`'s `planWarnings`). Pure (no DOM),
// shared with the Deno tests (`devc/tests/web_push_plan_test.ts`); `ui.js` draws it.

/**
 * @typedef {{sha: string, subject: string, author: string}} PlanCommit
 * @typedef {{ok: true, folder: string, remote: string, branch: string, sha: string,
 *   remoteSha: string | null, commits: PlanCommit[], totalCommits: number,
 *   defaultBranch: boolean, guarded: string[], lfs: boolean, fastForward: boolean,
 *   upToDate: boolean} | {ok: false, problem: string}} PushPlan
 */

/** Whether the plan can be pushed: the recipe refuses an LFS pointer and a non-fast-forward. */
export function canPushPlan(/** @type {PushPlan} */ plan) {
  return plan.ok && !plan.lfs && plan.fastForward && !plan.upToDate;
}

/** What the user should know before pushing `plan`, one line each. */
export function pushPlanWarnings(/** @type {PushPlan} */ plan) {
  if (!plan.ok) return [];
  const out = [];
  if (plan.upToDate) out.push('Up to date: nothing to push');
  if (plan.defaultBranch) {
    out.push(`Pushes the default branch (${plan.branch})`);
  }
  if (plan.guarded.length > 0) {
    const more = plan.guarded.length > 5
      ? ` and ${plan.guarded.length - 5} more`
      : '';
    out.push(
      `Changes workflows: ${plan.guarded.slice(0, 5).join(', ')}${more}`,
    );
  }
  if (!plan.fastForward) {
    out.push('Not a fast-forward of the remote branch: it would be refused');
  }
  if (plan.lfs) out.push('Adds an LFS pointer: it would be refused');
  return out;
}

/**
 * The dialog's heading, and its commit lines (`<sha7> <subject> — <author>`, then `and N more`).
 * @param {Extract<PushPlan, {ok: true}>} plan
 */
export function pushPlanText(plan) {
  const n = plan.totalCommits;
  const heading = `Push ${plan.branch} to ${plan.remote}${
    plan.remoteSha === null ? ' (creates the branch)' : ''
  }: ${n} commit${n === 1 ? '' : 's'} at ${plan.sha.slice(0, 12)}`;
  const commits = plan.commits.map((c) =>
    `${c.sha.slice(0, 7)} ${c.subject} — ${c.author}`
  );
  const more = n - plan.commits.length;
  if (more > 0) commits.push(`and ${more} more`);
  return { heading, commits };
}
