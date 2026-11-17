---
name: deps
description: Dependency manifests and lockfiles (added, removed or bumped packages, version ranges, lockfile consistency, dev versus runtime placement, toolchain versions).
# Blocking: a manifest out of sync with its lockfile, or a runtime import declared only as a dev dependency, breaks installs and builds.
blocking: true
model: haiku
triggers:
    fileKinds: [deps]
    paths:
        - '**/.npmrc'
        - '**/.yarnrc.yml'
        - '**/.nvmrc'
        - '**/.node-version'
        - '**/.tool-versions'
        - '**/rust-toolchain{,.toml}'
---

Check the change's dependency edits.

- Consistency: a manifest edited without its lockfile, or the reverse; workspace packages that disagree on a version the repo pins.
- Placement: a package imported at runtime but declared as a dev dependency, or a build-only tool shipped as a runtime dependency. Check the actual imports.
- Versions: ranges where the repo pins exact versions, prerelease or tag versions without a reason, a major bump without the code changes it needs.
- Need: a new package for something the standard library or an existing dependency already does; a package added but never imported; one removed but still imported.
- Risk: an abandoned, very new or typo-squatted name, an install script, or a large transitive footprint for a small use. You cannot query a registry; flag only what the name, version and lockfile show.

A manifest out of sync with its lockfile, or a runtime import missing from runtime dependencies, is `must-fix`. Choice of package is `tradeoff`.

Out of scope: how the dependency is used in code (other reviewers), whether a new dependency changes the architecture (design).
