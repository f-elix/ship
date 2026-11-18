# ship

Runs the scripted part of a coding-agent workflow: implement → checks → review → fix → pull request.
Planning stays an interactive conversation; `ship run <plan-dir>` takes it from there and stops when a PR is up.

Status: early development. The commands below work; `ship init` is not there yet, so project configs are written by hand.

## Install

ship needs Node 26.13 or later, git, and `gh` signed in for opening PRs. It is not on npm yet; install it from a checkout:

```sh
pnpm install
pnpm build
cd packages/cli && pnpm pack && npm i -g ./f-elix-ship-*.tgz
```

`npm rm -g @f-elix/ship` uninstalls it.

## Usage

Each project needs a config at `~/.ship/projects/<host>/<owner>/<repo>.json` (its checks and reviewers; see `packages/cli/schemas/project.schema.json`). Machine-wide settings go in `~/.ship/config.json` (`packages/cli/schemas/config.schema.json`).

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

Runs are hosted by a background daemon, which the commands that need it start when it is not running (`ship daemon stop` does not); its output goes to `daemon.log` in ship's home. The CLI and the daemon must be the same version: after an upgrade, commands ask for `ship daemon restart`. Stopping or restarting the daemon is refused while runs are active; `--force` interrupts them, and `ship resume <id>` continues them later.

The implementing agent runs unattended with every permission (`bypassPermissions`) in the project directory. Reviewers can only read.

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
