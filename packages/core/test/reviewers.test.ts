import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Ref, Schema } from 'effect';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
	AgentOutputMismatch,
	AgentSdkError,
	BUILTIN_BRIEFS_DIR,
	ChangeIntent,
	ClefError,
	FindingId,
	reviewChanges,
	Reviewers,
	ReviewerTriggers,
	type Finding,
	type ReviewDelta,
	type ReviewerDef,
	type ReviewSubject,
	type VerifiedFinding
} from '../src/index.ts';
import { AgentFake, ClefFake, fakeSha, GitFake } from '../src/testing.ts';
import { tempDir } from './temp-repo.ts';

const reviewerFile = (name: string, triggers: string, brief = `The ${name} brief.`) =>
	`---\nname: ${name}\ntriggers:\n${triggers}\n---\n${brief}\n`;

const writeFiles = (dir: string, files: Record<string, string>) => {
	mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(files)) writeFileSync(`${dir}/${name}`, text);
};

/** A briefs dir with three built-in reviewers and a verifier brief. */
const briefsDir = Effect.gen(function* () {
	const dir = yield* tempDir;
	writeFiles(`${dir}/reviewers`, {
		'standards.md': reviewerFile('standards', '  always: true'),
		'tests.md': reviewerFile('tests', '  fileKinds: [source, test]'),
		'design.md': reviewerFile(
			'design',
			'  paths: []',
			'Checks module boundaries.\n\nMore detail.'
		)
	});
	writeFiles(dir, { 'verifier.md': 'You verify findings.' });
	return dir;
});

const withReviewers = <A, E>(
	f: (dir: string) => Effect.Effect<A, E, Reviewers | AgentFake | ClefFake>
) =>
	Effect.gen(function* () {
		const dir = yield* briefsDir;
		return yield* f(dir).pipe(
			Effect.provide(
				Reviewers.layerWithBriefs(dir).pipe(
					Layer.provideMerge(Layer.mergeAll(AgentFake.layer, ClefFake.layer)),
					Layer.provide(NodeServices.layer)
				)
			)
		);
	}).pipe(Effect.scoped);

const def = (
	name: string,
	triggers: Partial<typeof ReviewerTriggers.Encoded>,
	model?: string
): ReviewerDef => ({
	name,
	triggers: Schema.decodeUnknownSync(ReviewerTriggers)(triggers),
	brief: `The ${name} brief.`,
	...(model === undefined ? {} : { model })
});

const context = { cwd: '/repo', env: { PATH: '/bin' } };

const subject: ReviewSubject = {
	diff: 'diff --git a/src/a.ts b/src/a.ts\n+const a = 1;',
	commits: [{ sha: fakeSha(1), subject: 'Add a' }],
	intent: ChangeIntent.Plan({
		specPath: '/plans/feature/spec.md',
		planPath: '/plans/feature/implementation-plan.md'
	}),
	conventions: { dir: '/conventions', topics: [] }
};

const sourceChange: ReviewDelta = {
	diff: subject.diff,
	commits: subject.commits,
	files: [{ path: 'src/a.ts', status: 'modified' }],
	addedLines: { 'src/a.ts': ['const a = 1;'] }
};

describe('Reviewers.load', () => {
	it.effect('loads built-ins, applies disable, and lets project files override', () =>
		withReviewers((dir) =>
			Effect.gen(function* () {
				const projectDir = `${dir}/project`;
				writeFiles(projectDir, {
					'tests.md': reviewerFile('tests', '  always: true', 'Project tests brief.'),
					'migrations.md': reviewerFile('migrations', "  paths: ['db/**']"),
					'notes.txt': 'ignored'
				});
				const reviewers = yield* Reviewers;
				const loaded = yield* reviewers.load({ projectDir, disable: ['design'] });
				expect(loaded.map((reviewer) => reviewer.name)).toEqual([
					'migrations',
					'standards',
					'tests'
				]);
				expect(loaded.find((reviewer) => reviewer.name === 'tests')?.brief).toBe(
					'Project tests brief.'
				);
			})
		)
	);

	it.effect('applies disable to built-ins only', () =>
		withReviewers((dir) =>
			Effect.gen(function* () {
				const projectDir = `${dir}/project`;
				writeFiles(projectDir, { 'design.md': reviewerFile('design', '  always: true') });
				const loaded = yield* (yield* Reviewers).load({ projectDir, disable: ['design'] });
				expect(loaded.map((reviewer) => reviewer.name)).toEqual([
					'design',
					'standards',
					'tests'
				]);
			})
		)
	);

	it.effect('works without a project dir and fails on an invalid project file', () =>
		withReviewers((dir) =>
			Effect.gen(function* () {
				const reviewers = yield* Reviewers;
				const loaded = yield* reviewers.load({ projectDir: `${dir}/missing`, disable: [] });
				expect(loaded).toHaveLength(3);

				writeFiles(`${dir}/bad`, { 'broken.md': 'no frontmatter' });
				const error = yield* Effect.flip(
					reviewers.load({ projectDir: `${dir}/bad`, disable: [] })
				);
				expect(error).toMatchObject({
					_tag: 'ReviewerFileError',
					path: `${dir}/bad/broken.md`
				});
			})
		)
	);

	it.effect('fails when the built-in reviewers are missing', () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const error = yield* Effect.gen(function* () {
				return yield* Effect.flip(
					(yield* Reviewers).load({ projectDir: '/nonexistent', disable: [] })
				);
			}).pipe(
				Effect.provide(
					Reviewers.layerWithBriefs(dir).pipe(
						Layer.provide([AgentFake.layer, ClefFake.layer]),
						Layer.provide(NodeServices.layer)
					)
				)
			);
			expect(error).toMatchObject({ _tag: 'ReviewerFileError', path: `${dir}/reviewers` });
		}).pipe(Effect.scoped)
	);

	it.effect('loads the built-in reviewers shipped with the package', () =>
		Effect.gen(function* () {
			const reviewers = yield* Reviewers;
			const loaded = yield* reviewers.load({ projectDir: '/nonexistent', disable: [] });
			expect(loaded.map((reviewer) => reviewer.name)).toEqual(
				expect.arrayContaining(['standards', 'tests'])
			);
			expect(existsSync(`${BUILTIN_BRIEFS_DIR}/verifier.md`)).toBe(true);
		}).pipe(
			Effect.provide(
				Reviewers.layer.pipe(
					Layer.provide([AgentFake.layer, ClefFake.layer]),
					Layer.provide(NodeServices.layer)
				)
			)
		)
	);
});

describe('Reviewers.route', () => {
	const all = [
		def('standards', { always: true }),
		def('tests', { fileKinds: ['source'] }),
		def('design', {}),
		def('security', { addedLines: ['token'] })
	];
	const clef = { credentials: { accountId: 'account', apiToken: 'token' } };

	it.effect('routes deterministically without Clef', () =>
		withReviewers(() =>
			Effect.gen(function* () {
				yield* (yield* ClefFake).answer({ design: 1 });
				const result = yield* (yield* Reviewers).route({
					reviewers: all,
					changes: sourceChange,
					clef: null
				});
				expect(result.reviewers.map((routed) => routed.reviewer.name)).toEqual([
					'standards',
					'tests'
				]);
				expect(result.clefError).toBeNull();
				expect(yield* (yield* ClefFake).calls).toEqual([]);
			})
		)
	);

	it.effect('lets Clef add the reviewers it picks, asking only about the others', () =>
		withReviewers(() =>
			Effect.gen(function* () {
				const fake = yield* ClefFake;
				yield* fake.answer({ design: 0.82, security: 0.2 });
				const result = yield* (yield* Reviewers).route({
					reviewers: all,
					changes: sourceChange,
					clef
				});
				expect(
					result.reviewers.map((routed) => [routed.reviewer.name, routed.reasons])
				).toEqual([
					['standards', ['always']],
					['tests', ['kind source']],
					['design', ['clef: p=0.82']]
				]);
				const [call] = yield* fake.calls;
				expect(call?.candidates.map((reviewer) => reviewer.name)).toEqual([
					'design',
					'security'
				]);
				expect(call?.credentials).toEqual(clef.credentials);
				expect(call?.changes.files).toEqual(sourceChange.files);
			})
		)
	);

	it.effect('keeps the deterministic picks when Clef fails', () =>
		withReviewers(() =>
			Effect.gen(function* () {
				const failure = new ClefError({ status: 401, detail: 'Authentication error' });
				yield* (yield* ClefFake).fail(failure);
				const result = yield* (yield* Reviewers).route({
					reviewers: all,
					changes: sourceChange,
					clef
				});
				expect(result.reviewers.map((routed) => routed.reviewer.name)).toEqual([
					'standards',
					'tests'
				]);
				expect(result.clefError).toBe(failure);
			})
		)
	);

	it.effect('skips Clef when every reviewer is already picked', () =>
		withReviewers(() =>
			Effect.gen(function* () {
				const result = yield* (yield* Reviewers).route({
					reviewers: [def('standards', { always: true })],
					changes: sourceChange,
					clef
				});
				expect(result.reviewers).toHaveLength(1);
				expect(yield* (yield* ClefFake).calls).toEqual([]);
			})
		)
	);
});

describe('Reviewers.review', () => {
	const finding = {
		file: 'src/a.ts',
		line: 1,
		severity: 'nit',
		claim: 'Naming.',
		evidence: 'const a'
	};

	it.effect('runs each reviewer read-only on the subject and its own brief', () =>
		withReviewers(() =>
			Effect.gen(function* () {
				const fake = yield* AgentFake;
				yield* fake.script(
					{ step: 'review', label: 'standards' },
					{ output: { findings: [finding] }, costUsd: 0.2 }
				);
				yield* fake.script(
					{ step: 'review', label: 'security' },
					{ output: { findings: [] }, costUsd: 0.3 }
				);
				const reported = yield* Ref.make<ReadonlyArray<string>>([]);

				const reports = yield* (yield* Reviewers).review({
					...subject,
					reviewers: [def('standards', { always: true }), def('security', {}, 'opus')],
					model: 'sonnet',
					timeoutMs: 60_000,
					context,
					onReport: (report) =>
						Ref.update(reported, (names) => [...names, report.reviewer])
				});

				expect(reports).toEqual([
					{
						reviewer: 'standards',
						findings: [{ reviewer: 'standards', ...finding }],
						cost: {
							step: 'review',
							model: 'sonnet',
							sessionId: 'fake-session-1',
							costUsd: 0.2
						}
					},
					{
						reviewer: 'security',
						findings: [],
						cost: {
							step: 'review',
							model: 'opus',
							sessionId: expect.any(String),
							costUsd: 0.3
						}
					}
				]);
				expect((yield* Ref.get(reported)).toSorted()).toEqual(['security', 'standards']);

				const calls = yield* fake.calls;
				const standards = calls.find((call) => call.label === 'standards');
				expect(standards).toMatchObject({
					access: 'read-only',
					model: 'sonnet',
					additionalDirectories: ['/plans/feature', '/conventions']
				});
				expect(standards?.prompt).toContain('The standards brief.');
				expect(standards?.prompt).toContain(subject.diff);
				expect(standards?.prompt).toContain('Add a');
				expect(standards?.prompt).toContain('/plans/feature/spec.md');
				expect(standards?.prompt).not.toContain('The security brief.');
			})
		)
	);

	it.effect('checks a PR against its description, without reading any plan', () =>
		withReviewers(() =>
			Effect.gen(function* () {
				const fake = yield* AgentFake;
				yield* fake.script(
					{ step: 'review', label: 'standards' },
					{ output: { findings: [] }, costUsd: 0.1 }
				);

				yield* (yield* Reviewers).review({
					...subject,
					intent: ChangeIntent.Description({
						title: 'Cache the config',
						body: 'Reads the config once per run.'
					}),
					reviewers: [def('standards', { always: true })],
					model: 'sonnet',
					timeoutMs: 60_000,
					context,
					onReport: () => Effect.void
				});

				const [call] = yield* fake.calls;
				expect(call?.additionalDirectories).toEqual(['/conventions']);
				expect(call?.prompt).toContain('pull request description');
				expect(call?.prompt).toContain('Title: Cache the config');
				expect(call?.prompt).toContain('Reads the config once per run.');
				expect(call?.prompt).not.toContain('spec.md');
			})
		)
	);

	it.effect('bounds how many reviewers run at once', () =>
		withReviewers(() =>
			Effect.gen(function* () {
				const fake = yield* AgentFake;
				const active = yield* Ref.make(0);
				const peak = yield* Ref.make(0);
				const reply = () =>
					Effect.gen(function* () {
						const now = yield* Ref.updateAndGet(active, (n) => n + 1);
						yield* Ref.update(peak, (max) => Math.max(max, now));
						for (let i = 0; i < 5; i += 1) yield* Effect.yieldNow;
						yield* Ref.update(active, (n) => n - 1);
						return { output: { findings: [] } };
					});
				yield* fake.script({ step: 'review' }, reply, reply, reply, reply, reply);
				yield* (yield* Reviewers).review({
					...subject,
					reviewers: ['a', 'b', 'c', 'd', 'e'].map((name) => def(name, {})),
					model: 'sonnet',
					timeoutMs: 60_000,
					context,
					concurrency: 2,
					onReport: () => Effect.void
				});
				expect(yield* Ref.get(peak)).toBe(2);
			})
		)
	);

	it.effect('fails when a reviewer fails', () =>
		withReviewers(() =>
			Effect.gen(function* () {
				const fake = yield* AgentFake;
				yield* fake.script(
					{ step: 'review', label: 'security' },
					new AgentSdkError({ step: 'review', reason: 'exception', detail: 'boom' })
				);
				yield* fake.script(
					{ step: 'review', label: 'standards' },
					{ output: { findings: [] } }
				);
				const error = yield* Effect.flip(
					(yield* Reviewers).review({
						...subject,
						reviewers: [def('standards', {}), def('security', {})],
						model: 'sonnet',
						timeoutMs: 60_000,
						context,
						onReport: () => Effect.void
					})
				);
				expect(error).toMatchObject({ _tag: 'AgentSdkError', detail: 'boom' });
			})
		)
	);
});

describe('Reviewers.verify', () => {
	const found = (
		reviewer: string,
		claim: string,
		severity: Finding['severity'] = 'must-fix'
	): Finding => ({
		reviewer,
		file: 'src/a.ts',
		line: 3,
		severity,
		claim,
		evidence: 'const a = 1;'
	});
	const previous = (n: number, claim: string): VerifiedFinding => ({
		...found('security', claim),
		id: FindingId.make(`r1-${n}`),
		round: 1,
		alsoReportedBy: []
	});
	const verifyInput = {
		...subject,
		round: 2,
		knownTradeoffs: [],
		model: 'opus',
		timeoutMs: 60_000,
		context
	};

	it.effect('dedupes, drops disproved findings, matches earlier rounds and checks fixes', () =>
		withReviewers(() =>
			Effect.gen(function* () {
				const fake = yield* AgentFake;
				yield* fake.script(
					{ step: 'verify' },
					{
						output: {
							verdicts: [
								{ index: 0, verdict: 'confirmed', reason: 'Real.' },
								{ index: 1, verdict: 'duplicate', duplicateOf: 0, reason: 'Same.' },
								{ index: 2, verdict: 'disproved', reason: 'The code checks it.' },
								{
									index: 3,
									verdict: 'confirmed',
									reason: 'Real.',
									repeats: 'r1-1',
									severity: 'nit'
								},
								{ index: 5, verdict: 'confirmed', reason: 'Real.', repeats: 'r9-9' }
							],
							previous: [
								{ id: 'r1-1', status: 'fixed', evidence: 'Looks fixed.' },
								{ id: 'r1-2', status: 'fixed', evidence: 'Guard added.' },
								{ id: 'r1-3', status: 'unfixed', evidence: 'Still unguarded.' }
							]
						},
						costUsd: 0.4
					}
				);
				const result = yield* (yield* Reviewers).verify({
					...verifyInput,
					findings: [
						found('security', 'Injection.'),
						found('standards', 'Injection, again.'),
						found('tests', 'Untested.'),
						found('design', 'Same as before.'),
						found('tests', 'No verdict.'),
						found('deps', 'Unknown previous id.')
					],
					previous: [
						previous(1, 'Same as before.'),
						previous(2, 'Unguarded.'),
						previous(3, 'Still bad.'),
						previous(4, 'Not mentioned.')
					]
				});

				expect(
					result.verified.map((f) => [
						f.id,
						f.reviewer,
						f.severity,
						f.alsoReportedBy,
						f.repeats
					])
				).toEqual([
					['r2-1', 'security', 'must-fix', ['standards'], undefined],
					['r2-2', 'design', 'nit', [], 'r1-1'],
					['r2-3', 'tests', 'must-fix', [], undefined],
					['r2-4', 'deps', 'must-fix', [], undefined],
					['r2-5', 'security', 'must-fix', [], 'r1-3'],
					['r2-6', 'security', 'must-fix', [], 'r1-4']
				]);
				expect(result.verified[4]?.evidence).toContain('Still present: Still unguarded.');
				expect(result.verified.every((f) => f.round === 2)).toBe(true);
				expect(result.disproved).toEqual([
					{ finding: found('tests', 'Untested.'), reason: 'The code checks it.' }
				]);
				expect(result.fixed).toEqual(['r1-2']);
				expect(result.cost).toEqual({
					step: 'verify',
					model: 'opus',
					sessionId: 'fake-session-1',
					costUsd: 0.4
				});

				const [call] = yield* fake.calls;
				expect(call).toMatchObject({
					step: 'verify',
					access: 'read-only',
					additionalDirectories: ['/plans/feature', '/conventions']
				});
				expect(call?.prompt).toContain('You verify findings.');
				expect(call?.prompt).toContain('Conventions directory: /conventions');
				expect(call?.prompt).toContain('0. security | must-fix | src/a.ts:3 | Injection.');
				expect(call?.prompt).toContain(
					'r1-2. security | must-fix | src/a.ts:3 | Unguarded.'
				);
			})
		)
	);

	it.effect('only lowers a must-fix to a nit, after merging duplicates of the same kind', () =>
		withReviewers(() =>
			Effect.gen(function* () {
				yield* (yield* AgentFake).script(
					{ step: 'verify' },
					{
						output: {
							verdicts: [
								{
									index: 0,
									verdict: 'confirmed',
									reason: 'Real.',
									severity: 'must-fix'
								},
								{ index: 1, verdict: 'confirmed', reason: 'Real.' },
								{ index: 2, verdict: 'duplicate', duplicateOf: 1, reason: 'Same.' },
								{
									index: 3,
									verdict: 'confirmed',
									reason: 'Real.',
									severity: 'nit'
								},
								{ index: 4, verdict: 'duplicate', duplicateOf: 3, reason: 'Same.' },
								{
									index: 5,
									verdict: 'confirmed',
									reason: 'Real.',
									severity: 'nit'
								},
								{
									index: 6,
									verdict: 'confirmed',
									reason: 'Real.',
									severity: 'tradeoff'
								}
							],
							previous: []
						}
					}
				);
				const result = yield* (yield* Reviewers).verify({
					...verifyInput,
					findings: [
						found('design', 'Not raised.', 'tradeoff'),
						found('comments', 'Merged up.', 'nit'),
						found('security', 'Merged up, again.', 'must-fix'),
						found('standards', 'Lowered.', 'must-fix'),
						found('security', 'Lowered, again.', 'must-fix'),
						found('data', 'Not lowered.', 'tradeoff'),
						found('tests', 'Not moved.', 'must-fix')
					],
					previous: []
				});
				expect(result.verified.map((f) => [f.claim, f.severity, f.alsoReportedBy])).toEqual(
					[
						['Not raised.', 'tradeoff', []],
						['Merged up.', 'must-fix', ['security']],
						['Lowered.', 'nit', ['security']],
						['Not lowered.', 'tradeoff', []],
						['Not moved.', 'must-fix', []]
					]
				);
			})
		)
	);

	it.effect('keeps both findings of a duplicate verdict across kinds', () =>
		withReviewers(() =>
			Effect.gen(function* () {
				yield* (yield* AgentFake).script(
					{ step: 'verify' },
					{
						output: {
							verdicts: [
								{ index: 0, verdict: 'confirmed', reason: 'Real.' },
								{ index: 1, verdict: 'duplicate', duplicateOf: 0, reason: 'Same.' }
							],
							previous: []
						}
					}
				);
				const result = yield* (yield* Reviewers).verify({
					...verifyInput,
					findings: [
						found('security', 'Must fix.', 'must-fix'),
						found('design', 'A tradeoff.', 'tradeoff')
					],
					previous: []
				});
				expect(result.verified.map((f) => [f.claim, f.severity, f.alsoReportedBy])).toEqual(
					[
						['Must fix.', 'must-fix', []],
						['A tradeoff.', 'tradeoff', []]
					]
				);
			})
		)
	);

	it.effect('drops a tradeoff that repeats a known one and matches repeats by kind', () =>
		withReviewers(() =>
			Effect.gen(function* () {
				yield* (yield* AgentFake).script(
					{ step: 'verify' },
					{
						output: {
							verdicts: [
								{
									index: 0,
									verdict: 'confirmed',
									reason: 'Same.',
									repeats: 'r1-5'
								},
								{
									index: 1,
									verdict: 'confirmed',
									reason: 'Real.',
									repeats: 'r1-1'
								},
								{ index: 2, verdict: 'confirmed', reason: 'Real.', repeats: 'r1-5' }
							],
							previous: [{ id: 'r1-1', status: 'unfixed', evidence: 'Still there.' }]
						}
					}
				);
				const knownTradeoff: VerifiedFinding = {
					...found('design', 'Known tradeoff.', 'tradeoff'),
					id: FindingId.make('r1-5'),
					round: 1,
					alsoReportedBy: []
				};
				const result = yield* (yield* Reviewers).verify({
					...verifyInput,
					findings: [
						found('design', 'Known tradeoff, again.', 'tradeoff'),
						found('data', 'Tradeoff on a must-fix id.', 'tradeoff'),
						found('security', 'Must-fix on a tradeoff id.', 'must-fix')
					],
					previous: [previous(1, 'Earlier must-fix.')],
					knownTradeoffs: [knownTradeoff]
				});
				expect(result.verified.map((f) => [f.claim, f.severity, f.repeats])).toEqual([
					['Tradeoff on a must-fix id.', 'tradeoff', undefined],
					['Must-fix on a tradeoff id.', 'must-fix', undefined],
					['Earlier must-fix.', 'must-fix', 'r1-1']
				]);
			})
		)
	);

	it.effect('keeps a duplicate of a disproved finding', () =>
		withReviewers(() =>
			Effect.gen(function* () {
				yield* (yield* AgentFake).script(
					{ step: 'verify' },
					{
						output: {
							verdicts: [
								{ index: 0, verdict: 'disproved', reason: 'No.' },
								{ index: 1, verdict: 'duplicate', duplicateOf: 0, reason: 'Same.' }
							],
							previous: []
						}
					}
				);
				const result = yield* (yield* Reviewers).verify({
					...verifyInput,
					findings: [found('security', 'A.'), found('standards', 'B.')],
					previous: []
				});
				expect(result.verified.map((f) => f.claim)).toEqual(['B.']);
			})
		)
	);

	it.effect('rejects verdicts for unknown or repeated indexes', () =>
		withReviewers(() =>
			Effect.gen(function* () {
				const fake = yield* AgentFake;
				const verdict = (index: number) => ({
					index,
					verdict: 'confirmed',
					reason: 'Real.'
				});
				yield* fake.script(
					{ step: 'verify' },
					{ output: { verdicts: [verdict(1)], previous: [] } }
				);
				yield* fake.script(
					{ step: 'verify' },
					{ output: { verdicts: [verdict(0), verdict(0)], previous: [] } }
				);
				const reviewers = yield* Reviewers;
				const input = { ...verifyInput, findings: [found('security', 'A.')], previous: [] };
				const unknown = yield* Effect.flip(reviewers.verify(input));
				expect(unknown).toBeInstanceOf(AgentOutputMismatch);
				// The verifier call finished and is billed even though its verdicts are unusable.
				expect(unknown).toMatchObject({ spend: { cost: { step: 'verify', costUsd: 0 } } });
				expect(yield* Effect.flip(reviewers.verify(input))).toMatchObject({
					detail: 'two verdicts for finding 0'
				});
			})
		)
	);

	it.effect('runs no agent when there is nothing to verify', () =>
		withReviewers(() =>
			Effect.gen(function* () {
				const result = yield* (yield* Reviewers).verify({
					...verifyInput,
					findings: [],
					previous: []
				});
				expect(result).toEqual({ verified: [], disproved: [], fixed: [], cost: null });
				expect(yield* (yield* AgentFake).calls).toEqual([]);
			})
		)
	);
});

describe('reviewChanges', () => {
	it.effect('gathers the diff, commits, changed files and added lines of a range', () =>
		Effect.gen(function* () {
			const changes = yield* reviewChanges(
				{ cwd: '/repo', env: {} },
				{ from: fakeSha(1), to: fakeSha(2) }
			);
			expect(changes).toEqual({
				diff: 'the diff',
				commits: [],
				files: [{ path: 'src/a.ts', status: 'modified' }],
				addedLines: { 'src/a.ts': ['x'] }
			});
		}).pipe(
			Effect.provide(
				GitFake.layer({
					diff: 'the diff',
					changedFiles: [{ path: 'src/a.ts', status: 'modified' }],
					addedLines: { 'src/a.ts': ['x'] }
				})
			)
		)
	);
});
