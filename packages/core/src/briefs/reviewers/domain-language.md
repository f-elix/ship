---
name: domain-language
description: Names of domain concepts against the project's glossary (CONTEXT.md, ADRs, the spec); one name per concept, one concept per name.
model: haiku
triggers:
    paths:
        - '**/CONTEXT*.md'
        - '**/GLOSSARY*.md'
        - '**/adr/**'
    addedLines:
        - '^\s*export\s+(?:declare\s+)?(?:type|interface|class|enum|const\s+[A-Z]\w*\s*=\s*Schema\.)'
---

Check that the change names domain concepts the way the project does.

Read the glossary first: `CONTEXT.md` or `CONTEXT-MAP.md` (and the context files it points to), `docs/adr/`, then the spec. Without a glossary, use the terms the spec and the existing code already use.

- Synonyms: a new name for a concept that already has one (`job` where the code says `run`).
- Overloading: an existing term reused for a different concept.
- Leaking layers: storage or transport vocabulary in domain types, or domain types named after their implementation.
- Glossary drift: the change introduces or redefines a concept and the glossary, if there is one, does not record it; or the glossary changes and code still uses the old term.

Quote the glossary or the existing usage. A name that contradicts a quoted glossary entry is `must-fix`; other naming drift is `nit`.

Out of scope: general naming and readability (standards), comments (comments).
