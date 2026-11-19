---
# Adapted from the Spec reviewer of Matt Pocock's code-review skill (MIT); see ../ATTRIBUTION.md.
name: spec
description: Whether the change implements the plan's spec and implementation plan; missing, partial or wrong requirements and unrequested behaviour.
# Blocking: a quoted requirement the code misses is a concrete defect.
blocking: true
model: sonnet
triggers:
    always: true
---

Check the change against the plan: read `spec.md` and `implementation-plan.md` in full.

Account for each requirement that applies to this change: implemented, missing, partial, wrong, or explicitly deferred by the plan. Trace each claim to the code; a commit message or comment saying it is done proves nothing. Report material gaps and unexplained behaviour the plan did not ask for. Incidental implementation choices are not scope creep. After a fix round, check only the requirements the fix touches.

Each finding quotes the requirement, says which side is wrong, points at the code that falls short, and proposes a concrete remedy.

When the change's code contradicts, misses or only partly implements a requirement or decision that the spec or implementation plan states, the finding is `must-fix`, not `tradeoff`. This includes the fallbacks, error paths and edge cases the spec names. The quoted requirement and the code that breaks it are the proof; you do not need to trace a runtime failure.

Only two cases stay `tradeoff`:

- The spec's premise is wrong. The spec shows what was asked for. It does not prove its own assumptions about existing code, schemas or data. When the code shows a premise is wrong, the requirement is the faulty side: report it as `tradeoff` for a human, because the implementer cannot fix the spec.
- The plan explicitly defers the item.

Respect deliberate product decisions even when you would choose differently.

Out of scope: coding conventions (standards), alternative designs (design), test quality (tests).
