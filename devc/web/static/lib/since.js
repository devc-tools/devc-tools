// A PR diff tile's **Compare** starting points: each head the file was marked Viewed at in devc
// web, and the commit of the user's latest review. Pure, so it is tested without a page.

/**
 * One starting point. `path` is where to read the file at `headSha`: a Viewed mark's recorded
 * path, or `null` for the review (the file's path now, else the path it was renamed from).
 *
 * @typedef {{kind: 'viewed' | 'review', headSha: string, path: string | null, at: string}}
 *   SinceOption
 */

/** @param {unknown} s */
const time = (s) => {
  const t = typeof s === 'string' ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};

/**
 * The **Compare** choices besides `PR changes`, newest first: each head the file was marked
 * Viewed at (from `viewedHistory`, newest first, as `pr_diff` gives it) that is not the PR's head
 * now, once each, and the user's latest review (`pr.myReview`) unless it is at the head. Times
 * are compared as instants, not strings (`at` has milliseconds, `submittedAt` none). A review at
 * a head a Viewed mark also has makes one option, named by whichever came later. The first is the
 * default: the latest point wins.
 *
 * @param {unknown} viewedHistory
 * @param {{headSha?: unknown, myReview?: unknown} | null | undefined} pr
 * @returns {SinceOption[]}
 */
export function sinceOptions(viewedHistory, pr) {
  const head = pr?.headSha;
  /** @type {Map<string, SinceOption>} */
  const out = new Map();
  for (const m of Array.isArray(viewedHistory) ? viewedHistory : []) {
    if (
      m?.viewed !== 'VIEWED' || typeof m.headSha !== 'string' ||
      m.headSha === head || out.has(m.headSha)
    ) continue;
    out.set(m.headSha, {
      kind: 'viewed',
      headSha: m.headSha,
      path: String(m.path),
      at: String(m.at),
    });
  }
  const r = /** @type {any} */ (pr?.myReview);
  if (
    r && typeof r.commit === 'string' && typeof r.submittedAt === 'string' &&
    r.commit !== head
  ) {
    const same = out.get(r.commit);
    if (!same || time(r.submittedAt) > time(same.at)) {
      out.set(r.commit, {
        kind: 'review',
        headSha: r.commit,
        path: null,
        at: r.submittedAt,
      });
    }
  }
  return [...out.values()].sort((a, b) => time(b.at) - time(a.at));
}
