# AGENTS.md

- Effect v4, XState v6 (`@xstate/effect`). Versions are pinned exactly; the XState packages are betas, so upgrade them deliberately. Upgrade `@sveltejs/kit` deliberately too: the UI uses its experimental remote functions (`query.live`, `command`), whose API can change in a minor release.
- `core`, `store` and `daemon` are private workspace packages whose `exports` point at `src/*.ts`. Only `packages/cli` is published; tsdown bundles the workspace packages into it, so every npm dependency they use must also be listed in `packages/cli/package.json`.
- `packages/ui` (`ship ui`) is a private SvelteKit app, an RPC client of the daemon like the CLI. Its adapter-node build bundles the workspace packages and Svelte; the CLI's build makes it and tsdown copies it to `dist/ui`. It imports its own modules as `#lib/*` (package.json `imports`), not `$lib`. Its server code is in `src/lib/server/`, tested without SvelteKit; `pnpm typecheck` runs `svelte-check` on it.
- `core` makes no terminal or process-host assumptions; the CLI and the UI are both RPC clients of the daemon. The exceptions are `ship conventions`, which reads the bundled conventions in-process, and `ship init`, which detects and validates in-process through `@ship/core/init` (no daemon needed to draft a config) but runs checks through the daemon, which holds the lock permits.
- pnpm runs scripts on the Node version in `devEngines`.

## Verify

Run `pnpm check` and `pnpm format`.
