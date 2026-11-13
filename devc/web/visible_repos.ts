// Which repos' git marks some connected page shows, so `GitStatusWatch` and `GitChangesWatch` read
// only those often: a page's `visible_repos` says it shows every repo (its Projects section is
// open) or just some (In use's repo cards). Display data only: a page that says too little gets
// stale marks, never a wrong action, since every action reads its repo again or checks on its own.

/** What one page last said it shows: see `protocol.ts`'s `visible_repos`. */
export interface VisibleReport {
  all: boolean;
  folders: ReadonlySet<string>;
}

/**
 * The host folders some client shows, or `null` for every folder. A client that never said is
 * counted as showing nothing (`/main`, the host status page), except devc-desktop's Containers
 * pane (`desktop`), which an app build from before `visible_repos` never tells: every folder.
 * With no client saying anything at all, every folder too.
 */
export function visibleFolders(
  clients: Iterable<{ desktop: boolean; report?: VisibleReport }>,
): ReadonlySet<string> | null {
  const shown = new Set<string>();
  let said = false;
  for (const c of clients) {
    if (!c.report) {
      if (c.desktop) return null;
      continue;
    }
    said = true;
    if (c.report.all) return null;
    for (const f of c.report.folders) shown.add(f);
  }
  return said ? shown : null;
}

/** Whether `folder` is shown under `visible` (`null`: every folder). */
export function isVisible(
  visible: ReadonlySet<string> | null,
  folder: string,
): boolean {
  return visible === null || visible.has(folder);
}

/** Of `folders`, those hidden under `before` and shown under `after`. */
export function revealed(
  before: ReadonlySet<string> | null,
  after: ReadonlySet<string> | null,
  folders: Iterable<string>,
): string[] {
  return [...new Set(folders)].filter((f) =>
    !isVisible(before, f) && isVisible(after, f)
  );
}
