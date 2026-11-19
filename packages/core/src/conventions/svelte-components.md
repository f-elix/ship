---
name: svelte-components
description: How Svelte components are structured, from props and events to context files and reactivity.
stack: [svelte]
triggers:
    paths: ['**/*.svelte']
---

# Svelte Component Conventions

This page holds what to know before writing; [svelte-components.details.md](svelte-components.details.md) holds the structure, reactivity rules, naming and anti-patterns checked in review.

## Context Files

For shared state logic that needs to be accessed by multiple components, use `.ts` or `.svelte.ts` (if you need to use runes) files with the context API and [`runed`'s `Context` class](https://runed.dev/docs/utilities/context). Make sure the name of the file ends with 'Context' so we know right away what it contains.

```typescript
// notesEditorContext.svelte.ts
import { Context } from 'runed';

class NotesEditorContext {
	content = $state('');
	isEditing = $state(false);

	startEditing() {
		this.isEditing = true;
	}

	save() {
		// Save logic
		this.isEditing = false;
	}
}

const context = new Context<NotesEditorContext>('notes-editor');

export function setNotesEditorContext() {
	return context.set(new NotesEditorContext());
}

export function getNotesEditorContext() {
	return context.get();
}
```

Usage:

```svelte
<!-- Parent component -->
<script lang="ts">
	import { setNotesEditorContext } from './notesEditorContext.svelte';

	const editor = setNotesEditorContext();
</script>

<!-- Child component -->
<script lang="ts">
	import { getNotesEditorContext } from './notesEditorContext.svelte';

	const editor = getNotesEditorContext();
</script>
```

## Remote functions gotchas

- A remote function runs on its own URL. In a `form()` or `query()` handler, `getRequestEvent().params` is empty and `url` is the remote function's endpoint, not the page's. Pass what you need from the page as an argument or a form field.
