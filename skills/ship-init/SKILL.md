---
name: ship-init
description: Set up ship for the current project: detect its checks, agree the config with the user, save it and run the checks once. Use when the user wants to set up, configure or onboard ship (`ship init`) in a repo.
---

# ship-init

Run from the project directory. The config is personal: it lives in ship's home (`~/.ship/projects/`), never in the repo.

1. **Detect.** Run `ship init --detect`. stdout is the draft config (JSON); stderr has the project key, where the config will be saved, and `note:` lines. Read every note: each is a choice detection made or a hint (CI commands, an aggregate `check` script left out, a guessed `db` lock).

2. **Review with the user.** Show the draft as a short table (name, run, fix, lock) plus `format`, then settle each point below. Ask about anything the notes flag or you cannot tell from the repo; read `package.json`, the `Makefile` or CI files to answer what you can yourself.
    - **Checks**: right commands, nothing missing (CI hints), nothing slow or flaky that belongs outside the loop, e.g. e2e suites.
    - **Fix commands**: `fix` runs just before its check on every pass after the baseline, so only offer commands that rewrite files safely (formatter write, `lint --fix`).
    - **Locks**: checks that share a resource (a database, a port, a heavy CPU suite) across parallel runs get a lock other than `cpu`. Any lock other than `cpu` needs permits in `~/.ship/config.json`, e.g. `"locks": { "db": 1 }`; add them with the user's consent before writing, then run `ship daemon restart` (it reads permits at start).
    - **Format**: runs after every agent step, before checks. A command taking `{files}` (the changed files) is faster than formatting the whole tree.

    The review is done when the user has confirmed the full config.

3. **Write.** Save the agreed JSON to a temp file outside the repo and run `ship init --write <file>`. It validates the config, saves it and runs every check once. A validation error lists each problem; fix the file and rerun. When a config already exists, ask the user before rerunning with `--force`.

4. **Report.** Give the user each check's result from stdout. Exit code 1 means a check failed: the config stays saved, and `ship run` goes on past a failing baseline but no longer holds the change to the checks that failed there, so show the failing output and offer to fix the cause or adjust the check.
