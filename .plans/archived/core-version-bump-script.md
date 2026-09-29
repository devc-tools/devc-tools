# core-version-bump-script

`@devc-tools/core`'s version lives in four files: `devc-core/package.json`,
`devc-core/package-lock.json`, and the `workspace.links` entry
(`"npm:@devc-tools/core@<version>"`) of **`devc/deno.lock` and
`devc-bridge/host/deno.lock`** — Deno records `../devc-core/` as a linked npm
package because it has a `package.json`. Bumping core with `npm version` alone
left both locks stale three times (`4541bea`, `e84bae1`, `c4c6a6d`), each
found only when a later local build rewrote them. `devc-core/deno.lock` does not
record core itself and is not touched.

New `scripts/bump-core-version.sh` does the whole bump up to (not including)
commit/push/preflight/publish; `preflight-core-publish.sh` gains a guard so a
stale lock can never reach a publish again.

## Decisions

### `scripts/bump-core-version.sh <new-version>`

Style and structure follow `scripts/bump-version.sh` (header comment as the
help, `set -uo pipefail`, `cd "$(dirname "$0")/.."`, POSIX BRE `read_json`,
BSD-sed safe). Runs on the host or in the devcontainer: nothing it runs touches
`node_modules` (no npm lifecycle scripts, no Deno `nodeModulesDir`). Steps, each
a hard stop (exit 1) on failure unless noted:

1. Usage: no argument → `usage: bash scripts/bump-core-version.sh <new-version>`
   on stderr, exit 2. Same loose `X.Y.Z[-suffix]` check as `bump-version.sh`
   (exit 2).
2. Read the current version from `devc-core/package.json`; equal to the new one
   → `devc-core/package.json is already <v> — nothing to do.`, exit 1.
3. Registry: if `npm view @devc-tools/core versions --json` succeeds and lists
   the new version → `error: @devc-tools/core@<v> is already published — npm versions cannot be reused`,
   exit 1. Unreachable registry → print
   `warning: could not reach the npm registry — check <v> is unpublished before publishing`
   and continue.
4. `(cd devc-core && npm version <v> --no-git-tag-version)` — moves
   `package.json` and `package-lock.json` together.
5. Refresh the two consumer locks:
   `(cd <dir> && deno install --frozen=false --entrypoint main.ts)` for
   `devc` and `devc-bridge/host`. **Not** bare `deno install` (adds unrelated
   entries to `devc-bridge/host/deno.lock`) and not `deno cache` (deprecated);
   the `--entrypoint` form changes exactly the `links` line.
6. Verify: `(cd <dir> && deno check --frozen main.ts)` passes for both, and each
   lock contains `"npm:@devc-tools/core@<v>"`. Failure →
   `error: <dir>/deno.lock still does not match @devc-tools/core@<v>`, exit 1.
7. Report `git diff --stat` of the four files, then print:

   ```text
   Next:
     1. Review the diff, commit, and push.
     2. On the host: bash scripts/preflight-core-publish.sh
     3. Publish (it prints this too): cd devc-core && npm publish --access public
   ```

It never commits, tags, pushes or publishes. `-h`/`--help` prints the header
comment (the `awk` idiom from `preflight-core-publish.sh`).

### Guard in `preflight-core-publish.sh`

In the `repository guards` section, one `check` per consumer:
`check 'devc/deno.lock matches devc-core (deno check --frozen)' ...` and the same
for `devc-bridge/host`, running `(cd <dir> && deno check --frozen main.ts)`.

### Pointers

- `bump-version.sh`'s "To move it too" hint and `preflight-core-publish.sh`'s
  "Bump it first" message point at `bash scripts/bump-core-version.sh <x.y.z>`
  instead of the raw `npm version` command.
- `README.md` Releasing: the `@devc-tools/core` paragraph names
  `bump-core-version.sh` as the way to move core's version and says why (the
  consumer locks).

## Checklist

- [x] `scripts/bump-core-version.sh` (executable)
- [x] `scripts/preflight-core-publish.sh`: lock guards; "Bump it first" hint
- [x] `scripts/bump-version.sh`: "To move it too" hint
- [x] `README.md` Releasing paragraph

## Validation

Run in a throwaway `git worktree` so the real tree is untouched:

- [x] `bash scripts/bump-core-version.sh` → exit 2, usage on stderr
- [x] `bash scripts/bump-core-version.sh 1.2` → exit 2
- [x] `bash scripts/bump-core-version.sh 0.4.0` (current) → exit 1, `already 0.4.0`
- [x] `bash scripts/bump-core-version.sh 0.3.0` (published) → exit 1, `already published` (when the registry is reachable)
- [x] `bash scripts/bump-core-version.sh 0.4.1` → exit 0; `git diff --stat` shows exactly `devc-core/package.json`, `devc-core/package-lock.json`, `devc/deno.lock`, `devc-bridge/host/deno.lock`; both locks contain `npm:@devc-tools/core@0.4.1`, each lock diff is 1 line; `deno check --frozen main.ts` passes in `devc` and `devc-bridge/host`; output ends with the three `Next:` steps
- [x] On an unbumped tree with a lock hand-edited to `core@0.3.0`, `(cd devc && deno check --frozen main.ts)` fails — the preflight guard's condition (the full preflight needs the host)
- [x] `bash -n` on the three scripts

## Relevant Files

- `scripts/bump-core-version.sh` (new)
- `scripts/preflight-core-publish.sh`
- `scripts/bump-version.sh`
- `README.md`
- `.plans/PLAN.md`
