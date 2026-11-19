---
name: contracts
description: Public and cross-module contracts (exported APIs, RPC and HTTP shapes, CLI flags, config and file formats, events); breaking changes and caller compatibility.
triggers:
    paths:
        - '**/{index,mod,lib,main}.{ts,mts,js,mjs,rs}'
        - '**/__init__.py'
        - '**/{api,routes,rpc}/**'
        - '**/*{rpc,Rpc}.*'
        - '**/*.{proto,graphql,gql}'
        - '**/{openapi,swagger}*.{json,yaml,yml}'
        - '**/*.schema.json'
    addedLines:
        - '"(?:exports|main|module|types|bin|engines)"\s*:'
        - '\b(?:Schema\.(?:Struct|TaggedStruct|TaggedError|Union|Literals)|z\.object)\('
        - '\b(?:app|router|server)\.(?:get|post|put|patch|delete)\(|@(?:Get|Post|Put|Patch|Delete)\('
---

Check that contracts the change touches stay coherent and compatible: exported functions and types, RPC and HTTP request and response shapes, CLI commands and flags, config keys, event and wire formats, exit codes.

- Breaking changes: a removed or renamed export, field or flag, a narrowed input, a widened output, a changed default or meaning. Find the callers, in this repo and in config files users already wrote, that break.
- Inconsistency: the declared type, schema, doc and implementation disagree, or two producers of the same message build it differently.
- Partial migration: some callers updated to the new contract and others not.
- Leaks: internal representation exposed through a public type, so callers come to depend on it.

A traced break of a real caller is `must-fix`. An intended break the plan calls for is not a finding unless the migration is incomplete. Naming and shape preferences are `nit`.

Out of scope: data the program persists, its schemas, migrations and file formats (data), whether the contract is the right abstraction (design), package manifests' dependency lists (deps).
