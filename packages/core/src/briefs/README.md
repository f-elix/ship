# Built-in briefs

`reviewers/*.md` are the built-in reviewers; `verifier.md` is the verifier's brief. A project reviewer in `~/.ship/projects/<project>/reviewers/` replaces the built-in with the same name.

The markdown body reaches the model on every review, so keep it short. Of the frontmatter, only `description` reaches a model (the router); YAML comments cost nothing. The rules every reviewer shares (scope, falsification, severity, output) live in `reviewerPrompt` in `../reviewers.ts`, not in the briefs.

Frontmatter:

- `name`: matches the file name.
- `description`: one sentence of scope, read by the LLM router.
- `triggers`: `always`, `paths` (globs), `addedLines` (regexes), `fileKinds`. See `ReviewerTriggers` in `../reviewer.ts`.
- `model`: `haiku` for narrow, mechanical reviewers (comments, deps, domain-language), `sonnet` for spec and design, and `opus` for security. Leaving it out uses the configured `review` model.
- `blocking`: whether the reviewer's must-fix findings start a fix round. Non-blocking reviewers (design, comments, performance, domain-language) cover judgement calls; their must-fix findings are filed as tradeoffs for the PR body. Each file says why in a YAML comment. `blocking` defaults to `true`, so a project copy of a non-blocking brief must keep `blocking: false`.

Attribution for adapted material is in `ATTRIBUTION.md`.
