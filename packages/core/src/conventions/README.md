# Conventions

The programming conventions ship applies to every run, in any repo. ship picks the topics that fit the repo and lists their files, by absolute path, in the prompts of the implementer (implement, fixChecks, fix) and of the reviewers. Where a convention conflicts with the repo's own written rules (AGENTS.md, CLAUDE.md, its docs), the repo's rules win. A project skips topics with `conventions.disable` in its config.

## Files

Each topic has a base file and, for some, a details file:

- `<topic>.md`: what a reviewer can't catch on the diff. The implementer reads it before writing; reviewers read it too.
- `<topic>.details.md`: what a reviewer can check on the diff. Only reviewers read it, after the base file.
- A topic without a details file is one file, read by both.

`references/` holds the design and testing references: [`software-design-philosophy`](references/software-design-philosophy/SKILL.md), [`codebase-design`](references/codebase-design/SKILL.md) and [`testing`](references/testing/SKILL.md). The implementer gets all three; a reviewer gets those its brief lists. `LICENSE` and `UPSTREAM.md` record where a vendored reference comes from.

## Frontmatter

Each base file starts with YAML frontmatter; details files have none and are found by name.

- `name`: the topic name, the file name without `.md`.
- `description`: one sentence.
- `stack`: dependency names, e.g. `[effect]`. The topic applies when any of them is in the dependencies of a `package.json` tracked by git anywhere in the repo. `typescript` also matches a tracked `tsconfig.json`.
- `triggers`: optional, in the reviewers' format (`paths`, `addedLines`, `fileKinds`; see `ReviewerTriggers` in `../reviewer.ts`). A reviewer gets a topic with triggers only when they match the change. Implementers ignore them: nothing has changed yet.

A reviewer brief's `conventions` field names the topics (and `references/<name>`) it reads; see `../briefs/README.md`. Selection lives in `../conventions.ts`.

## Philosophy

The codebase follows John Ousterhout's _A Philosophy of Software Design_: the [`software-design-philosophy`](references/software-design-philosophy/SKILL.md) skill is the rubric, and [`codebase-design`](references/codebase-design/SKILL.md) gives the vocabulary for one module (module, interface, seam, adapter, depth). Where the two disagree on how depth is measured, `codebase-design`'s depth-as-leverage applies.

- **Consistency over personal preference**: we follow these patterns even if you'd do it differently.
- **Readability over cleverness**: code is read more than written.
- **Type safety**: let the type checker catch errors early.
