import type { RunEvent } from './event.ts';
import type { FindingId, VerifiedFinding } from './finding.ts';
import type { RunId } from './primitives.ts';
import type {
	CheckResult,
	CheckRound,
	EscalationReason,
	ShipSummary,
	TerminalRunStatus
} from './run.ts';

export interface SummaryInput {
	readonly runId: RunId;
	readonly status: TerminalRunStatus;
	/** The run's events in log order; unknown events are left out. */
	readonly events: ReadonlyArray<RunEvent>;
	/** Why the run failed, when it did. */
	readonly error: string | null;
}

/** The event of `RunEvent` tagged `Tag`. */
export type EventOf<Tag extends RunEvent['_tag']> = Extract<RunEvent, { readonly _tag: Tag }>;

/** The events tagged `tag`, in log order. */
export const ofTag = <Tag extends RunEvent['_tag']>(
	events: ReadonlyArray<RunEvent>,
	tag: Tag
): ReadonlyArray<EventOf<Tag>> =>
	events.filter((event): event is EventOf<Tag> => event._tag === tag);

type CheckEvent = EventOf<'CheckStarted'> | EventOf<'CheckFinished'>;

interface PassInProgress {
	readonly baseline: boolean;
	readonly round: number;
	readonly attempt: number;
	readonly results: Map<string, CheckResult>;
	/** Commands started and not finished yet, as `check:command`. */
	readonly open: Set<string>;
}

/**
 * Check passes from the `CheckFinished` events of the `run` commands, in log order. A pass
 * in which every check was skipped (`{files}` with no changed files) has no event and is
 * left out. So is a pass that never completed, e.g. when a command timed out or the run
 * was cancelled while it ran: like the machine's own state, the summary lists only
 * complete passes. A complete pass is listed even when its step failed afterwards, e.g.
 * on the commit: the log records what ran, so its checks did pass.
 */
const checkRounds = (events: ReadonlyArray<RunEvent>): ReadonlyArray<CheckRound> => {
	const passes = new Map<string, PassInProgress>();
	events
		.filter(
			(event): event is CheckEvent =>
				event._tag === 'CheckStarted' || event._tag === 'CheckFinished'
		)
		.forEach((event) => {
			const key = `${event.baseline}:${event.round}:${event.attempt}`;
			const pass = passes.get(key) ?? {
				baseline: event.baseline,
				round: event.round,
				attempt: event.attempt,
				results: new Map<string, CheckResult>(),
				open: new Set<string>()
			};
			passes.set(key, pass);
			const command = `${event.check}:${event.command}`;
			if (event._tag === 'CheckStarted') {
				pass.open.add(command);
				return;
			}
			pass.open.delete(command);
			if (event.command !== 'run') return;
			// A resumed pass runs its checks again; the latest result wins.
			pass.results.delete(event.check);
			pass.results.set(event.check, {
				name: event.check,
				exitCode: event.exitCode,
				durationMs: event.durationMs,
				...(event.exitCode === 0 ? {} : { outputTail: event.outputTail })
			});
		});
	return [...passes.values()]
		.filter((pass) => pass.open.size === 0 && pass.results.size > 0)
		.map(({ baseline, round, attempt, results }): CheckRound => ({
			baseline,
			round,
			attempt,
			results: [...results.values()]
		}));
};

/** A `ship run`'s summary, built from its event log. */
export const buildSummary = (input: SummaryInput): ShipSummary => {
	const { events } = input;
	const verified = new Map<FindingId, VerifiedFinding>(
		ofTag(events, 'FindingsVerified').flatMap((event) =>
			event.verified.map((finding) => [finding.id, finding] as const)
		)
	);
	const lookup = (ids: ReadonlyArray<FindingId>) =>
		ids.flatMap((id) => {
			const finding = verified.get(id);
			return finding === undefined ? [] : [finding];
		});
	const triaged = ofTag(events, 'FindingsTriaged').at(-1);
	const escalation: EscalationReason | null = ofTag(events, 'Escalated').at(-1)?.reason ?? null;
	return {
		kind: 'ship',
		runId: input.runId,
		status: input.status,
		prUrl: ofTag(events, 'PrOpened').at(-1)?.url ?? null,
		rounds: Math.max(0, ...ofTag(events, 'ReviewStarted').map((event) => event.round)),
		checks: checkRounds(events),
		costUsd: ofTag(events, 'AgentCost').reduce((total, event) => total + event.costUsd, 0),
		unresolvedMustFix: lookup(triaged?.mustFix ?? []),
		tradeoffs: lookup(triaged?.tradeoffs ?? []),
		nits: lookup(triaged?.nits ?? []),
		escalationReason: input.status === 'escalated' ? escalation : null,
		error: input.status === 'failed' ? input.error : null
	};
};
