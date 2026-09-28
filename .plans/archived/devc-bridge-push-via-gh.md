# devc-bridge-push-via-gh

`git-push` to a GitHub remote goes over HTTPS with `gh`'s credential, so one
host setup — `gh auth login` — covers `git-push`, `git-doctor` and every `pr-*`
command. No SSH key, agent or `~/.ssh` is involved for GitHub.

`gh api` cannot carry a push (the REST API has no pack upload), so the push is
still `git push`, with `gh auth git-credential` as git's **only** credential
helper.

## Decisions

1. **Which remotes.** The policy remote is classified with the `pr-*` prelude's
   `parse_remote` (copied verbatim): `git@<host>:<owner>/<name>[.git]`,
   `ssh://git@<host>/<owner>/<name>[.git]`, `https://<host>/<owner>/<name>[.git]`
   with host `github.com` or a `github.com-*` ssh alias. A match is a **GitHub
   remote** and always uses the gh transport — no SSH fallback. Anything else
   (local paths, other hosts) keeps today's transport unchanged.
2. **Transport URL.** For a GitHub remote every network git call (`ls-remote`,
   the default-branch `fetch`, `push`) gets the URL
   `https://github.com/<owner>/<name>.git` as an argument instead of the remote
   name `origin`. A `github.com-*` alias maps to `github.com`: the push goes out
   as gh's active github.com account, not the alias's SSH key — document it.
3. **The mirror is unchanged.** Its `remote.origin.url` stays the policy remote
   verbatim and the policy/mirror identity check is unchanged. The success and
   up-to-date lines still print the policy remote.
4. **Credential isolation.** Network git calls for a GitHub remote run with
   `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` (no user or system
   `insteadOf` can turn the URL back into SSH, no other credential helper can
   answer) and
   `-c credential.helper= -c "credential.helper=!'<gh>' auth git-credential"`,
   where `<gh>` is `command -v gh`. A `<gh>` containing `'` is exit 4
   `unusable gh path`. Gotcha: git runs a `!` helper through the shell, hence
   the quoting; the empty `credential.helper=` resets any helper list still in
   scope. Consequence to document: `http.proxy` from `~/.gitconfig` no longer
   applies to GitHub pushes; `HTTPS_PROXY` in the bridge's environment does.
5. **gh environment.** The prelude's gh lines are copied verbatim:
   `unset GH_REPO GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_DEBUG GH_PAGER GH_CONFIG_DIR_OVERRIDE`
   and `export GH_HOST=github.com GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 NO_COLOR=1`.
6. **gh readiness, before any network call (GitHub remote only), exit 4:**
   - no `gh` on PATH → `git-push: gh is not installed on the host (not on the bridge's PATH)`
   - `gh auth status --hostname github.com` fails (under the git timeout) →
     `git-push: gh is not authenticated in the bridge's environment — run gh auth login on the host, then devc-bridge restart`
7. **`git-doctor`.** Same classification and transport for its `ls-remote`
   probe. The `ssh agent:` section is **removed** (the probe is the verdict and
   quotes ssh's own error for a non-GitHub SSH remote). For a GitHub remote:
   - ok: `transport ok (git ls-remote reached https://github.com/<owner>/<name>.git via gh credentials)`
   - no gh (finding): `transport FAILED: gh is not installed on the host (not on the bridge's PATH)`
   - gh not logged in (finding): `transport FAILED: gh is not authenticated for github.com — run gh auth login on the host`
   - git failure (finding): the existing `transport FAILED: git ls-remote exited <rc>: <first line>`,
     followed by `GitHub remotes use gh's credentials over HTTPS: check gh auth status on the host`
     (in place of the BatchMode hint, which stays for non-GitHub SSH remotes).
     Non-GitHub output is unchanged.

## Checklist

- [x] `devc-bridge/builtin/git-push`: classify, gh env, readiness check, GitHub transport for `ls-remote` / `fetch` / `push`; header comment
- [x] `devc-bridge/builtin/git-doctor`: same classification/transport in the probe; drop the `ssh agent:` section; header comment
- [x] `devc-bridge/tests/git_push_test.sh`: GitHub-transport cases with `git` and `gh` shims
- [x] Docs: `docs/bridge-git-push.md` (setup is `gh auth login`; exit 4 includes gh not set up), `devc-bridge/README.md` (Publishing a branch: credentials, "What it does", SSH limit bullet → GitHub/gh bullet, `git-doctor` section, `git-doctor` command-table row)

## Validation

- [x] `bash devc-bridge/tests/git_push_test.sh` → `0 failed`, including, with a
      `git` shim that rewrites the argument `https://github.com/acme/widget.git`
      to the local bare remote and logs every call's args and
      `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM`, a `gh` shim whose `auth` exits
      `$SHIM_AUTH_RC`, and policy remote `git@github.com:acme/widget.git`:
  - push → exit 0, `pushed: feat at <sha12> to git@github.com:acme/widget.git (…)`, and the remote's `refs/heads/feat` equals the repo's
  - the logged `ls-remote`, `fetch … <url>` and `push` calls all carry `https://github.com/acme/widget.git`, `credential.helper=`, `credential.helper=!'<shim gh>' auth git-credential`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`; none carries `git@github.com:`
  - a second push → exit 0 `up to date: …`
  - `SHIM_AUTH_RC=1` → exit 4, `gh is not authenticated`; nothing pushed
  - no `gh` on PATH → exit 4, `gh is not installed` (skipped when a real gh is on `/usr/bin:/bin`)
  - `git-doctor` → exit 0 with `via gh credentials`; with `SHIM_AUTH_RC=1` → exit 1 with `transport FAILED: gh is not authenticated for github.com`; output has no `ssh agent:`
  - the existing non-GitHub `ssh://git.example.invalid` cases still pass unchanged
- [x] `bash devc-bridge/tests/pr_review_test.sh` → `0 failed`
- [x] Live, after the host runs the new build: from the private-repo-spike
      container (policy remote `git@github.com:bmingles/private-repo-spike.git`,
      empty ssh agent), `devc-bridge git-doctor` shows `via gh credentials` and
      `devc-bridge git-push` of a new commit prints `pushed:`

## Relevant Files

- `devc-bridge/builtin/git-push`
- `devc-bridge/builtin/git-doctor`
- `devc-bridge/tests/git_push_test.sh`
- `docs/bridge-git-push.md`
- `devc-bridge/README.md`
- `.plans/PLAN.md`
