# devc git push: a user's push from the host, through the mirror

Decided with the user on 2026-10-28. Fourth of six plans (see "Git and the trusted host area" in
`PLAN.md`). `devc-desktop-host-actions` is its first caller; it is also usable from any host
terminal.

## Checklist

- [ ] **Confirm D1 and D2 with the user before starting** (defaults chosen while writing).
- [ ] `gh-push`: a plan mode and a user mode, reachable only from devc's CLI (D3).
- [ ] `devc-bridge/host/core.ts`: never pass `DEVC_PUSH_MODE` to a recipe.
- [ ] `devc git push-plan` and `devc git push` (contracts below).
- [ ] Tests, `devc/README.md`, `devc-bridge/README.md` (the mode is not reachable through the bridge).

## Goal

`gh-push` lets an **agent** publish, under policy. The user needs to push what that policy
refuses (the default branch, workflow changes) or what was never granted, after seeing exactly
what goes out. `devc git` reuses `gh-push`'s mirror, so the **host never runs git in the repo**
here either.

## Decisions

- **D1 (default, confirm):** user mode skips two refusals, the default branch and changes under
  `.github/workflows` / `.github/actions`. The plan reports both so the confirming UI can warn.
  It still refuses a non-fast-forward push (never forces) and an LFS pointer (it can't be
  published from the mirror).
- **D2 (default, confirm):** GitHub only, with `gh`'s credential, as `gh-push`. No SSH remotes.
- **D3:** the modes are selected by the environment variable `DEVC_PUSH_MODE` (`plan` | `user`),
  which only `devc git` sets. `devc-bridge`'s server deletes it from every builtin's environment,
  so an agent's `devc-bridge gh-push` can never select it. Its arguments stay as they are.
- **D4:** the push is of the SHA the user saw. `devc git push` takes `--sha` and refuses if the
  branch tip, freshly fetched from the folder into the mirror, is no longer that SHA.

## Contracts

```
devc git push-plan <folder>          # JSON on stdout, exit 0 even when ok is false
devc git push <folder> --sha <sha>   # gh-push's exit codes and its pushed:/up to date: line
```

`<folder>` is the repo folder on the host (a worktree is fine). Its branch and upstream come from
`git_repo.ts`'s data reads (`readBranch`, `readUpstream`), not from git run in the repo.
`devc git` writes a one-line policy for it as `pr_host.ts` does (D10 of
`devc-web-host-environments`), with grant `gh-push`, under `~/.cache/devc/push-policy/`.

`push-plan` output:

```ts
type PushPlan =
  | {
    ok: true;
    folder: string; // as given, realpath'd
    remote: string; // the URL
    branch: string;
    sha: string; // the branch tip in the mirror, full
    remoteSha: string | null; // the remote branch's tip, null when it doesn't exist yet
    commits: { sha: string; subject: string; author: string }[]; // newest first, at most 50
    totalCommits: number;
    defaultBranch: boolean; // D1: allowed, warn
    guarded: string[]; // D1: changed paths under .github/workflows|actions, allowed, warn
    lfs: boolean; // refused at push time
    fastForward: boolean; // false: refused at push time
    upToDate: boolean;
  }
  | { ok: false; problem: string };
```

Text in `subject`, `author` and `guarded` is the repo's (agent-written). Consumers show it as text
only.

## Concept boundaries

- `gh-push` (agent, bridge, policy, no `--sha`) vs `devc git push` (user, CLI, D1's waivers, `--sha`).
  One recipe, two callers; the refusals that differ are gated on `DEVC_PUSH_MODE=user` only.
- `push-policy/` (this) vs `web-pr-policy/` (the page's PR review on host projects) vs the
  bridge's own policy dir. Three dirs, so none overwrites another's line.

## Validation

- `devc-bridge` tests: with `DEVC_PUSH_MODE=user` set in the daemon's own environment, a builtin
  run through the bridge does not see it (env dump recipe).
- `gh-push` tests (the existing harness with a local bare "GitHub" remote and stub `gh`):
  - plan mode prints JSON matching the type for a new branch, an existing branch two commits
    ahead, the default branch (`defaultBranch: true`), a workflow change (`guarded` lists it),
    and a diverged branch (`fastForward: false`);
  - user mode pushes the default branch and a workflow change; refuses `--sha` when the branch
    moved after the plan (exit 2 with `the branch moved`); refuses a non-fast-forward (exit 4) and
    an LFS pointer (exit 3);
  - a repo with a `pre-push` hook and `core.fsmonitor` set to marker-writing scripts: no marker
    after plan or push.
- `cd devc && deno task check && deno task test` pass.

## Relevant files

`devc-bridge/builtin/gh-push`, `devc-bridge/host/core.ts` (builtin env, around line 460),
`devc-bridge/tests/`, `devc/main.ts` and `devc/args.ts` (the `git` command), `devc/help.ts`,
`devc/web/pr_host.ts` (policy-writing pattern), `devc/web/git_repo.ts`, `devc/README.md`,
`devc-bridge/README.md` (§ Publishing a branch).
