// When the page reads a repo's pull request again without being asked: its Pull request row and
// its open PR diff tiles would otherwise keep the head they first read until a reload. The
// server lists the PR afresh for each read (`pr_review.ts`, `LISTING_FRESH_MS`), so a recheck
// that finds the same head draws nothing.
//
// A repo is read again when its push/pull state in `projects` changes (a push from this machine
// drops `ahead`, a fetch of someone else's raises `behind`, a branch switch moves the PR), every
// {@link PR_RECHECK_MS} while the page shows (a push the host never sees: `devc-bridge`'s, or
// another machine's), and when the page shows again after {@link PR_RECHECK_AFTER_HIDDEN_MS}.

/** How often a shown page reads its PRs again. */
export const PR_RECHECK_MS = 60_000;
/** A page shown again reads its PRs if the last recheck is at least this old. */
export const PR_RECHECK_AFTER_HIDDEN_MS = 15_000;

/** A repo's key in the page's PR maps: `localFolder\nroot`. */
export function prRepoKey(localFolder, root) {
  return `${localFolder}\n${root}`;
}

/**
 * Each repo's push/pull state from a `projects` message, as text to compare, by
 * {@link prRepoKey}.
 *
 * @param {unknown} projects  the message's `projects`
 * @returns {Map<string, string>}
 */
export function gitSignatures(projects) {
  const out = new Map();
  if (!Array.isArray(projects)) return out;
  for (const p of projects) {
    if (typeof p?.localFolder !== 'string' || !Array.isArray(p.repos)) continue;
    for (const r of p.repos) {
      if (typeof r?.folder !== 'string') continue;
      out.set(
        prRepoKey(p.localFolder, r.folder),
        JSON.stringify([r.git ?? null, r.gitProblem ?? null]),
      );
    }
  }
  return out;
}

/**
 * The repos listed in both whose push/pull state differs. A repo new to `next` is not one: its
 * PR is read when it is first shown.
 *
 * @param {Map<string, string>} prev
 * @param {Map<string, string>} next
 * @returns {Set<string>}
 */
export function changedRepos(prev, next) {
  const out = new Set();
  for (const [key, sig] of next) {
    const was = prev.get(key);
    if (was !== undefined && was !== sig) out.add(key);
  }
  return out;
}

/**
 * Calls `recheck(keys)` with the repos whose state changed, or `recheck(null)` (every repo) on
 * the timer and when the page shows again. Feed it each `projects` message.
 *
 * @param {(keys: Set<string> | null) => void} recheck
 * @returns {{projects: (projects: unknown) => void}}
 */
export function createPrRecheck(recheck) {
  let sigs = new Map();
  let last = Date.now();
  const all = () => {
    last = Date.now();
    recheck(null);
  };
  setInterval(() => {
    if (document.visibilityState === 'visible') all();
  }, PR_RECHECK_MS);
  document.addEventListener('visibilitychange', () => {
    if (
      document.visibilityState === 'visible' &&
      Date.now() - last >= PR_RECHECK_AFTER_HIDDEN_MS
    ) all();
  });
  return {
    projects(projects) {
      const next = gitSignatures(projects);
      const changed = changedRepos(sigs, next);
      sigs = next;
      if (changed.size > 0) recheck(changed);
    },
  };
}
