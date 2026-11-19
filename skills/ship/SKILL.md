---
name: ship
description: Hand a planned change to ship, which implements it, runs the checks, reviews, fixes and opens the PR unattended. Use when the user wants to ship planned work (`ship run`).
---

# ship

ship runs the whole loop in its daemon: baseline checks → implement → checks → review → fix → PR. Your job is to start the run, wait for it, and report. Write no code yourself in this session.

1. **Prepare.**
    - **Plan dir**: the dir the `plan-out` skill wrote, holding `spec.md` and `implementation-plan.md`. The implementer sees only these files and the repo, so both must be self-contained. Use the dir the user points to, or the one `plan-out` wrote in this session. When there is none, run `plan-out` with the user first. ship excludes the dir from git when it sits inside the repo; it never commits plan files.
    - **Branch**: ship refuses the default branch. Create a feature branch from the default branch with a name describing the change.
    - **Clean tree**: commit or stash nothing on the user's behalf. When `git status` shows changes outside the plan dir, ask the user how to proceed.
    - **Config**: when the run fails with an unknown project config, run the `ship-init` skill, then start over.

2. **Run.** From the repo root, start `ship run <plan-dir>` in the background and wait for it to exit. stderr streams the run's events; stdout is the summary JSON. A run takes minutes to an hour. Ctrl-C only detaches; `ship cancel <id>` stops a run.

3. **Report** from the summary and the exit code:
    - **0, done**: the PR URL, the cost, and the tradeoffs listed in the PR body, one line each.
    - **2, escalated**: a draft PR is up. Give the `escalationReason` and every unresolved must-fix finding and nit, then offer to fix them (`ship resume` does not apply; the run is over).
    - **1, failed**: a precondition message, a failing baseline (show the failing checks' `outputTail`: ship spent no tokens), or the run's `error`. A failed baseline means the branch is red before any change; offer to fix it first. An interrupted run (the daemon stopped) prints a resume hint: offer `ship resume <id>`.
    - **130, detached**: give the run id and `ship logs <id> --follow` / `ship status <id>`.
