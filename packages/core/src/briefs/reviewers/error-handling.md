---
name: error-handling
description: How failures are raised, propagated, recovered from and reported; swallowed errors, wrong fallbacks, lost causes, retries and cleanup.
# Blocking: a swallowed error or a wrong fallback is a real defect once the failing path is traced.
blocking: true
conventions: [error-handling]
triggers:
    addedLines:
        - '\bcatch\b|\btry\s*[:{]|\bthrow\b|\bexcept\b|\bfinally\b|\bpanic!?\(|\.unwrap\(\)|\.expect\(|\bif err != nil\b|\breturn err\b'
        - 'Effect\.(?:catch\w*|orDie|orElse\w*|ignore\w*|retry|timeout\w*|ensuring|acquireRelease)|\bmapError\b|TaggedError|\bnew \w*Error\('
        - 'process\.exit|\.on\(\s*[''"]error[''"]|Promise\.allSettled|AbortController|AbortSignal'
---

Check how the change handles failure.

- Swallowed errors: an empty or log-only catch, a `.catch(() => {})`, an ignored result or exit code, where the caller then proceeds on bad state.
- Wrong fallbacks: a default value that hides a failure the caller needed to know about, or turns "unknown" into "none".
- Lost information: the cause dropped when rethrowing, a generic message where the error carried the detail needed to act.
- Wrong scope: a catch so broad it also hides programming errors; recovery at a layer that has no truthful answer.
- Cleanup: resources, locks, temp files or child processes not released on the failure or interruption path.
- Retries: retrying a non-idempotent operation, or retrying without a bound.
- Typed errors: a failure the caller must handle declared as a defect, or the reverse.

Trace the failing path to a consequence: what breaks or is silently wrong. That is `must-fix`. Error style and message wording are `nit`.

Out of scope: security consequences (security), data corruption in storage (data), missing tests for error paths (tests).
