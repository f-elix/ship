# Built-in briefs

`reviewers/*.md` are the built-in reviewers; `verifier.md` is the verifier's brief. A project reviewer in `~/.ship/projects/<project>/reviewers/` replaces the built-in with the same name.

The markdown body reaches the model on every review, so keep it short. Of the frontmatter, only `description` reaches a model (Cloudflare Clef, which routes reviewers); YAML comments cost nothing. The rules every reviewer shares (scope, falsification, severity, output) live in `reviewerPrompt` in `../reviewers.ts`, not in the briefs.

Frontmatter:

- `name`: matches the file name.
- `description`: one sentence of scope. Clef reads it to decide whether to add the reviewer; without it, Clef reads the brief's first paragraph.
- `triggers`: `always`, `paths` (globs), `addedLines` (regexes), `fileKinds`. See `ReviewerTriggers` in `../reviewer.ts`.
- `model`: `haiku` for narrow, mechanical reviewers (comments, deps, domain-language), `sonnet` for spec and design, and `opus` for security. Leaving it out uses the model for the change's risk, as Clef rates it: `reviewTrivial`, `review` or `reviewRisky` from the configured models.
- `conventions`: the conventions the reviewer reads, listed in its prompt by absolute path: topic names, given only when the topic applies to the repo's stack and the change, and `references/<name>`, always given. `'*'` gives every topic that applies (standards). Leaving it out gives none. See `../conventions/README.md`.

Severities, as `reviewerPrompt` defines them for every reviewer:

- `must-fix`: a defect with concrete evidence. The next fix round fixes it.
- `nit`: style or wording with no effect on behaviour. The same fix round fixes it. Clef lowers a must-fix it rates only a taste remark to a nit; the verifier does not change severities.
- `tradeoff`: the change deviates from the stated intent (the plan, or the PR description for `ship review`), or has an impact it did not foresee. The loop never fixes it; the PR body lists it.

A severity line in a brief must fit these: a judgement call that is neither a defect nor a deviation is not a `tradeoff`.

Attribution for adapted material is in `ATTRIBUTION.md`.
