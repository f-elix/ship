---
name: performance
description: Algorithmic cost, queries in loops, blocking I/O on hot paths, unbounded concurrency, memory growth, missing pagination and needless repeated work.
triggers:
    addedLines:
        - '\b\w+Sync\(|\bsetInterval\(|\bsleep\(|\bwhile\s*\(\s*true\b|\bfor\s*\(\s*;;'
        - '\bPromise\.all\(|\bEffect\.all\(|\bconcurrency:\s|\bunbounded\b'
        - '\bnew RegExp\(|\bfind(?:Many|All)\(|\bnew\s+\w*Cache\b|\bCache\.make|\bcached\w*\(|\bmemoi[sz]e'
---

Look for performance problems the change introduces at realistic input sizes.

- Complexity: nested loops, or `find`, `includes` or `indexOf` inside a loop over a collection that can grow; repeated sorting; regexes built per call or prone to catastrophic backtracking.
- I/O: a query, request or file read per item in a loop (N+1); synchronous I/O or process spawning on a request or event path; work repeated that could be done once.
- Concurrency: unbounded parallelism over user-sized input; sequential awaits where independent work could overlap and latency matters.
- Memory: whole files or result sets loaded where streaming or pagination is needed; caches or listeners that grow without bound.

State the input size that makes it matter and where that size comes from. Without it, the concern is speculation; leave it out. Micro-optimisations are `nit`.

Out of scope: correctness (other reviewers), query correctness (data), design structure (design).
