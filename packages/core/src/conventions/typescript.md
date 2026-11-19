---
name: typescript
description: TypeScript types, signatures and assertions, and the language features to use or avoid.
stack: [typescript]
triggers:
    paths: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts', '**/*.svelte']
---

# TypeScript conventions

This page holds what to know before writing; [typescript.details.md](typescript.details.md) holds the types, signatures and assertions checked in review.

## Parse at the boundary

Data from outside the program (a request body, a file, an API response, `JSON.parse`) arrives as `unknown`. Decode it once, where it enters, with the repo's schema library, and pass the typed value inward. Hand-written `typeof` checks narrow a representation without establishing its contract; the `anti-slop/no-runtime-typeof` lint rule rejects them.

```typescript
// ✅ Good: a schema decodes and validates in one step
export const User = schema.object({
	id: schema.string(),
	name: schema.string(),
	email: schema.string(),
	age: schema.optional(schema.number())
});

export type User = schema.Infer<typeof User>;

// Usage:
const user = User.parse(await response.json());
// user is now typed as User and validated

// ❌ Bad: a hand-written guard that checks the representation
export function isUser(value: unknown): value is User {
	return typeof value === 'object' && value !== null && 'id' in value && 'email' in value;
}
```

`schema` stands for whichever library the repo uses: Zod, Valibot, Effect Schema or another.
