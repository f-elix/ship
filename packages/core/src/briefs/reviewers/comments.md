---
name: comments
description: Accuracy and value of code comments, docstrings and docs the change adds.
# Not blocking: a wrong or noisy added comment misleads but does not break behaviour.
blocking: false
model: haiku
conventions: [comments]
triggers:
    fileKinds: [docs]
    addedLines:
        - '^\s*(?://|/\*|\*\s|\*/|#\s|--\s|<!--|"""|''''''|;;)'
---

Check the comments, docstrings and docs this change adds.

- Wrong: an added comment or doc says something the code does not do. Quote both.
- Noise: comments that restate the code, narrate the edit ("now uses X", "changed from Y"), or address a reviewer instead of a future reader.
- Missing: a non-obvious constraint, invariant or workaround the code relies on with no explanation. Report this only when a reader would likely break it.
- Leftover TODO, FIXME or commented-out code without an owner or reason.

A wrong comment or doc is `tradeoff`; noise and wording are `nit`.

Out of scope: existing docs or comments the change makes stale (standards), the code's behaviour, names (standards, domain-language), and the plan files.
