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

`skills/` holds three skills: `plan-out` designs a change with you and writes the plan dir (`spec.md` and `implementation-plan.md`), `ship` hands that plan to `ship run` and reports the result, and `ship-init` sets up a project. Link them into your agent's skills folder so they follow the checkout:

```sh
ln -s "$PWD/skills/plan-out" "$PWD/skills/ship" "$PWD/skills/ship-init" ~/.agents/skills/
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

Run from a feature branch with a clean working tree, with a plan dir holding `spec.md` and `implementation-plan.md`:

```sh
ship run .plans/my-feature
```

Events stream to stderr as one line each: state changes, check results, lock waits, findings counts, cost, the PR URL. When the run ends, its summary JSON is printed on stdout and nothing else is, so `ship run <dir> > summary.json` keeps it. The exit code says how the run ended:

| Code | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| 0    | done: the PR is up                                       |
| 2    | escalated: a draft PR lists the unresolved findings      |
| 1    | failed, cancelled, interrupted, or the run did not start |
| 130  | Ctrl-C (or SIGTERM): a started run keeps going           |

Ctrl-C detaches instead of cancelling, and prints how to follow, check or cancel the run.

| Command                              | What it does                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `ship run <plan-dir>`                | Start a run in the current directory with the current env                              |
| `ship resume <id>`                   | Continue an interrupted run with the current env; streams and exits like `ship run`    |
| `ship cancel <id>`                   | Stop a run; it ends as `cancelled`                                                     |
| `ship status [id] [--json]`          | A run's details and summary, or the active runs                                        |
| `ship list [--limit n] [--json]`     | Recent runs, most recently updated first (20 by default)                               |
| `ship logs <id> [--follow] [--json]` | A run's event log; `--follow` keeps printing until the run ends                        |
| `ship daemon status`                 | The daemon's version, pid, socket, log and active runs; starts it if it is not running |
| `ship daemon stop [--force]`         | Stop the daemon                                                                        |
| `ship daemon restart [--force]`      | Restart it, e.g. after upgrading ship or editing lock permits                          |
| `ship init --detect`                 | Print a draft project config for the current directory                                 |
| `ship init --write <file> [--force]` | Validate and save the project config, then run every check once                        |

Runs are hosted by a background daemon, which the commands that need it start when it is not running (`ship daemon stop` does not); its output goes to `daemon.log` in ship's home. The CLI and the daemon must be the same version: after an upgrade, commands ask for `ship daemon restart`. Stopping or restarting the daemon is refused while runs are active; `--force` interrupts them, and `ship resume <id>` continues them later.

The implementing agent runs unattended with every permission (`bypassPermissions`) in the project directory. Reviewers can only read.

## Conventions

ship carries a programming philosophy and its conventions, and applies them to every run, whether or not the repo has its own. They live in `packages/core/src/conventions/` and are bundled with the CLI: one Markdown file per topic (comments, Effect, error handling, testing, TypeScript, Svelte, styling and more), plus the `software-design-philosophy`, `codebase-design` and `testing` references.

A topic applies when the repo uses its stack: a dependency in a git-tracked `package.json` (or a tracked `tsconfig.json` for TypeScript). The implementer gets the base file of every applying topic, the `codebase-design` and `testing` references and the philosophy; each reviewer gets the topics its brief lists, when they apply to the change. A rule quoted from a convention counts as a written project rule, so breaking it can be must-fix. The repo's own written rules (AGENTS.md, CLAUDE.md, its docs) win where they conflict.

See `packages/core/src/conventions/README.md` for the file layout and frontmatter.

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
