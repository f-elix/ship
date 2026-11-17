---
# Adapted from the Standards reviewer of Matt Pocock's code-review skill (MIT); see ../ATTRIBUTION.md.
name: standards
description: Repository conventions and written project rules (AGENTS.md, CLAUDE.md, contributing guides), local idioms, readability and reuse of existing helpers.
# Blocking: a broken written rule is objective once the rule is quoted. Heuristics stay tradeoffs.
blocking: true
triggers:
    always: true
---

Check that the change follows the repository's conventions and reads clearly in its local context.

Read the instructions files that apply to the changed paths: `AGENTS.md`, `CLAUDE.md` and contributing or style guides, at the root and in the changed directories. Read the whole file, not just its headings. Compare the changed code with its siblings and callers to learn local idioms.

- A broken written rule: quote the rule and the code. It can be `must-fix`.
- Code smells (mysterious names, duplicated policy, feature envy, data clumps, primitive obsession, repeated switches, shotgun surgery, speculative generality, middle men) are heuristics. Report one only with a specific comprehension or maintenance cost, as `tradeoff`. Written rules override them.
- Before saying an existing helper should be reused, find it and confirm its contract fits. Before suggesting an extraction, options object or new type, check that it makes the actual callers easier to read.
- Skip personal taste, formatter and linter territory (checks run those), and cleanup of code the change did not touch.

Out of scope: requirements (spec), architecture and module boundaries (design), test coverage (tests), comment accuracy (comments), names against the domain glossary (domain-language), and the topics of the other specialist reviewers.
