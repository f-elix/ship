/** How the inbox names each action, and what its tooltip says it does. */
import type { ActionKind } from '#lib/server/deliverables.ts';

export interface ActionLabel {
	readonly label: string;
	/** The tooltip: the ship command the action runs, or what it does when it runs none. */
	readonly tooltip: string;
	/** Stops work, so its button is styled as a warning. */
	readonly danger?: boolean;
}

export const ACTIONS: Record<ActionKind, ActionLabel> = {
	fix: { label: 'Fix the findings', tooltip: 'ship fix' },
	recheck: { label: 'Recheck', tooltip: 'ship recheck' },
	post: { label: 'Post the review', tooltip: 'ship post' },
	resume: { label: 'Resume', tooltip: 'ship resume' },
	cancel: { label: 'Cancel', tooltip: 'ship cancel', danger: true },
	archive: { label: 'Archive', tooltip: 'Moves it to Closed' },
	unarchive: { label: 'Move back to the inbox', tooltip: 'Moves it out of Closed' }
};

/**
 * The action ⌘↵ starts among a deliverable's `actions`: the primary one, unless it stops
 * work. A stray chord must never cancel a run, so a deliverable whose primary action is
 * `cancel` has no shortcut.
 */
export const shortcutAction = (actions: ReadonlyArray<ActionKind>): ActionKind | null => {
	const primary = actions[0];
	return primary === undefined || ACTIONS[primary].danger === true ? null : primary;
};
