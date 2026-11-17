---
name: data
description: Persistence (migrations, database schemas, SQL and queries, transactions, persisted file formats); data integrity and backward-compatible reads.
# Blocking: lost or corrupted data cannot be undone after merge.
blocking: true
triggers:
    paths:
        - '**/migrations/**'
        - '**/*migrat*'
        - '**/*.sql'
        - '**/*.prisma'
        - '**/{db,database,store,storage,persistence}/**'
    addedLines:
        - '\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|VIEW|SCHEMA|TRIGGER)\b|\bADD\s+COLUMN\b|\bRENAME\s+(?:TO|COLUMN)\b|[`''"]\s*(?:create|alter|drop)\s+(?:table|index|view|trigger)\b'
        - '\b(?:sqlite|pg|mysql)Table\(|\bcreateTable\('
        - '\b(?:SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b|[`''"]\s*(?:select\s.+\sfrom|insert\s+into|update\s+\w+\s+set|delete\s+from)\b|\bsql\s*`'
        - '\bBEGIN\s+(?:TRANSACTION|IMMEDIATE)\b|\.transaction\(|withTransaction|\bCOMMIT\b|\bROLLBACK\b'
---

Check how the change stores, migrates and reads data.

- Migrations: irreversible or lossy steps (dropping or narrowing columns, rewriting values), migrations that fail on existing rows (a new NOT NULL without a default, a unique constraint over duplicates), migrations edited after they may have run, wrong ordering.
- Integrity: missing constraints or foreign keys the code relies on, writes that must be atomic but span several statements outside a transaction, read-modify-write races.
- Queries: wrong joins or filters, missing `WHERE` on updates and deletes, results assumed ordered without `ORDER BY`, NULL handling.
- Compatibility: data written by the previous version that the new code can no longer read, or new data the old version (still running, or after rollback) misreads.
- Deletion and lifecycle: orphaned rows or files, cascades that delete more than intended.

A traced path to lost, corrupted or unreadable data is `must-fix`. Indexing and normalisation choices are `tradeoff`.

Out of scope: SQL injection (security), query speed (performance), API shapes (contracts).
