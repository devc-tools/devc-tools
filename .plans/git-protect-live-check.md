# git-protect-live-check

**Repo:** `devc-tools`
**Run on:** any checkout for Steps 1–4 and the offline tests; a **host** with Docker (Docker
Desktop on macOS is where the gap was seen) for Step 0 and the Validation.

devc's git protection freezes `.git/config` and `.git/hooks` with read-only single-file and
directory bind mounts (`devc-core/mounts.ts` § git protection). **A read-only file mount can
vanish from a running container**, and nothing notices: `devc status` keeps printing
`protected`, and `devc up --bridge-repo` keeps granting pushes. Make every protection check
read the container's **kernel** mount table, so a lost mount reports `MISMATCH`.

Making the protection _survive_ a host rewrite is a separate, later design question (see
§ Out of scope). This plan only makes the loss visible and makes the bridge refuse on it.

## Checklist

- [ ] Step 0: measure the mechanism on a host, and pick how the live table is read (§ Step 0)
- [ ] Step 1: `parseMountinfo` and `getLiveMounts` in `devc-core/container.ts` (§ Step 1)
- [ ] Step 2: `gitProtectState` checks the live table when given one (§ Step 2)
- [ ] Step 3: `devc status` and the three `devc/bridge.ts` call sites pass it (§ Step 3)
- [ ] Step 4: help, README and doc comments say what is actually checked (§ Step 4)
- [ ] Tests (§ Tests), then Validation on a host (§ Validation)

## What was observed (2026-10-16/17, Docker Desktop on macOS)

In the `devc-dev` container, every mounted repo had its three protection mounts, except
`/workspaces/tools/devc-tools`, whose `.git/config` mount was **gone from
`/proc/self/mountinfo`** while `.git` (rw) and `.git/hooks` (ro) were still there:

```
223 215 0:34 /bingles/code/tools/devc-tools/.git        /workspaces/tools/devc-tools/.git       rw,…
241 223 0:34 /bingles/code/tools/devc-tools/.git/hooks  /workspaces/tools/devc-tools/.git/hooks ro,…
```

- `[ -w /workspaces/tools/devc-tools/.git/config ]` was true; for every other repo it was false.
- `sha1sum` of the container's `.git/config` matched `shasum` of the host's: the path resolves
  through the read-write `.git` mount to the **live host file**. A write from the container
  lands on the host.
- The host file's mtime (20:12 local) was after the container started (19:54). The other
  repos' configs were last written before the start. The config holds `vscode-merge-base` and
  `github-pr-base-branch` keys, which VS Code and the GitHub PR extension write on the host.
- `devc status` on the host printed `/workspaces/tools/devc-tools: protected`.

**Likely mechanism (Step 0 confirms it):** git rewrites config by writing `config.lock` and
renaming it over `config`. That replaces the inode the file mount was made on, and the kernel
detaches a mount whose mountpoint dentry is invalidated (on virtiofs/FUSE, and in another
mount namespace on native Linux). `.git/hooks` is a directory that is never renamed, so it
survives.

**Why `devc status` missed it:** `printGitProtection` (`devc/main.ts`) gets its table from
`getContainerMounts` (`devc-core/container.ts`), which is `docker inspect --format
'{{json .Mounts}}'`: the mounts Docker made **at create time**. It never changes, so
`gitProtectState` passes. The doc comments call this "the live mount table"; it is not.

**Why it matters beyond `status`:** `devc/bridge.ts` calls `gitProtectState` at three grant
sites (around lines 225, 300 and 541) and then reads the pinned remote from the config's
host source, on the premise that the container cannot have written it. With the mount gone,
an agent can repoint `remote.origin.url` at another GitHub repo before a grant, and gh-push
would then publish to it.

## Step 0: measure, then pick how the live table is read

On a host, with a running devc container for a repo `R` that has protection in force:

1. In the container: `grep "R/.git" /proc/self/mountinfo` shows three entries.
2. On the host: `git -C <host path of R> config devc.probe 1` (a lock-and-rename rewrite).
3. In the container: the `.git/config` entry is gone, and `[ -w R/.git/config ]` is true.
4. On the host: `git -C <host path of R> config --unset devc.probe`, then `devc build`.

If step 3 does not reproduce, stop and report: the mechanism is something else, and this plan's
premise needs revisiting.

Then measure both ways of reading the table from the host, and record the results in this plan:

- **(a) `docker exec <id> cat /proc/self/mountinfo`.** Simple. But it runs the container's own
  `cat`, which root in the container can replace, so the answer is only as trustworthy as the
  container.
- **(b) A throwaway helper sharing the container's PID namespace**, from the container's own
  image (its layers are read-only to the container, so its binaries are pristine):
  `docker run --rm --pid=container:<id> --entrypoint cat <image id> /proc/1/mountinfo`.
  Measure whether the helper can read PID 1's `mountinfo` with default capabilities, how long
  it takes, and that it shows the same table as (a).

**Default: (b) if it works with default capabilities, else (a).** With (a), `devc status`
labels the result as reported by the container (see Step 3). Either way, the contract in
Step 1 is the same.

## Step 1: reading the live table (`devc-core/container.ts`)

```ts
/** One entry of a container's kernel mount table (`/proc/<pid>/mountinfo`). */
export interface LiveMount {
  /** Field 5, octal escapes (`\040` etc.) decoded: the container-side path. */
  mountPoint: string;
  /** `ro` is among field 6's per-mount options. */
  readonly: boolean;
}

/** Parses `mountinfo` text. Pure; malformed lines are skipped. */
export function parseMountinfo(text: string): LiveMount[];

/**
 * The kernel mount table of `localFolder`'s **running** container, read as Step 0 chose.
 * `null` when there is no running container or the read fails: callers then fall back to
 * the create-time table and say so.
 */
export async function getLiveMounts(
  localFolder: string,
): Promise<LiveMount[] | null>;
```

- Entries are in mount order. Several can share a mount point (overmounts), and the **last**
  one is what a path resolves through. `parseMountinfo` keeps every entry, and the comparison
  in Step 2 uses the last one per mount point.
- `getLiveMounts` finds the container the same way `getContainerMounts` does
  (`findContainer(localFolder, true)`), but only a running one counts.

## Step 2: `gitProtectState` (`devc-core/overlay.ts`)

Add one optional parameter. The signature becomes:

```ts
export function gitProtectState(
  row: MountRow & { kind?: GitRowKind },
  mounts: readonly { destination: string; rw: boolean }[],
  live?: readonly LiveMount[] | null,
): GitProtectState;
```

- `live` absent or `null`: exactly today's behaviour.
- `live` given: on top of today's checks, the git dir, `<git dir>/config` and
  `<git dir>/hooks` must each be a mount point in `live` (last entry per point), and `config`
  and `hooks` must be `readonly` there. Each failure adds a problem line, and the state is
  `MISMATCH`. The wording must tell this case apart from a create-time mismatch, for example:
  `/workspaces/x/.git/config is no longer mounted in the running container (replaced on the
  host?) — recreate it with devc build`.
- `GitProtectState`'s shape is unchanged. Don't add a new state: `MISMATCH` already means
  "devc believes this is protected and the container disagrees", and the bridge's refusals key
  on `state !== 'protected'`.

**Concept boundary:** `mounts` stays the create-time table (`ContainerMount`, from
`docker inspect`). `live` is the kernel table (`LiveMount`). Don't merge the two types: the
create-time table carries host `source`s that the bridge reads the remote from (`configMount`
in `bridge.ts`), and the kernel table has no usable host path.

## Step 3: callers

- **`printGitProtection` (`devc/main.ts`):** call `getLiveMounts(target)` next to
  `getContainerMounts` and pass the result. When it is `null` but a container exists (a stopped
  one), print one line under `git protection:`:
  `(container not running: checked against its create-time mounts only)`.
  With Step 0's option (a), add `(as reported by the container)` to that heading line instead.
- **`devc/bridge.ts`, all three `gitProtectState` sites:** pass the live table. If the container
  is running and the live read fails, **refuse** with a reason that says so, rather than
  falling back. A grant is the one place a false "protected" costs a push to the wrong repo.
  A stopped container keeps today's behaviour; the next start recreates the mounts.

## Step 4: words

- `devc/help.ts`: the `MISMATCH` legend line covers the new case (protection lost in a running
  container, usually after the host rewrote `.git/config`).
- `devc/README.md` § "Git protection": "Check it with `devc status`, which reads the container's
  live mount table" becomes true. Add a short paragraph on the host-rewrite loss: what causes
  it (an editor or `git config` on the host), that `devc status` now reports it, and that
  `devc build` restores it.
- The doc comments on `printGitProtection` and `gitProtectState` that say "live mount table"
  for the `docker inspect` table are corrected.

## Tests

- `parseMountinfo`: an ordinary table, a `\040` (space) in a path, `ro` vs `rw` in the
  per-mount options (field 6, not the super options after `-`), and a malformed line.
- `gitProtectState` in `devc-core/tests/git_protect_test.ts`: with `live` omitted (existing
  tests unchanged); all three present and read-only (`protected`); `config` missing from
  `live` (`MISMATCH`, the new wording); `config` present but `rw`; an overmount where the last
  entry is `rw`.
- Bridge grant tests: a running container whose live table lacks `config` is refused, and a
  failed live read is refused.

## Validation (host)

1. A container with protection in force: `devc status` shows `protected` for each repo.
2. `git -C <host repo> config devc.probe 1`, then `devc status`: that repo shows `MISMATCH`
   with the new problem line, and `devc up --bridge-repo …` for it is refused.
3. `devc build`: `protected` again. `git -C <host repo> config --unset devc.probe` (which
   loses the mount again: say so in the report and rebuild once more).
4. `devc stop`, then `devc status`: the "container not running" line.

## Out of scope: surviving host rewrites

Detection doesn't stop the loss, and the host's own editor rewrites `.git/config` routinely,
so in practice protection degrades during a long-running container. Directions for a later
plan, none decided:

- **Re-check and warn while running:** `devc web` already polls each container; it could run
  the same live check and show a banner on the container's row.
- **Keep host tools from rewriting it:** can't be enforced, so it's guidance only.
- **Restore the mount in place** from the host, without recreating the container. Docker has
  no API for adding a mount to a running container, so probably not possible.
- **Freeze something that is never renamed:** for example, make `.git/config` a tiny file that
  only `include.path`s a host-owned file outside the repo. That changes what git and the host
  editor see, so it needs measuring.

Related: `devc web`'s git status (`devc/web/git_status.ts`) doesn't depend on any of this. It
never runs git inside a repo, for exactly this reason.
