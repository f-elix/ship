import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import {
	AgentSdkError,
	BUILTIN_CONVENTIONS_DIR,
	configParseOptions,
	Conventions,
	decodeProjectConfig,
	GlobalConfig,
	isWaitingState,
	Locks,
	Pr,
	ProjectKey,
	REPO_RULES_WIN,
	resolveConfig,
	resumeRun,
	Reviewers,
	RunId,
	RunJournal,
	SessionId,
	ShipHome,
	SnapshotNotResumable,
	startRun,
	statePath,
	type AppendableEvent,
	type PersistedRunSnapshot,
	type ResolvedConfig,
	type RunEvent,
	type RunHandle,
	type RunState
} from '@ship/core';
import {
	AgentFake,
	ChecksFake,
	ClefFake,
	exitCodesByCheck,
	GhFake,
	GitFake,
	type AgentScript,
	type GitFakeShape
} from '@ship/core/testing';
import { RunStore } from '@ship/store';
import {
	Context,
	Deferred,
	Duration,
	Effect,
	Exit,
	Fiber,
	Layer,
	Ref,
	Schema,
	type Scope
} from 'effect';
import { TestClock } from 'effect/testing';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// --- Harness ---

const SECRET = 'ghp_pipeline-secret';
const env = { PATH: '/usr/bin:/bin', GITHUB_TOKEN: SECRET };
const projectKey = ProjectKey.make('github.com/f-elix/example');
const PLAN_DIR = '/plans/feature';

interface Save {
	readonly path: string;
	readonly snapshot: PersistedRunSnapshot;
	readonly events: ReadonlyArray<AppendableEvent>;
}

type OtherKind = { readonly kind: 'review' | 'fix' | 'recheck' };

/** `value`, which must come from a `ship run` rather than a run of another kind. */
const shipRun = <T extends { readonly kind?: 'ship' | OtherKind['kind'] }>(
	value: T | undefined
): Exclude<T, OtherKind> | undefined => {
	if (value?.kind !== undefined && value.kind !== 'ship') {
		throw new Error(`Expected a ship run, got a ${value.kind} run`);
	}
	return value as Exclude<T, OtherKind> | undefined;
};

/** Records what the driver hands the journal, then passes it on to the real store. */
class JournalSpy extends Context.Service<
	JournalSpy,
	{ readonly saves: Effect.Effect<ReadonlyArray<Save>>; readonly resumed: Effect.Effect<number> }
>()('test/JournalSpy') {
	static readonly layer = Layer.effectContext(
		Effect.gen(function* () {
			const store = yield* RunStore;
			const saves = yield* Ref.make<ReadonlyArray<Save>>([]);
			const resumed = yield* Ref.make(0);
			const journal = RunJournal.of({
				...store,
				saveSnapshot: (snapshot, events = []) =>
					Effect.andThen(
						Ref.update(saves, (all) => [
							...all,
							{ path: statePath(snapshot.value), snapshot, events }
						]),
						store.saveSnapshot(snapshot, events)
					),
				markResumed: (runId) =>
					Effect.andThen(
						Ref.update(resumed, (n) => n + 1),
						store.markResumed(runId)
					)
			});
			return Context.empty().pipe(
				Context.add(RunJournal, journal),
				Context.add(JournalSpy, { saves: Ref.get(saves), resumed: Ref.get(resumed) })
			);
		})
	);
}

const REVIEWER = `---
name: standards
conventions: '*'
triggers:
    fileKinds: [source]
---

Checks the project's conventions.
`;

const tempDir = Effect.acquireRelease(
	Effect.promise(() => mkdtemp(join(tmpdir(), 'ship-pipeline-'))),
	(dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
);

const harness = (dir: string, permits: Readonly<Record<string, number>>) => {
	const fakes = Layer.mergeAll(
		AgentFake.layer,
		ClefFake.layer,
		GhFake.layer,
		GitFake.layer(),
		Locks.layer(permits)
	);
	const services = Layer.mergeAll(
		ChecksFake.layer,
		Reviewers.layerWithBriefs(join(dir, 'briefs')),
		Conventions.layer,
		Pr.layer,
		ShipHome.layer(join(dir, 'home'))
	).pipe(Layer.provideMerge(fakes), Layer.provideMerge(NodeServices.layer));
	const journal = Layer.mergeAll(JournalSpy.layer, RunStore.reviews).pipe(
		Layer.provideMerge(RunStore.layerFile(join(dir, 'ship.db')))
	);
	return Layer.mergeAll(services, journal);
};

type Harness = Layer.Success<ReturnType<typeof harness>>;

/** Runs `body` against fresh fakes, a temp run store and temp reviewer briefs. */
const withHarness = <A, E>(
	body: (dir: string) => Effect.Effect<A, E, Harness | Scope.Scope>,
	permits: Readonly<Record<string, number>> = { cpu: 2 }
) =>
	Effect.gen(function* () {
		const dir = yield* tempDir;
		mkdirSync(join(dir, 'briefs/reviewers'), { recursive: true });
		writeFileSync(join(dir, 'briefs/reviewers/standards.md'), REVIEWER);
		writeFileSync(join(dir, 'briefs/verifier.md'), 'You verify findings.\n');
		return yield* body(dir).pipe(Effect.provide(harness(dir, permits)));
	}).pipe(Effect.scoped);

const configWith = (project: Record<string, unknown> = {}) =>
	Effect.map(
		decodeProjectConfig({
			checks: [{ name: 'test', run: 'pnpm test' }],
			reviewers: { clef: false },
			...project
		}),
		(projectConfig): ResolvedConfig =>
			resolveConfig(
				Schema.decodeUnknownSync(GlobalConfig, configParseOptions)({}),
				projectConfig
			)
	).pipe(Effect.orDie);

/** Creates the run in the store and returns its initial state. */
const newRun = (project: Record<string, unknown> = {}) =>
	Effect.gen(function* () {
		const store = yield* RunStore;
		const git = yield* GitFake;
		const { baseSha } = yield* git.state;
		const info = yield* store.create({
			projectKey,
			cwd: '/repo',
			planDir: PLAN_DIR,
			branch: 'feature',
			baseSha
		});
		return {
			runId: info.runId,
			projectKey,
			cwd: '/repo',
			env,
			planDir: PLAN_DIR,
			branch: 'feature',
			baseSha,
			config: yield* configWith(project),
			implementerSession: null,
			round: 0,
			lastReviewedSha: null,
			reviewRounds: [],
			unresolved: { mustFix: [], tradeoffs: [], nits: [] },
			checks: [],
			costUsd: 0,
			prUrl: null,
			escalationReason: null,
			error: null
		} satisfies RunState;
	});

// --- Scripts ---

/** An implementer call that edits `src/<file>` like a real agent would. */
const edits =
	(git: GitFakeShape, file: string, costUsd = 0.5): AgentScript =>
	() =>
		Effect.as(git.edit([{ path: `src/${file}`, status: 'added' }]), { costUsd });

/** An `implement` call that edits `src/<file>` and answers with `output`. */
const implementsWith =
	(git: GitFakeShape, file: string, output: unknown, costUsd = 0.5): AgentScript =>
	() =>
		Effect.as(git.edit([{ path: `src/${file}`, status: 'added' }]), { costUsd, output });

const SUBJECT = 'Add the feature module';

const findingAt = (claim: string, severity: 'must-fix' | 'nit' | 'tradeoff' = 'must-fix') => ({
	file: 'src/feature.ts',
	line: 3,
	severity,
	claim,
	evidence: 'const x = 1;'
});

const reviewerSays = (...findings: ReadonlyArray<ReturnType<typeof findingAt>>) => ({
	output: { findings },
	costUsd: 0.1
});

/** A verifier answer confirming `count` findings, with the statuses of previous ones. */
const verifierSays = (
	count: number,
	previous: ReadonlyArray<{ id: string; status: 'fixed' | 'unfixed'; repeatedBy?: number }> = []
) => ({
	output: {
		verdicts: Array.from({ length: count }, (_, index) => {
			const repeated = previous.find((entry) => entry.repeatedBy === index);
			return {
				index,
				verdict: 'confirmed',
				reason: 'Seen',
				...(repeated === undefined ? {} : { repeats: repeated.id })
			};
		}),
		previous: previous.map(({ id, status }) => ({ id, status, evidence: 'Checked' }))
	},
	costUsd: 0.2
});

const prText = {
	output: { title: 'Add the feature', body: '## Summary\n\nAdds it.' },
	costUsd: 0.05
};

/** Blocks forever once called, after signalling `started`; records an interruption. */
const hangs =
	(started: Deferred.Deferred<void>, interrupted?: Ref.Ref<boolean>): AgentScript =>
	() =>
		Deferred.succeed(started, undefined).pipe(
			Effect.andThen(Effect.never),
			Effect.onInterrupt(() =>
				interrupted === undefined ? Effect.void : Ref.set(interrupted, true)
			)
		);

// --- Assertions ---

const eventsOf = Effect.fnUntraced(function* (runId: RunState['runId']) {
	const store = yield* RunStore;
	return (yield* store.events(runId)).map((envelope) => envelope.event);
});

const transitions = (events: ReadonlyArray<RunEvent | { readonly _tag: 'UnknownEvent' }>) =>
	events.flatMap((event) => (event._tag === 'StateChanged' ? [event.to] : []));

/** Waits until the run's machine is in `path`. */
const reachState = (handle: RunHandle, path: string) =>
	handle.state.pipe(
		Effect.tap(() => Effect.yieldNow),
		Effect.repeat({ until: (current) => current === path, times: 10_000 })
	);

/** Waits until the driver saved the machine in state `path`. */
const savedAt = (path: string) =>
	Effect.gen(function* () {
		const spy = yield* JournalSpy;
		while (!(yield* spy.saves).some((save) => save.path === path)) yield* Effect.yieldNow;
	});

/** Every state change was saved with its snapshot, `StateChanged` last. */
const expectSavedOnEveryStateChange = (saves: ReadonlyArray<Save>) => {
	saves
		.filter((save) => save.events.some((event) => event._tag === 'StateChanged'))
		.forEach((save) => {
			const last = save.events.at(-1);
			expect(last?._tag).toBe('StateChanged');
			expect(last?._tag === 'StateChanged' ? last.to : null).toBe(save.path);
		});
};

/** Every table row in the database file, as text. */
const dumpDatabase = (file: string): string => {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all()
			.map((row) => String(row['name']));
		return JSON.stringify(tables.map((table) => db.prepare(`SELECT * FROM "${table}"`).all()));
	} finally {
		db.close();
	}
};

// --- Tests ---

describe('pipeline', () => {
	it.effect('runs from baseline to a PR and saves a snapshot on every state change', () =>
		withHarness((dir) =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const gh = yield* GhFake;
				const spy = yield* JournalSpy;
				yield* agent.script(
					{ step: 'implement' },
					implementsWith(git, 'feature.ts', { commitSubject: SUBJECT })
				);
				yield* agent.script({ step: 'review', label: 'standards' }, reviewerSays());
				yield* agent.script({ step: 'pr' }, prText);
				const state = yield* newRun();

				const handle = yield* startRun(state);
				const summary = yield* handle.await;

				expect(summary).toMatchObject({
					status: 'done',
					prUrl: 'https://github.com/f-elix/example/pull/1',
					rounds: 1,
					costUsd: 0.65,
					unresolvedMustFix: [],
					escalationReason: null,
					error: null
				});
				expect(
					shipRun(summary)?.checks.map((pass) => [
						pass.baseline,
						pass.round,
						pass.attempt
					])
				).toEqual([
					[true, 0, 0],
					[false, 0, 0]
				]);
				const events = yield* eventsOf(state.runId);
				expect(transitions(events)).toEqual([
					'implement',
					'checks.running',
					'review',
					'triage',
					'pr',
					'done'
				]);
				expect(events.at(-1)?._tag).toBe('RunFinished');
				expect((yield* gh.prs).map((pr) => pr.draft)).toEqual([true]);
				const repo = yield* git.state;
				expect(repo.pushes).toEqual(['feature']);
				expect(repo.excluded).toEqual([PLAN_DIR]);
				// The round-0 commit takes the implementer's subject.
				expect(repo.commits.map((commit) => commit.message)).toEqual([SUBJECT]);
				expect((yield* agent.calls)[0]?.prompt).toContain('commitSubject');

				const saves = yield* spy.saves;
				expectSavedOnEveryStateChange(saves);
				// The log and the machine's own state agree on what the summary reports.
				const final = shipRun(saves.at(-1)?.snapshot.context);
				expect(final?.costUsd).toBeCloseTo(summary.costUsd);
				expect(final?.checks).toEqual(summary.checks);
				expect(final?.prUrl).toBe(summary.prUrl);
				expect(final?.implementerSession?.sessionId).toBe('fake-session-1');
				expect(final?.commitSubject).toBe(SUBJECT);
				const info = yield* (yield* RunStore).get(state.runId);
				expect(info).toMatchObject({ status: 'done', state: 'done', summary });
				// The caller's env never reaches the database.
				expect(dumpDatabase(join(dir, 'ship.db'))).not.toContain(SECRET);
			})
		)
	);

	it.effect('gives the implementer and the reviewers the conventions that apply', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				yield* git.update((repo) => ({ ...repo, trackedFiles: ['tsconfig.json'] }));
				yield* agent.script(
					{ step: 'implement' },
					implementsWith(git, 'feature.ts', { commitSubject: SUBJECT })
				);
				yield* agent.script({ step: 'review', label: 'standards' }, reviewerSays());
				yield* agent.script({ step: 'pr' }, prText);
				const state = yield* newRun();

				const summary = yield* Effect.flatMap(startRun(state), (h) => h.await);
				expect(summary.status).toBe('done');

				const calls = yield* agent.calls;
				const implement = calls.find((call) => call.step === 'implement');
				const review = calls.find((call) => call.step === 'review');
				for (const call of [implement, review]) {
					expect(call?.additionalDirectories).toContain(BUILTIN_CONVENTIONS_DIR);
					expect(call?.prompt).toContain(`- ${BUILTIN_CONVENTIONS_DIR}/typescript.md`);
					expect(call?.prompt).toContain(REPO_RULES_WIN);
					// Not in the repo's stack.
					expect(call?.prompt).not.toContain(`${BUILTIN_CONVENTIONS_DIR}/effect.md`);
				}
				expect(implement?.prompt).toContain(
					`- ${BUILTIN_CONVENTIONS_DIR}/references/codebase-design/SKILL.md`
				);
				expect(implement?.prompt).not.toContain('.details.md');
				expect(implement?.prompt).not.toContain('software-design-philosophy');
				expect(review?.prompt).not.toContain('references/');
			})
		)
	);

	it.effect('goes on after a failing baseline, holding the change only to the other checks', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				yield* (yield* ChecksFake).respond(yield* exitCodesByCheck({ test: [1, 1] }));
				yield* agent.script(
					{ step: 'implement' },
					implementsWith(git, 'feature.ts', { commitSubject: SUBJECT })
				);
				yield* agent.script({ step: 'review', label: 'standards' }, reviewerSays());
				yield* agent.script({ step: 'pr' }, prText);
				const state = yield* newRun();

				const summary = yield* Effect.flatMap(startRun(state), (h) => h.await);

				expect(summary.status).toBe('done');
				expect(
					shipRun(summary)?.checks.map((pass) => [
						pass.baseline,
						pass.results.map((result) => result.exitCode)
					])
				).toEqual([
					[true, [1]],
					[false, [1]]
				]);
				// `test` failed before the change, so nobody was asked to fix it.
				expect((yield* agent.calls).map((call) => call.step)).not.toContain('fixChecks');
				expect((yield* git.state).commits.map((commit) => commit.message)).toEqual([
					SUBJECT
				]);
			})
		)
	);

	it.effect('keeps the session and cost of a failed implementer call', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const spy = yield* JournalSpy;
				const session = {
					sessionId: SessionId.make('failed-session'),
					cumulativeCostUsd: 0.4
				};
				yield* agent.script(
					{ step: 'implement' },
					new AgentSdkError({
						step: 'implement',
						reason: 'error_max_turns',
						detail: 'Ran out of turns',
						spend: {
							session,
							cost: {
								step: 'implement',
								model: 'opus',
								sessionId: session.sessionId,
								costUsd: 0.4
							}
						}
					})
				);
				const state = yield* newRun();

				const summary = yield* Effect.flatMap(startRun(state), (h) => h.await);

				expect(summary).toMatchObject({ status: 'failed', costUsd: 0.4 });
				expect(summary.error).toContain('Ran out of turns');
				const final = shipRun((yield* spy.saves).at(-1)?.snapshot.context);
				expect(final?.implementerSession).toEqual(session);
				expect(final?.costUsd).toBeCloseTo(0.4);
			})
		)
	);

	it.effect('fails when the tree is dirty at the start', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const git = yield* GitFake;
				const checks = yield* ChecksFake;
				yield* git.update((repo) => ({ ...repo, dirty: true }));
				const state = yield* newRun();

				const summary = yield* Effect.flatMap(startRun(state), (h) => h.await);

				expect(summary.status).toBe('failed');
				expect(summary.error).toContain('uncommitted changes');
				expect(yield* checks.calls).toEqual([]);
			})
		)
	);

	it.effect('escalates with a draft PR once check fixes are exhausted', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const gh = yield* GhFake;
				const checks = yield* ChecksFake;
				yield* checks.respond(yield* exitCodesByCheck({ test: [0, 1, 1] }));
				yield* agent.script({ step: 'implement' }, edits(git, 'feature.ts'));
				yield* agent.script({ step: 'fixChecks' }, edits(git, 'feature.ts', 0.25));
				yield* agent.script({ step: 'escalate' }, prText);
				const state = yield* newRun({ caps: { checkFixAttempts: 1 } });

				const summary = yield* Effect.flatMap(startRun(state), (h) => h.await);

				expect(summary).toMatchObject({
					status: 'escalated',
					escalationReason: 'check-fix-cap',
					prUrl: 'https://github.com/f-elix/example/pull/1',
					costUsd: 0.8
				});
				expect(summary.checks.map((pass) => pass.attempt)).toEqual([0, 0, 1]);
				expect((yield* gh.prs).map((pr) => pr.draft)).toEqual([true]);
				const calls = yield* agent.calls;
				// The check fix ran inside `checks`, resuming the implementer's session.
				expect(calls.find((call) => call.step === 'fixChecks')?.resume?.sessionId).toBe(
					'fake-session-1'
				);
				expect(calls.find((call) => call.step === 'fixChecks')?.prompt).toContain(
					'test failed'
				);
				// The unfinished work was committed, then squashed into one commit.
				expect((yield* git.state).commits.map((commit) => commit.message)).toEqual([
					'Implement feature'
				]);
				expect(transitions(yield* eventsOf(state.runId))).toEqual([
					'implement',
					'checks.running',
					'escalate',
					'escalated'
				]);
			})
		)
	);

	it.effect('loops through a fix and escalates at the review cap', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				yield* agent.script(
					{ step: 'implement' },
					implementsWith(git, 'feature.ts', { commitSubject: SUBJECT })
				);
				yield* agent.script(
					{ step: 'review', label: 'standards' },
					reviewerSays(findingAt('Off by one')),
					reviewerSays(findingAt('Wrong unit'))
				);
				yield* agent.script(
					{ step: 'verify' },
					{
						output: {
							verdicts: [{ index: 0, verdict: 'confirmed', reason: 'Seen' }],
							previous: []
						},
						costUsd: 0.2
					},
					{
						output: {
							verdicts: [{ index: 0, verdict: 'confirmed', reason: 'Seen' }],
							previous: [
								{ id: 'r1-1', status: 'fixed', evidence: 'Loop bound fixed' }
							]
						},
						costUsd: 0.2
					}
				);
				yield* agent.script({ step: 'fix' }, edits(git, 'feature.ts', 0.25));
				yield* agent.script({ step: 'escalate' }, prText);
				const state = yield* newRun({ caps: { reviewRounds: 2 } });

				const summary = yield* Effect.flatMap(startRun(state), (h) => h.await);

				expect(summary).toMatchObject({
					status: 'escalated',
					escalationReason: 'review-cap',
					rounds: 2
				});
				expect(
					summary.unresolvedMustFix.map((finding) => [finding.id, finding.claim])
				).toEqual([['r2-1', 'Wrong unit']]);
				const fix = (yield* agent.calls).find((call) => call.step === 'fix');
				expect(fix?.prompt).toContain('Off by one');
				expect(fix?.resume?.sessionId).toBe('fake-session-1');
				expect(transitions(yield* eventsOf(state.runId))).toEqual([
					'implement',
					'checks.running',
					'review',
					'triage',
					'fix',
					'checks.running',
					'review',
					'triage',
					'escalate',
					'escalated'
				]);
				// The fix round kept its own message; the squash left the implementer's subject.
				const events = yield* eventsOf(state.runId);
				expect(
					events.flatMap((event) =>
						event._tag === 'CommitCreated' ? [event.message] : []
					)
				).toEqual([SUBJECT, 'Address review round 1 findings']);
				const commits = (yield* git.state).commits.map((commit) => commit.message);
				expect(commits).toEqual([SUBJECT]);
			})
		)
	);

	it.effect('opens a PR when only tradeoffs remain, listing them in its body', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				yield* agent.script({ step: 'implement' }, edits(git, 'feature.ts'));
				yield* agent.script(
					{ step: 'review', label: 'standards' },
					reviewerSays(findingAt('One query per row', 'tradeoff'))
				);
				yield* agent.script({ step: 'verify' }, verifierSays(1));
				yield* agent.script({ step: 'pr' }, prText);
				const state = yield* newRun();

				const summary = yield* Effect.flatMap(startRun(state), (h) => h.await);

				expect(summary).toMatchObject({ status: 'done', rounds: 1 });
				expect(summary.tradeoffs.map((finding) => finding.claim)).toEqual([
					'One query per row'
				]);
				expect((yield* agent.calls).some((call) => call.step === 'fix')).toBe(false);
				const [pr] = yield* (yield* GhFake).prs;
				expect(pr?.body).toContain('## Tradeoffs');
				expect(pr?.body).toContain('One query per row');
			})
		)
	);

	it.effect('fixes nits, and a nit the fix did not resolve is not a stall', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				yield* agent.script({ step: 'implement' }, edits(git, 'feature.ts'));
				yield* agent.script(
					{ step: 'review', label: 'standards' },
					reviewerSays(findingAt('Unclear name', 'nit')),
					reviewerSays(findingAt('Still an unclear name', 'nit')),
					reviewerSays()
				);
				yield* agent.script(
					{ step: 'verify' },
					verifierSays(1),
					verifierSays(1, [{ id: 'r1-1', status: 'unfixed', repeatedBy: 0 }]),
					verifierSays(0, [{ id: 'r2-1', status: 'fixed' }])
				);
				yield* agent.script(
					{ step: 'fix' },
					edits(git, 'feature.ts', 0.25),
					edits(git, 'feature.ts', 0.25)
				);
				yield* agent.script({ step: 'pr' }, prText);
				const state = yield* newRun();

				const summary = yield* Effect.flatMap(startRun(state), (h) => h.await);

				expect(summary).toMatchObject({ status: 'done', rounds: 3 });
				const fix = (yield* agent.calls).find((call) => call.step === 'fix');
				expect(fix?.prompt).toContain('# Nits');
				expect(fix?.prompt).toContain('Unclear name');
			})
		)
	);

	it.effect(
		'reviews the whole branch again with the reviewers the fix touched and those with a must-fix',
		() =>
			withHarness((dir) =>
				Effect.gen(function* () {
					const docsReviewer = (name: string) =>
						`---\nname: ${name}\ntriggers:\n    paths: ['docs/**']\n---\n\nThe ${name} brief.\n`;
					writeFileSync(join(dir, 'briefs/reviewers/docs.md'), docsReviewer('docs'));
					writeFileSync(join(dir, 'briefs/reviewers/links.md'), docsReviewer('links'));
					const agent = yield* AgentFake;
					const git = yield* GitFake;
					yield* agent.script({ step: 'implement' }, () =>
						Effect.as(
							git.edit([
								{ path: 'src/feature.ts', status: 'added' },
								{ path: 'docs/guide.md', status: 'added' }
							]),
							{ costUsd: 0.5 }
						)
					);
					yield* agent.script(
						{ step: 'review', label: 'docs' },
						reviewerSays({ ...findingAt('Wrong flag'), file: 'docs/guide.md' }),
						reviewerSays()
					);
					yield* agent.script({ step: 'review', label: 'links' }, reviewerSays());
					yield* agent.script(
						{ step: 'review', label: 'standards' },
						reviewerSays(),
						reviewerSays()
					);
					yield* agent.script(
						{ step: 'verify' },
						verifierSays(1),
						verifierSays(0, [{ id: 'r1-1', status: 'fixed' }])
					);
					// The fix touches source only, so the docs triggers no longer match its range.
					yield* agent.script({ step: 'fix' }, () =>
						Effect.as(
							Effect.andThen(
								git.update((current) => ({ ...current, changedFiles: [] })),
								git.edit([{ path: 'src/feature.ts', status: 'modified' }])
							),
							{ costUsd: 0.25 }
						)
					);
					yield* agent.script({ step: 'pr' }, prText);
					const state = yield* newRun();

					const summary = yield* Effect.flatMap(startRun(state), (h) => h.await);

					expect(summary).toMatchObject({ status: 'done', rounds: 2 });
					const started = (yield* eventsOf(state.runId)).flatMap((event) =>
						event._tag === 'ReviewStarted' ? [event] : []
					);
					expect(
						started.map((event) => [event.round, event.fromSha, event.reviewers])
					).toEqual([
						[1, state.baseSha, ['docs', 'links', 'standards']],
						[2, state.baseSha, ['docs', 'standards']]
					]);
				})
			)
	);

	it.effect('falls back to the default commit message when the subject is invalid', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const spy = yield* JournalSpy;
				yield* agent.script(
					{ step: 'implement' },
					implementsWith(git, 'feature.ts', { commitSubject: 'Add the feature.' })
				);
				yield* agent.script({ step: 'review', label: 'standards' }, reviewerSays());
				yield* agent.script({ step: 'pr' }, prText);
				const state = yield* newRun();

				const summary = yield* Effect.flatMap(startRun(state), (h) => h.await);

				// The call is still billed and its session kept; only the subject is dropped.
				expect(summary).toMatchObject({ status: 'done', costUsd: 0.65 });
				expect((yield* git.state).commits.map((commit) => commit.message)).toEqual([
					'Implement feature'
				]);
				const final = shipRun((yield* spy.saves).at(-1)?.snapshot.context);
				expect(final?.implementerSession?.sessionId).toBe('fake-session-1');
				expect(final).not.toHaveProperty('commitSubject');
			})
		)
	);

	it.effect('falls back to the default commit message when the subject is too long', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				yield* agent.script(
					{ step: 'implement' },
					implementsWith(git, 'feature.ts', { commitSubject: 'A'.repeat(73) })
				);
				yield* agent.script({ step: 'review', label: 'standards' }, reviewerSays());
				yield* agent.script({ step: 'pr' }, prText);
				const state = yield* newRun();

				const summary = yield* Effect.flatMap(startRun(state), (h) => h.await);

				expect(summary.status).toBe('done');
				expect((yield* git.state).commits.map((commit) => commit.message)).toEqual([
					'Implement feature'
				]);
			})
		)
	);

	it.effect('escalates on a stall: a must-fix finding the fix did not resolve', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				yield* agent.script({ step: 'implement' }, edits(git, 'feature.ts'));
				yield* agent.script(
					{ step: 'review', label: 'standards' },
					reviewerSays(findingAt('Off by one')),
					reviewerSays(findingAt('Still off by one'))
				);
				yield* agent.script(
					{ step: 'verify' },
					{
						output: {
							verdicts: [{ index: 0, verdict: 'confirmed', reason: 'Seen' }],
							previous: []
						},
						costUsd: 0.2
					},
					{
						output: {
							verdicts: [
								{ index: 0, verdict: 'confirmed', reason: 'Same', repeats: 'r1-1' }
							],
							previous: [
								{ id: 'r1-1', status: 'unfixed', evidence: 'Bound unchanged' }
							]
						},
						costUsd: 0.2
					}
				);
				yield* agent.script({ step: 'fix' }, edits(git, 'feature.ts', 0.25));
				yield* agent.script({ step: 'escalate' }, prText);
				const state = yield* newRun();

				const summary = yield* Effect.flatMap(startRun(state), (h) => h.await);

				expect(summary).toMatchObject({
					status: 'escalated',
					escalationReason: 'stall',
					rounds: 2
				});
				expect(summary.unresolvedMustFix.map((finding) => finding.repeats)).toEqual([
					'r1-1'
				]);
			})
		)
	);

	it.effect('escalates when a step times out after the run committed work', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const gh = yield* GhFake;
				const started = yield* Deferred.make<void>();
				yield* agent.script({ step: 'implement' }, edits(git, 'feature.ts'));
				yield* agent.script(
					{ step: 'review', label: 'standards' },
					reviewerSays(findingAt('Off by one'))
				);
				yield* agent.script(
					{ step: 'verify' },
					{ output: { verdicts: [], previous: [] }, costUsd: 0.2 }
				);
				yield* agent.script({ step: 'fix' }, hangs(started));
				yield* agent.script({ step: 'escalate' }, prText);
				const state = yield* newRun();

				const handle = yield* startRun(state);
				yield* Deferred.await(started);
				yield* TestClock.adjust(Duration.millis(state.config.timeouts.fix));
				const summary = yield* handle.await;

				expect(summary).toMatchObject({ status: 'escalated', escalationReason: 'timeout' });
				expect((yield* gh.prs).map((pr) => pr.draft)).toEqual([true]);
				const ended = (yield* eventsOf(state.runId)).filter(
					(event) => event._tag === 'StepEnded' && event.step === 'fix'
				);
				expect(ended).toMatchObject([{ outcome: 'timed-out' }]);
			})
		)
	);

	it.effect('fails when a step times out before the run committed anything', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const gh = yield* GhFake;
				const started = yield* Deferred.make<void>();
				yield* agent.script({ step: 'implement' }, hangs(started));
				const state = yield* newRun();

				const handle = yield* startRun(state);
				yield* Deferred.await(started);
				yield* TestClock.adjust(Duration.millis(state.config.timeouts.implement));
				const summary = yield* handle.await;

				expect(summary.status).toBe('failed');
				expect(summary.error).toContain('timed out');
				expect(yield* gh.prs).toEqual([]);
			})
		)
	);

	it.effect('cancels mid-step, interrupting the agent', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const started = yield* Deferred.make<void>();
				const interrupted = yield* Ref.make(false);
				yield* agent.script({ step: 'implement' }, hangs(started, interrupted));
				const state = yield* newRun();

				const handle = yield* startRun(state);
				yield* Deferred.await(started);
				yield* handle.cancel;
				const summary = yield* handle.await;

				expect(summary.status).toBe('cancelled');
				expect(yield* Ref.get(interrupted)).toBe(true);
				const events = yield* eventsOf(state.runId);
				expect(transitions(events)).toEqual(['implement', 'cancelled']);
				// Leaving the state interrupts the step before the transition is saved.
				expect(events.map((event) => event._tag).slice(-4)).toEqual([
					'StepEnded',
					'StateChanged',
					'RunCancelled',
					'RunFinished'
				]);
				expect(events.at(-4)).toMatchObject({ step: 'implement', outcome: 'interrupted' });
				expect((yield* (yield* RunStore).get(state.runId)).status).toBe('cancelled');
			})
		)
	);

	it.effect('resumes a check fix without re-running the check pass before it', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const checks = yield* ChecksFake;
				const store = yield* RunStore;
				const started = yield* Deferred.make<void>();
				// Baseline passes, the round's first pass fails, the pass after the fix passes.
				yield* checks.respond(yield* exitCodesByCheck({ test: [0, 1, 0] }));
				yield* agent.script({ step: 'implement' }, edits(git, 'feature.ts'));
				yield* agent.script(
					{ step: 'fixChecks' },
					hangs(started),
					edits(git, 'feature.ts', 0.25)
				);
				yield* agent.script({ step: 'review', label: 'standards' }, reviewerSays());
				yield* agent.script({ step: 'pr' }, prText);
				const state = yield* newRun({ caps: { checkFixAttempts: 1 } });

				// The daemon stops while the check fix runs.
				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* startRun(state);
						yield* Deferred.await(started);
					})
				);
				expect(yield* store.markInterrupted).toEqual([state.runId]);

				const summary = yield* Effect.flatMap(
					resumeRun(state.runId, env),
					(handle) => handle.await
				);

				// The failed pass is not run again, and the fix still counts as the one allowed:
				// a resumed run that forgot it would have passed without a fix, or fixed twice.
				expect(summary.status).toBe('done');
				expect((yield* checks.calls).filter((call) => call.kind === 'run')).toHaveLength(3);
				expect(
					(yield* agent.calls).filter((call) => call.step === 'fixChecks')
				).toHaveLength(2);
				expect(
					shipRun(summary)?.checks.map((pass) => [
						pass.baseline,
						pass.attempt,
						pass.results[0]?.exitCode
					])
				).toEqual([
					[true, 0, 0],
					[false, 0, 1],
					[false, 1, 0]
				]);
			})
		)
	);

	it.effect('resumes mid-step, re-running only the step in flight with the fresh env', () =>
		withHarness((dir) =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const checks = yield* ChecksFake;
				const store = yield* RunStore;
				const spy = yield* JournalSpy;
				const started = yield* Deferred.make<void>();
				yield* agent.script(
					{ step: 'implement' },
					hangs(started),
					edits(git, 'feature.ts')
				);
				yield* agent.script({ step: 'review', label: 'standards' }, reviewerSays());
				yield* agent.script({ step: 'pr' }, prText);
				const state = yield* newRun();

				// The daemon stops mid-implement: the run's scope closes without finishing it.
				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* startRun(state);
						yield* Deferred.await(started);
						yield* savedAt('implement');
					})
				);
				expect(yield* store.markInterrupted).toEqual([state.runId]);
				expect(dumpDatabase(join(dir, 'ship.db'))).not.toContain(SECRET);

				const freshEnv = { PATH: '/opt/bin', GITHUB_TOKEN: 'ghp_fresh' };
				const handle = yield* resumeRun(state.runId, freshEnv);
				const summary = yield* handle.await;

				expect(summary.status).toBe('done');
				expect(yield* spy.resumed).toBe(1);
				const implementCalls = (yield* agent.calls).filter(
					(call) => call.step === 'implement'
				);
				expect(implementCalls.map((call) => call.env)).toEqual([env, freshEnv]);
				// The baseline ran once, before the stop; after resuming only the round's checks ran.
				expect((yield* checks.calls).map((call) => call.env)).toEqual([env, freshEnv]);
				const events = yield* eventsOf(state.runId);
				expect(
					events
						.filter((event) => event._tag === 'StepStarted')
						.map((event) => event.step)
				).toEqual([
					'baseline',
					'implement',
					'implement',
					'checks',
					'review',
					'triage',
					'pr'
				]);
				expect(events.map((event) => event._tag)).toContain('RunResumed');
				// The interrupted attempt's end was saved before the run was marked interrupted.
				expect(
					events
						.filter((event) => event._tag === 'StepEnded' && event.step === 'implement')
						.map((event) => (event._tag === 'StepEnded' ? event.outcome : null))
				).toEqual(['interrupted', 'ok']);
				expect(shipRun(summary)?.checks).toHaveLength(2);
				expect(dumpDatabase(join(dir, 'ship.db'))).not.toContain('ghp_fresh');
			})
		)
	);

	it.effect('re-runs a step that finished before the machine took its result', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const checks = yield* ChecksFake;
				const store = yield* RunStore;
				const spy = yield* JournalSpy;
				const started = yield* Deferred.make<void>();
				yield* agent.script(
					{ step: 'implement' },
					hangs(started),
					edits(git, 'feature.ts')
				);
				yield* agent.script({ step: 'review', label: 'standards' }, reviewerSays());
				yield* agent.script({ step: 'pr' }, prText);
				const state = yield* newRun();

				// Stopping as soon as `implement` starts leaves the baseline actor saved as done
				// while the machine is still in `baseline`.
				yield* Effect.scoped(Effect.andThen(startRun(state), Deferred.await(started)));
				const last = (yield* spy.saves).at(-1);
				expect(last?.path).toBe('baseline.running');
				expect(JSON.stringify(last?.snapshot['children'])).toContain('"status":"done"');
				yield* store.markInterrupted;

				const summary = yield* Effect.flatMap(resumeRun(state.runId, env), (h) => h.await);

				expect(summary.status).toBe('done');
				expect((yield* checks.calls).length).toBe(3);
			})
		)
	);

	it.effect('finishes a run that stopped after reaching its final state', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const git = yield* GitFake;
				const store = yield* RunStore;
				const spy = yield* JournalSpy;
				yield* agent.script({ step: 'implement' }, edits(git, 'feature.ts'));
				yield* agent.script({ step: 'review', label: 'standards' }, reviewerSays());
				yield* agent.script({ step: 'pr' }, prText);
				const state = yield* newRun();
				const finished = yield* Effect.flatMap(startRun(state), (h) => h.await);
				// Replay the stop: the final snapshot is saved, but the run was never finished.
				const final = (yield* spy.saves).at(-1);
				const other = yield* newRun();
				yield* store.saveSnapshot({
					...(final?.snapshot ?? { value: null, context: state }),
					context: { ...(final?.snapshot.context ?? state), runId: other.runId }
				});
				yield* store.markInterrupted;

				const summary = yield* Effect.flatMap(resumeRun(other.runId, env), (h) => h.await);

				expect(summary.status).toBe('done');
				expect(yield* spy.resumed).toBe(1);
				expect((yield* store.get(other.runId)).status).toBe('done');
				expect(finished.status).toBe('done');
			})
		)
	);

	it.effect('stops the machine when the journal fails', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const agent = yield* AgentFake;
				const gh = yield* GhFake;
				const state = yield* newRun();
				const unknown = { ...state, runId: RunId.make('19700101-000000-000000') };

				const git = yield* GitFake;
				yield* agent.script({ step: 'implement' }, edits(git, 'feature.ts'));
				yield* agent.script({ step: 'review', label: 'standards' }, reviewerSays());
				yield* agent.script({ step: 'pr' }, prText);

				const exit = yield* Effect.exit(Effect.flatMap(startRun(unknown), (h) => h.await));
				// Give a machine that kept going the time to reach its PR.
				yield* Effect.sleep('50 millis').pipe(TestClock.withLive);

				expect(Exit.isFailure(exit)).toBe(true);
				expect(yield* agent.calls).toEqual([]);
				expect(yield* gh.prs).toEqual([]);
			})
		)
	);

	it.effect('leaves a run without a usable snapshot interrupted', () =>
		withHarness(() =>
			Effect.gen(function* () {
				const store = yield* RunStore;
				const spy = yield* JournalSpy;
				const state = yield* newRun();
				yield* store.markInterrupted;

				const error = yield* Effect.flip(resumeRun(state.runId, env));

				expect(error).toBeInstanceOf(SnapshotNotResumable);
				expect(yield* spy.resumed).toBe(0);
				expect((yield* store.get(state.runId)).status).toBe('interrupted');
			})
		)
	);

	it.effect('waits in checks.waiting while another run holds the lock', () =>
		withHarness(
			() =>
				Effect.gen(function* () {
					const agent = yield* AgentFake;
					const git = yield* GitFake;
					const locks = yield* Locks;
					const gate = yield* Deferred.make<void>();
					const held = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					// The implementer finishes only once another run holds the only cpu permit.
					yield* agent.script({ step: 'implement' }, () =>
						Effect.andThen(
							Deferred.await(gate),
							Effect.as(git.edit([{ path: 'src/feature.ts', status: 'added' }]), {
								costUsd: 0.5
							})
						)
					);
					yield* agent.script({ step: 'review', label: 'standards' }, reviewerSays());
					yield* agent.script({ step: 'pr' }, prText);
					const state = yield* newRun();

					const handle = yield* startRun(state);
					yield* savedAt('implement');
					const holder = yield* locks
						.withPermit(
							'cpu',
							Effect.andThen(
								Deferred.succeed(held, undefined),
								Deferred.await(release)
							)
						)
						.pipe(Effect.forkChild);
					yield* Deferred.await(held);
					yield* Deferred.succeed(gate, undefined);
					yield* reachState(handle, 'checks.waiting');
					expect(isWaitingState(yield* handle.state)).toBe(true);
					yield* Deferred.succeed(release, undefined);
					yield* Fiber.join(holder);
					const summary = yield* handle.await;

					expect(summary.status).toBe('done');
					const events = yield* eventsOf(state.runId);
					expect(transitions(events).slice(0, 4)).toEqual([
						'implement',
						'checks.running',
						'checks.waiting',
						'checks.running'
					]);
					expect(events.map((event) => event._tag)).toContain('LockWaiting');
				}),
			{ cpu: 1 }
		)
	);
});
