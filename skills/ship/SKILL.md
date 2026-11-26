---
name: ship
description: Hand a planned change to ship, which implements it, runs the checks, reviews, fixes and opens the PR unattended, or have ship review a pull request. Use when the user wants to ship planned work (`ship run`), review a PR with ship (`ship review`), fix or recheck the findings on a PR (`ship fix`, `ship recheck`), or run one part of the loop on its own (`ship implement`, `ship checks`, `ship pr`, `ship post`).
---

# ship

ship runs the whole loop in its daemon: baseline checks → implement → checks → review → fix → PR. Your job is to start the run, wait for it, and report. Write no code yourself in this session.

1. **Prepare.**
    - **Plan dir**: the dir the `plan-out` skill wrote, holding `spec.md` and `implementation-plan.md`. The implementer sees only these files and the repo, so both must be self-contained. Use the dir the user points to, or the one `plan-out` wrote in this session. When there is none, run `plan-out` with the user first. ship excludes the dir from git when it sits inside the repo; it never commits plan files.
    - **Branch**: on the default branch, ship pushes straight to it and opens no PR. Unless the user asked to work on the default branch, create a feature branch from it with a name describing the change.
    - **Clean tree**: commit or stash nothing on the user's behalf. When `git status` shows changes outside the plan dir, ask the user how to proceed.
    - **Config**: when the run fails with an unknown project config, run the `ship-init` skill, then start over.

2. **Run.** From the repo root, start `ship run <plan-dir>` in the background and wait for it to exit. stderr streams the run's events; stdout is the summary JSON. A run takes minutes to an hour. Ctrl-C only detaches; `ship cancel <id>` stops a run.
    - **Hand the user the logs command**: as soon as stderr prints `ship: run <id> started`, send the user the follow command with the real id, alone in a one-line shell code block, so they can run it in their own terminal (some clients add a run button to such blocks):

        ```sh
        ship logs <id> --follow
        ```

3. **Report** from the summary and the exit code:
    - **0, done**: the PR URL, the cost, and the tradeoffs listed in the PR body, one line each.
    - **2, escalated**: a draft PR is up. Give the `escalationReason` and every unresolved must-fix finding and nit, then offer to fix them (`ship resume` does not apply; the run is over).
    - **1, failed**: a precondition message, or the run's `error`. A run that started and then failed or was interrupted can continue with `ship resume <id>`: it runs the failed or interrupted step again, skipping the work that step already finished. Offer it once the cause is dealt with. Agent calls that fail transiently (an API overload, a false-positive safeguard flag) are already retried twice before a run fails.
    - **130, detached**: give the run id and `ship logs <id> --follow` / `ship status <id>`.

## Reviewing a pull request

`ship review <pr> [--post]` runs one round of ship's reviewers and verifier over a PR, in the checkout you call it from. ship never creates a worktree or checks anything out itself.

1. **Check the PR out** in your worktree first: `gh pr checkout <n>`. ship refuses to start unless the tree is clean and `HEAD` is the PR's head commit (`dirty-tree` or `pr-not-checked-out`); fix that and start again rather than working around it. Do not move `HEAD` until the run ends: with `--post`, ship refuses to post once `HEAD` has moved.
2. **Run** `ship review <pr>` from the repo root, adding `--post` only when the user asked for the findings on GitHub. Wait for it like `ship run`.
3. **Report**: exit 0 means no verified must-fix, 2 means at least one; give the findings by severity, the `reviewUrl` when posted, and the `reviewId` the review is stored under. Exit 1 and 130 read as for `ship run`.

## Fixing and rechecking a PR's findings

`ship fix <source>` has ship's fix agent address the findings on a PR, run the checks, commit and push to the PR's branch. `ship recheck <source>` asks the verifier which findings are fixed and resolves their threads on GitHub. `<source>` is a PR number or URL (its open review threads, skipping those by authors who may not push to the repository and are not bots listed in the project config's `trustedBots`, which the summary lists under `ignoredThreads`; a trusted bot's comments in its latest review's body count too, and have no thread to resolve) or a `reviewId` from a `ship review` summary (that review's must-fix findings and nits).

1. **Check the PR out** first, as for a review: `gh pr checkout <n>`, with a clean tree. ship refuses with `dirty-tree` or `pr-not-checked-out` otherwise; fix that and start again. `ship fix` also refuses with `pr-not-pushable` when it cannot push to the PR's branch (a fork without maintainer edits): offer `--local`, which keeps the commits in the checkout.
2. **Run** from the repo root. Pass `--local` when the user does not want anything pushed or resolved on GitHub, and `ship fix --no-checks` only when the user asked to skip the checks. Wait for it like `ship run`.
3. **Report**:
    - `ship fix`: 0 means done; give the commits and whether they were pushed. 1 reads as for `ship run`; failing checks leave the commits local. Offer `ship recheck` afterwards.
    - `ship recheck`: 0 means every finding is fixed, 2 means some are not; list the unfixed ones with the verifier's evidence and the threads resolved. 1 and 130 read as for `ship run`.

## Running one part of the loop

When the user wants only one part of `ship run`, use the matching command from the repo root. Each needs a branch and a clean tree, streams like `ship run`, and exits 0 done, 1 failed, 130 detached; hand the user the logs command the same way.

- `ship implement <plan-dir> [--no-checks]`: implement a plan and commit it, with the baseline and the checks unless `--no-checks`. No review, no PR. Report the commit.
- `ship checks`: run the checks on the branch's changes, fix failing ones and commit the fixes. Report the commit, or the checks that still fail.
- `ship pr [--plan <dir>]`: push the branch and open or update its PR. It never squashes. Report the PR URL.
- `ship post <review-id>`: post a stored review on its PR; needs `HEAD` at the reviewed head (`gh pr checkout <n>`). Report the review URL.
