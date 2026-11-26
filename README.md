# ship

Runs the scripted part of a coding-agent workflow: implement → checks → review → fix → pull request.
Planning stays an interactive conversation; `ship run <plan-dir>` takes it from there and stops when a PR is up.

Status: early development. It is not on npm yet.

## Install

ship needs Node 26.13 or later, git, and `gh` signed in for opening PRs. It is not on npm yet; install it from a checkout:

```sh
pnpm install
pnpm build
cd packages/cli && pnpm pack && npm i -g ./f-elix-ship-*.tgz
```

`npm rm -g @f-elix/ship` uninstalls it.

### Agent skills

`skills/` holds four skills: `plan-out` designs a change with you and writes the plan dir (`spec.md` and `implementation-plan.md`), `ship` hands that plan to `ship run` and reports the result, `ship-init` sets up a project, and `ship-conventions` loads ship's design conventions to discuss code without planning a change. Link them into your agent's skills folder so they follow the checkout:

```sh
ln -s "$PWD/skills/plan-out" "$PWD/skills/ship" "$PWD/skills/ship-init" "$PWD/skills/ship-conventions" ~/.agents/skills/
```

## Set up a project

Each project needs a config at `~/.ship/projects/<host>/<owner>/<repo>.json`: its checks, format command, reviewers and PR options (see `packages/cli/schemas/project.schema.json`). The key is the normalized `origin` URL, or the repo path when there is no `origin`. Machine-wide settings, such as lock permits, go in `~/.ship/config.json` (`packages/cli/schemas/config.schema.json`).

`ship init` writes the project config in two steps, so an agent can review the draft with you in between. The `ship-init` skill in `skills/ship-init/` drives it.

```sh
ship init --detect > /tmp/ship-draft.json   # draft on stdout; project key and notes on stderr
ship init --write /tmp/ship-draft.json      # validate, save, run every check once
```

`--detect` reads `package.json` scripts (with the package manager from `packageManager` or the lockfile), `Makefile` and `justfile` targets and `Cargo.toml`, and lists `.github/workflows` commands as hints. It drafts at most one check each for format, lint, typecheck and test: when several sources offer one, a `justfile` wins over a `Makefile`, then `package.json`, then `Cargo.toml`. An aggregate `check` script is used only when there is no granular one. Checks lock `cpu`; `test` locks `db` when a database package, crate or compose image suggests tests share one.

`--write` reports every validation error, refuses a lock resource that `~/.ship/config.json` gives no permits, and refuses to replace an existing config unless `--force`. It saves the config with `$schema` set, then runs every check once through the daemon, so the checks share lock permits with active runs. Like a run's baseline, it skips fix commands and checks that use `{files}`. Keep the draft outside the repo: an untracked file there is part of what the checks see, and makes the tree dirty for `ship run`. Each check's result and the end of a failing check's output go to stdout, and it exits 1 when a check fails. The config stays saved, so you know about baseline failures before the first run.

## Usage

Run from a branch with a clean working tree, with a plan dir holding `spec.md` and `implementation-plan.md`:

```sh
ship run .plans/my-feature
```

The run starts with a baseline: every check once, before any change. A check that fails there does not stop the run, but the change is not held to it: its failures later neither fail a pass nor go to the check-fix agent, and the PR body lists it under "Checks failing before this change".

Events stream to stderr as one line each: state changes, check results, lock waits, findings counts, cost, the PR URL. When the run ends, its summary JSON is printed on stdout and nothing else is, so `ship run <dir> > summary.json` keeps it. The exit code says how the run ended:

| Code | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| 0    | done: the PR is up, or the default branch is pushed      |
| 2    | escalated: a draft PR lists the unresolved findings      |
| 1    | failed, cancelled, interrupted, or the run did not start |
| 130  | Ctrl-C (or SIGTERM): a started run keeps going           |

Ctrl-C detaches instead of cancelling, and prints how to follow, check or cancel the run.

| Command                                     | What it does                                                                                                                                                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ship run <plan-dir>`                       | Start a run in the current directory with the current env                                                                                                                                                                           |
| `ship review <pr> [--post]`                 | Review a pull request of the current repository; see [Reviewing a PR](#reviewing-a-pr)                                                                                                                                              |
| `ship fix <source> [--local] [--no-checks]` | Fix the findings of a PR's review threads or of a stored review, then push; see [Fixing and rechecking findings](#fixing-and-rechecking-findings)                                                                                   |
| `ship recheck <source> [--local]`           | Check which findings of a PR are fixed and resolve their threads; see [Fixing and rechecking findings](#fixing-and-rechecking-findings)                                                                                             |
| `ship implement <plan-dir> [--no-checks]`   | Implement a plan and commit it, without review or PR; see [Running one part of the loop](#running-one-part-of-the-loop)                                                                                                             |
| `ship checks`                               | Run the checks on the branch, fix failing ones and commit the fixes; see [Running one part of the loop](#running-one-part-of-the-loop)                                                                                              |
| `ship pr [--plan <dir>]`                    | Push the branch and open or update its PR; see [Running one part of the loop](#running-one-part-of-the-loop)                                                                                                                        |
| `ship post <review-id>`                     | Post a stored review on its PR; see [Running one part of the loop](#running-one-part-of-the-loop)                                                                                                                                   |
| `ship resume <id>`                          | Continue an interrupted run, or retry a failed one from the step that failed, with the current env; streams and exits like the command that started it                                                                              |
| `ship cancel <id>`                          | Stop a run; it ends as `cancelled`                                                                                                                                                                                                  |
| `ship status [id] [--json]`                 | A run's details and summary, or the active runs                                                                                                                                                                                     |
| `ship list [--limit n] [--json]`            | Recent runs, most recently updated first (20 by default)                                                                                                                                                                            |
| `ship logs <id> [--follow] [--json]`        | A run's event log; `--follow` keeps printing until the run ends                                                                                                                                                                     |
| `ship ui [--port n] [--no-open]`            | Serve a local inbox of your runs in the browser on 127.0.0.1 (port 4477 by default), at a URL with a one-time token only the browser it opens can use: what needs a decision, what is ready, what is in progress; runs until Ctrl-C |
| `ship daemon status`                        | The daemon's version, pid, socket, log and active runs; starts it if it is not running                                                                                                                                              |
| `ship daemon stop [--force]`                | Stop the daemon                                                                                                                                                                                                                     |
| `ship daemon restart [--force]`             | Restart it, e.g. after upgrading ship or editing lock permits                                                                                                                                                                       |
| `ship init --detect`                        | Print a draft project config for the current directory                                                                                                                                                                              |
| `ship init --write <file> [--force]`        | Validate and save the project config, then run every check once                                                                                                                                                                     |
| `ship auth cloudflare`                      | Save the Cloudflare credentials [Clef decisions](#clef-decisions) use, after checking them                                                                                                                                          |

Runs are hosted by a background daemon, which the commands that need it start when it is not running (`ship daemon stop` does not); its output goes to `daemon.log` in ship's home. The CLI and the daemon must be the same version: after an upgrade, commands ask for `ship daemon restart`. Stopping or restarting the daemon is refused while runs are active; `--force` interrupts them, and `ship resume <id>` continues them later.

The implementing agent runs unattended with every permission (`bypassPermissions`) in the project directory. Reviewers can only read.

### Reviewing a PR

`ship review <pr>` runs one review round of ship's reviewers and verifier over a pull request someone else opened, in the checkout you run it from. It changes nothing on GitHub unless you pass `--post`. `<pr>` is its number or its GitHub URL. ship never creates or removes worktrees: check the PR out first, with `gh pr checkout <n>`, in a clone of the PR's base repository. ship refuses to start unless the tree is clean and `HEAD` is the PR's head commit, and pins that commit when the run starts. It fetches the PR's base branch from `origin`, and the reviewers check the diff from the merge base to the head against the PR's title and description, with the project config when there is one and the defaults otherwise.

The review is stored in ship's database under a review id, which the summary gives as `reviewId`; it outlives the run. A resumed review re-runs only the reviewers that had not reported, and a resumed post finds the review it already posted on the PR instead of posting a second one.

With `--post`, the verified findings are posted as one GitHub review on that head, unless `HEAD` has moved since the run started, which fails the run: a finding on a line of the diff becomes an inline comment, the others are listed in the review's body as `file:line`. The review requests changes when there are must-fix findings and only comments otherwise; ship never approves, and posts nothing when there are no findings.

Events and the summary JSON go to stderr and stdout like `ship run`; the summary has `"kind": "review"` and the findings by severity. It exits 0 when there are no must-fix findings, 2 when there are, 1 when the review failed, was cancelled or did not start, and 130 on Ctrl-C.

### Fixing and rechecking findings

`ship fix <source>` and `ship recheck <source>` work on findings left on a pull request, in the checkout you run them from, with the same rules as `ship review`: check the PR out first with `gh pr checkout <n>`, and ship refuses to start unless the tree is clean and `HEAD` is the PR's head commit. `<source>` is one of:

- a PR number or URL: the PR's open, unresolved review threads. A thread ship posted carries a hidden marker, `<!-- ship-finding: <reviewId>/<findingId> -->`, and becomes that finding again (its stored copy when this machine has the review, its severity otherwise; tradeoffs are left out). Any other thread is a finding by its author: a must-fix, or what Clef rates it (see [Clef decisions](#clef-decisions)). Only threads opened by someone who may push to the repository count, or by a bot account the project config lists in `trustedBots` (e.g. `["coderabbitai"]`); the summary lists the others under `ignoredThreads`. A [CodeRabbit](https://coderabbit.ai) comment's finding is its title and explanation: its own severity, markers and "Prompt to fix issue" are left out, and Clef rates it like any other thread. CodeRabbit lists its nitpicks and the comments outside the diff in its review's body, not as threads: those of each trusted bot's latest review with a body are findings too, with the id `cr-<hash>` from CodeRabbit's marker. They have no thread, so `ship recheck` reports them but resolves nothing; the next CodeRabbit review replaces them.
- a review id, the `reviewId` of a `ship review` summary: that review's must-fix findings and nits, with the threads it posted when it was posted.

`ship fix` gives the must-fix findings and nits to the fix agent, runs the checks (fixing failing ones like `ship run`) and commits; with `--no-checks` it commits the work without running them. It then pushes `HEAD` to the PR's branch, to `origin` for a branch of the same repository and to the fork when the PR allows maintainer edits; ship refuses to start when it cannot push, unless you pass `--local`, which keeps the commits in the checkout. It never pushes a `HEAD` that does not descend from the head it started from. It needs the project config. The summary has `"kind": "fix"`, the commits and whether they were pushed; it exits 0 when done and 1 when the run failed, was cancelled or did not start.

`ship recheck` asks the verifier, over the diff from the merge base to the head, whether each finding is fixed, and resolves the threads of the fixed ones on GitHub unless you pass `--local`; it fails, resolving nothing, when `HEAD` has moved since the run started. It uses the project config when there is one and the defaults otherwise. The summary has `"kind": "recheck"`, each finding with its status and evidence, and the resolved threads; it exits 0 when every finding is fixed, 2 when some are not, and 1 when the run failed, was cancelled or did not start. Both exit 130 on Ctrl-C, and `ship resume` continues either without redoing a push or a resolved thread.

### Running one part of the loop

Four commands each run one part of `ship run` on its own, in the checkout you run them from. Like `ship run`, they stream events to stderr, print the summary JSON (`"kind"` is the command) on stdout, and exit 0 when done, 1 when the run failed, was cancelled or did not start, and 130 on Ctrl-C. `ship resume` continues any of them.

- `ship implement <plan-dir>` runs the baseline, the implementer, then the checks, fixing failing ones, and commits with the implementer's subject. It needs what `ship run` needs: a branch, a clean tree outside the plan dir, the plan files and the project config. With `--no-checks` it skips the baseline and the checks and commits the implementer's work as it is. It opens no PR and requests no review.
- `ship checks` runs every check on the files the branch changed since it left its base branch (its upstream when that is another branch, else the default branch), has the check-fix agent fix failing ones, and commits the fixes as one commit, `Fix failing checks`. There is no baseline: every failing check is the branch's to fix. Failing checks after the last fix attempt fail the run and leave the fixes uncommitted. It needs a branch, a clean tree and the project config.
- `ship pr` pushes the branch and has the PR agent open or update its PR, as described in [The pull request](#the-pull-request). It never squashes, whatever `pr.squash` says: the commits go up as they are. `--plan <dir>` gives the agent a spec and plan to describe the change with; without one, the commits and the diff describe it. It needs a branch and a clean tree outside the plan dir, and uses the project config when there is one and the defaults otherwise.
- `ship post <review-id>` posts a review `ship review` stored, as `ship review --post` would. It needs `HEAD` at the reviewed head (`gh pr checkout <n>`), and refuses a review with no PR, of another repository, or with no findings.

## Clef decisions

ship asks [Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef-flash/) (`clef-flash`) to make a few small judgement calls that rules make badly:

- **Reviewer routing.** Each review round picks reviewers with the deterministic triggers in their briefs, then asks Clef whether the change needs any of the others (added at probability 0.5 or more). Clef can only add reviewers.
- **Review model.** The same call rates the change's risk: a `trivial` change is reviewed with `models.reviewTrivial` (default `haiku`), a `risky` one with `models.reviewRisky` (default `opus`), and a `routine` one with `models.review`. A reviewer whose brief names a `model` keeps it.
- **Convention topics.** A review also gets a convention topic whose stack the repo uses but whose triggers the change missed, when Clef says the change touches what it covers (0.5 or more). Clef never removes a topic.
- **Lowering must-fix findings.** Clef rates each must-fix finding of a round; one it rates only a formatter, linter or taste remark (0.7 or more) becomes a nit. It never touches a tradeoff and never raises a severity. Duplicates merged into one finding are lowered only when every must-fix among them is.
- **Unlabelled threads.** For `ship fix` and `ship recheck` on a PR, a thread from someone who may push or from a trusted bot, with no label from ship and no stored finding, is a must-fix, a nit or no finding at all (a question or a thank-you, left out), whichever Clef finds most probable. So is each comment in a trusted bot's review body; CodeRabbit's own rating is ignored.
- **Failing checks.** Before a check fix, Clef rates each failing check as caused by the change or unrelated to it. When every failure looks unrelated (0.7 or more), ship runs the checks again once without a fix: a pass goes on, and a failure escalates the run as `checks-unrelated`, its PR saying the failing checks look unrelated to the change.

Clef is never required. When it is off, has no credentials, fails or times out (30 seconds), each decision does what it did without Clef (triggers only, `models.review`, triggers only, no lowering, must-fix, the fix loop) and ship logs a warning to `daemon.log`. Each decision is logged with Clef's probability, and a decision made inside a run is checkpointed with its step, so `ship resume` does not ask again.

`ship auth cloudflare` asks for a Cloudflare account id and an API token with the Workers AI permission, checks them with one Clef call, and saves them to `credentials.json` in ship's home, readable by you only (mode 0600). That file is the only place ship reads them from; delete it to remove them. Set `clef` to `false` in the project config to turn Clef off for a project.

`clef` replaced `reviewers.clef`: a project config that still sets `reviewers.clef` fails to load, naming the key. Move the value to the top-level `clef`.

## Conventions

ship carries a programming philosophy and its conventions, and applies them to every run, whether or not the repo has its own. They live in `packages/core/src/conventions/` and are bundled with the CLI: one Markdown file per topic (comments, Effect, error handling, testing, TypeScript, Svelte, styling and more), plus the `software-design-philosophy`, `codebase-design` and `testing` references.

A topic applies when the repo uses its stack: a dependency in a git-tracked `package.json` (or a tracked `tsconfig.json` for TypeScript). The implementer gets the base file of every applying topic, the `codebase-design` and `testing` references and the philosophy; each reviewer gets the topics its brief lists, when they apply to the change. A rule quoted from a convention counts as a written project rule, so breaking it can be must-fix. The repo's own written rules (AGENTS.md, CLAUDE.md, its docs) win where they conflict.

`ship conventions` prints the design conventions (the `software-design-philosophy` and `codebase-design` references and the file-organization topic, when it applies) for planning or discussing a change, and lists the other applying topics; `ship conventions <topic>` prints one of them. It runs without the daemon. The `plan-out` and `ship-conventions` skills run it.

See `packages/core/src/conventions/README.md` for the file layout and frontmatter.

## The pull request

The PR's base is the branch's upstream when it tracks another branch, else the default branch (the target of `origin/HEAD`, else `main` or `master`). To base a change on `develop`, create the branch with `git switch -c feature origin/develop`, or point an existing one at it with `git branch -u origin/develop`; ship's push keeps that upstream, so `ship resume` and later runs target the same base. The base also sets where the range of `ship checks` and `ship pr` starts.

ship pushes the branch, then has an agent open or update the PR by following a `pr` skill: the repo's own, at `.agents/skills/pr/SKILL.md` or `.claude/skills/pr/SKILL.md`, or ship's, in `packages/core/src/skills/pr/`. Nobody is there to answer, so ship tells the agent the branch, the base and whether to open a draft, and the agent asks nothing: where the skill would wait for an answer, it takes the default or leaves the choice out. It does every other step, including the skill's writes to GitHub, such as labels and comments. The agent may run commands, and ship refuses its PR when the head is no longer the commit ship pushed.

ship then adds its own parts to the body, between `<!-- ship:… -->` comments, replacing the ones an earlier run added: a warning on top when the run escalated, and at the end the checks that failed before the change and the review findings left for a human.

On the default branch there is no PR to open: ship pushes the branch to `origin` without squashing, whatever `pr.squash` says, and the summary's `prUrl` is `null`. A run that escalates there keeps its commits, the unfinished work included, local and pushes nothing. `ship checks` there runs on the commits `origin` does not have yet.

## Develop

```sh
pnpm install
pnpm check   # lint, typecheck, tests, format check
pnpm build   # bundles packages/cli to dist/bin.mjs
```

ship keeps its config, run store and daemon socket in `~/.ship`; set `SHIP_HOME` to use another directory.

| Package           | Role                                                           |
| ----------------- | -------------------------------------------------------------- |
| `packages/core`   | Pipeline state machine, step actors, services, RPC contract    |
| `packages/store`  | SQLite run store: runs, snapshots, events                      |
| `packages/daemon` | Long-lived host that owns runs, check locks and the RPC server |
| `packages/cli`    | `ship` command, published as `@f-elix/ship`                    |
