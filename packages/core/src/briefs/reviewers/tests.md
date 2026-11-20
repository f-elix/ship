---
name: tests
description: Whether changed behaviour is covered by tests, and whether the tests can fail, assert the right thing and stay deterministic.
conventions: [testing, test-cases, references/testing]
triggers:
    fileKinds: [source, test]
---

Check that the behaviour this change adds or alters is protected by tests, and that the changed tests are sound.

- Missing coverage: name the behaviour or branch (an error path, a boundary, a state transition) that no test exercises. Find the tests first; search by function name and by behaviour. "Add more tests" is not a finding.
- Tests that cannot fail: no assertion, assertions on mocks only, expected values copied from the output, `skip` or `only` left in, or errors swallowed in the test.
- Wrong target: the test asserts implementation details where behaviour is what matters, or fakes the very unit under test.
- Flakiness: real time, real network, order dependence, shared state across tests, unseeded randomness.
- Setup that hides what is being protected.

`must-fix`: new or changed behaviour the stated intent (the plan, or the PR description) requires with no test, or a test that cannot fail. A missing edge case is `must-fix` when the stated intent (the plan, or the PR description) names it or a quoted convention calls for it; otherwise leave it out.

Out of scope: whether the production code is correct (other reviewers own that), test style that tooling enforces.
