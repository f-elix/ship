# AGENTS.md

- Effect v4, XState v6 (`@xstate/effect`). Versions are pinned exactly; the XState packages are betas, so upgrade them deliberately.
- `core`, `store` and `daemon` are private workspace packages whose `exports` point at `src/*.ts`. Only `packages/cli` is published; tsdown bundles the workspace packages into it, so every npm dependency they use must also be listed in `packages/cli/package.json`.
- `core` makes no terminal or process-host assumptions; the CLI and a future UI are both RPC clients of the daemon. The exceptions are `ship conventions`, which reads the bundled conventions in-process, and `ship init`, which detects and validates in-process through `@ship/core/init` (no daemon needed to draft a config) but runs checks through the daemon, which holds the lock permits.
- pnpm runs scripts on the Node version in `devEngines`.

## Verify

Run `pnpm check` and `pnpm format`.
