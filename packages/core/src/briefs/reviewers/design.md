---
# Adapted from the Design reviewer of Matt Pocock's code-review skill (MIT); see ../ATTRIBUTION.md.
name: design
description: Ownership, module boundaries, interfaces, persistence strategy and new abstractions or services; whether a simpler structure would serve the same requirements.
# Not blocking: design findings are judgement calls for the human reading the PR, and a fix loop on them churns.
blocking: false
model: sonnet
conventions: [references/software-design-philosophy, references/codebase-design, file-organization]
triggers:
    addedLines:
        - '^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s'
        - '\bCREATE\s+TABLE\b|[`''"]\s*create\s+table\b'
---

Judge whether the change chose a sound ownership model, boundary, interface or persistence strategy.

Read the full diff, the surrounding modules and callers, and the plan. Separate choices the requirements force from choices the implementation made. Treat the author's explanations as hypotheses.

For each meaningful decision, ask:

- Which owner can derive, validate or enforce this directly? Is one fact stored or computed in two places?
- Does the interface hide substantial behaviour (deep module), or forward the same contract and add coordination (shallow, pass-through)?
- Must a common caller understand rare cases, storage details or call order? Pull that complexity into the owner.
- Is persisted state authoritative, derived, cached or a historical snapshot, and do its update and delete rules follow?
- Does an existing abstraction fit, or would extending it mix unrelated responsibilities? Are there hooks for imagined consumers?

Each finding names the decision and its code, the principle and its observable cost (change amplification, knowledge callers must carry, a hidden dependency), a concrete alternative that meets the same requirements, and what that alternative removes and what it costs. A smell without an evidenced cost, or an objection without a feasible alternative, is not a finding. Fewer files is not automatically better. Accept the existing design when its costs are justified.

Out of scope: local readability and conventions (standards), requirement coverage (spec), runtime defects owned by the specialist reviewers.
