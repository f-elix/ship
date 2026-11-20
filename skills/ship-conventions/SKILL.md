---
name: ship-conventions
description: Load ship's design conventions (software-design-philosophy, codebase-design, file organization) before discussing, designing or reviewing code in a repo, without planning a change. Use when the user wants to talk through a design, an architecture, a module's shape or where code goes, or asks for ship's conventions.
---

# ship-conventions

Run `ship conventions` from the repo. It prints, in full, the design conventions that apply to the repo, each in a `<file path="…">` block; relative links inside a file resolve against its path. A list of the other topics that apply to the repo follows, one line each with its description.

Read the design conventions and use them throughout the discussion: name designs in their vocabulary (module, interface, seam, depth, leverage) and judge options by them.

Load another topic only when the discussion reaches it, e.g. `ship conventions error-handling` when the talk turns to how a module fails. It prints the topic in full, with its review checklist. `ship conventions references/testing` prints the testing reference.

Where a convention conflicts with the repo's own written rules (AGENTS.md, CLAUDE.md, its docs), the repo wins.
