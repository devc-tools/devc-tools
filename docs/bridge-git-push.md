# Pushing from inside a devcontainer (`devc-bridge git-push`)

For agents running inside a container. The container has no git credentials of
its own, so `git push` fails. Instead, ask the host to publish your branch over
the bridge. The host does the push with its own credentials.

Full design: [devc-bridge README § Publishing a branch](../devc-bridge/README.md#publishing-a-branch-git-push).

## Commands

```sh
devc-bridge git-push      # publish the pinned branch. No arguments, ever.
devc-bridge git-doctor    # read-only: shows your pin and why a push would fail
```

Passing any argument to `git-push` is an error (exit 2). You cannot choose a
branch, remote, or ref.

## What gets pushed

- **One repo:** the primary workspace repo. Sibling `devc:source` mounts are
  never pushable.
- **One branch:** the branch that was checked out when the host last ran
  `devc up --bridge-git-push`, `attach`, `claude`, and so on. Switching
  branches inside the container does **not** move the pin until the host runs
  one of those commands again. To see the pin, run `git-doctor` and read the
  `policy <branch> → <remote>` line.
- **Committed tip only:** the host fetches `refs/heads/<branch>` from your repo.
  Uncommitted and unstaged changes are not sent. Commit first.
- **Fast-forward only:** no force, no delete, no tags. If the remote branch has
  moved or you rebased onto something it doesn't have, the push is rejected
  (exit 4).
- **Your local remote-tracking refs are not updated.** `origin/<branch>` in the
  container stays stale, and `git fetch` from inside still has no credentials.
  Treat the success line as the confirmation.

## Output

On stdout, exit 0:

```text
pushed: <branch> at <sha12> to <remote> (<host repo path>)
up to date: <branch> is already <sha12> on <remote> (<host repo path>)
```

Refusals and failures go to stderr, prefixed with `git-push:`.

## Exit codes

| Exit | Meaning                                                                                                                                                                                                                        | What to do                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | Pushed, or already up to date                                                                                                                                                                                                  | Done                                                                                                                                       |
| `1`  | Client-level error, before the verb ran. The stderr says which: `unknown command: git-push` means the recipe isn't installed on the host; a connection error means the bridge isn't running                                    | Stop and tell the user. You can't fix this from inside                                                                                     |
| `2`  | No policy (container not started with `--bridge-git-push`), malformed policy, an argument was passed, the pin no longer resolves (branch missing, detached HEAD, bad worktree pointer), or the remote doesn't match the mirror | Run `git-doctor`, then report it to the user. Don't retry                                                                                  |
| `3`  | Content policy refused the push: the branch changes `.github/workflows/` compared with the default branch, it adds a Git LFS pointer, or the remote has no default branch                                                      | Remove the offending change, or rebase if the default branch's workflows moved and you're just behind. Otherwise hand the push to the user |
| `4`  | Transport failure, timeout (default 300s), or a non-fast-forward rejection                                                                                                                                                     | If you rewrote history, the push won't go through. Report it. Retry only for a transient network error                                     |

## Rules for agents

- Commit on the pinned branch, then run `devc-bridge git-push`. There is
  nothing else to it.
- Don't try `git push`, `gh`, or SSH directly. There are no credentials.
- Don't edit `.github/workflows/` on a branch you intend to push this way.
- Don't loop on exit 2 or exit 3. Those are policy decisions, not transient
  failures.
- If `git-doctor` isn't installed (exit 1, `unknown command`), the pin is
  whatever branch was checked out when the container was last started or
  attached.
