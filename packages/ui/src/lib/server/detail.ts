/**
 * One deliverable in full, as the inbox's detail view shows it: what is left for the
 * developer, what ship handled, the change, and how each run went. Pure: the inbox reads
 * the events and the changed files, then builds the detail here.
 */
import type { GitSha, RunInfo, RunStatus } from '@ship/core/contract';
import { makeEventFormatter } from '@ship/core/event-lines';
import type { VerifiedFinding } from '@ship/core/finding';
import type { ChangedFile } from '@ship/core/git';
import { DateTime } from 'effect';
import {
	openFindings,
	summarize,
	type ArchiveMarks,
	type Deliverable,
	type DeliverableSummary,
	type OpenFindings,
	type RunWithEvents
} from './deliverables.ts';

/** A check that already failed on the baseline, so the change is not held to it. */
export interface PreexistingCheck {
	readonly name: string;
	readonly outputTail: string | null;
}

/** One run, for the history: what it was, how it ended, and its event log as lines. */
export interface HistoryRun {
	readonly runId: string;
	/** The command that started it, e.g. `ship fix`. */
	readonly command: string;
	readonly status: RunStatus;
	readonly round: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly costUsd: number;
	readonly lines: ReadonlyArray<string>;
}

/** A commit a run made. */
export interface MadeCommit {
	readonly sha: GitSha;
	readonly message: string;
}

/** A deliverable in full. Plain values only, because it is serialized to the browser. */
export interface DeliverableDetail {
	readonly summary: DeliverableSummary;
	readonly findings: OpenFindings;
	/** Findings a recheck found fixed. */
	readonly resolved: ReadonlyArray<VerifiedFinding>;
	/** How many reported findings the verifier dropped. */
	readonly disproved: number;
	readonly reviewers: ReadonlyArray<string>;
	/** Review rounds, over every run. */
	readonly rounds: number;
	readonly preexistingChecks: ReadonlyArray<PreexistingCheck>;
	readonly commits: ReadonlyArray<MadeCommit>;
	/** The files the change touches; `null` when git could not tell. */
	readonly files: ReadonlyArray<ChangedFile> | null;
	/** Newest first. */
	readonly runs: ReadonlyArray<HistoryRun>;
	/** Why the latest run failed, when it did. */
	readonly error: string | null;
}

/** Every event of the deliverable's runs, oldest run first. */
const eventsOf = (runs: ReadonlyArray<RunWithEvents>) =>
	runs.toReversed().flatMap((run) => run.events);

/**
 * The range the change spans: from where the oldest run started to the last commit
 * pushed, made or reviewed. Without an end, the change is the working tree's.
 */
export const changeRange = (
	runs: ReadonlyArray<RunWithEvents>
): { readonly from: GitSha; readonly to?: GitSha } | null => {
	let from: GitSha | null = null;
	let to: GitSha | null = null;
	for (const event of eventsOf(runs)) {
		switch (event._tag) {
			case 'RunCreated':
			case 'PrimitiveRunCreated':
				from ??= event.baseSha;
				break;
			case 'ReviewRunCreated':
			case 'PrRunCreated':
				from ??= event.baseSha;
				to = event.headSha;
				break;
			case 'CommitCreated':
			case 'BranchPushed':
				to = event.sha;
				break;
		}
	}
	if (from === null) return null;
	return to === null ? { from } : { from, to };
};

const historyOf = ({ info, events }: RunWithEvents): HistoryRun => {
	const format = makeEventFormatter();
	return {
		runId: info.runId,
		command: info.kind === 'ship' ? 'ship run' : `ship ${info.kind}`,
		status: info.status,
		round: info.round,
		createdAt: DateTime.formatIso(info.createdAt),
		updatedAt: DateTime.formatIso(info.updatedAt),
		costUsd: events.reduce(
			(total, event) => (event._tag === 'AgentCost' ? total + event.costUsd : total),
			0
		),
		lines: events.flatMap((event) => format(event) ?? [])
	};
};

/** The failing results of the baseline passes of the latest run that ran checks. */
const preexistingChecksOf = (runs: ReadonlyArray<RunInfo>): ReadonlyArray<PreexistingCheck> => {
	for (const run of runs) {
		if (run.summary === null || !('checks' in run.summary)) continue;
		const baseline = run.summary.checks.filter((pass) => pass.baseline);
		if (baseline.length === 0) continue;
		return baseline
			.flatMap((pass) => pass.results)
			.filter((result) => result.exitCode !== 0)
			.map((result) => ({ name: result.name, outputTail: result.outputTail ?? null }));
	}
	return [];
};

/**
 * The deliverable in full. `runs` are its runs with their events, newest first; `files`
 * are what git says the change touches.
 */
export const detailOf = (
	deliverable: Deliverable,
	runs: ReadonlyArray<RunWithEvents>,
	marks: ArchiveMarks,
	files: ReadonlyArray<ChangedFile> | null
): DeliverableDetail => {
	const events = eventsOf(runs);
	const resolved = new Map<string, VerifiedFinding>();
	const reviewers = new Set<string>();
	let disproved = 0;
	let rounds = 0;
	for (const event of events) {
		switch (event._tag) {
			case 'ReviewStarted':
				rounds += 1;
				for (const reviewer of event.reviewers) reviewers.add(reviewer);
				break;
			case 'FindingsVerified':
				disproved += event.disproved.length;
				break;
			case 'FindingsRechecked':
				for (const { finding, status } of event.findings) {
					if (status === 'fixed') resolved.set(finding.id, finding);
				}
				break;
		}
	}
	const latest = deliverable.runs[0]!;
	return {
		summary: summarize(deliverable, marks),
		findings: openFindings(runs),
		resolved: [...resolved.values()],
		disproved,
		reviewers: [...reviewers],
		rounds,
		preexistingChecks: preexistingChecksOf(deliverable.runs),
		commits: events.flatMap((event) =>
			event._tag === 'CommitCreated' ? [{ sha: event.sha, message: event.message }] : []
		),
		files,
		runs: runs.map(historyOf),
		error: latest.status === 'failed' ? (latest.summary?.error ?? null) : null
	};
};
