# ship

Runs the scripted part of a coding-agent workflow: implement → checks → review → fix → pull request.
Planning stays an interactive conversation; `ship run <plan-dir>` takes it from there and stops when a PR is up.

Status: early development, nothing usable yet.

## Develop

```sh
pnpm install
pnpm check   # lint, typecheck, tests, format check
pnpm build   # bundles packages/cli to dist/bin.mjs
```

| Package           | Role                                                           |
| ----------------- | -------------------------------------------------------------- |
| `packages/core`   | Pipeline state machine, step actors, services, RPC contract    |
| `packages/store`  | SQLite run store: runs, snapshots, events                      |
| `packages/daemon` | Long-lived host that owns runs, check locks and the RPC server |
| `packages/cli`    | `ship` command, published as `@f-elix/ship`                    |
