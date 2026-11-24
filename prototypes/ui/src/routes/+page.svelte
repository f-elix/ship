<script lang="ts">
	const prototypes = [
		{ href: '/1-control-room', name: 'Control Room', blurb: 'Dark, dense, three-pane operator console. Live event stream, pipeline rail, lock and cost inspector.' },
		{ href: '/2-timeline', name: 'Timeline', blurb: 'Light, document-like. Each run reads as a narrative of phases, rounds, checks and findings.' },
		{ href: '/3-board', name: 'Board', blurb: 'Every run across every project as a card on a pipeline-stage board, with a detail drawer.' },
		{ href: '/4-inbox', name: 'Inbox', blurb: 'Attention-first. Only what needs a human: escalations, failures, findings to triage, PRs to fix.' },
		{ href: '/5-launchpad', name: 'Launchpad', blurb: 'Project-centric home and command palette. Start runs from plans and PRs, edit config, set up projects.' },
		{ href: '/6-inbox', name: 'Inbox v2 (dark, output-first)', blurb: 'The Inbox direction reworked around what ship produces (PRs, reviews, commits) and their state; how ship made them comes last.'},
		{ href: '/7-inbox-tabs', name: 'Inbox v2, tabs', blurb: 'Inbox v2 with the deliverables as tabs across the top instead of a sidebar.' }
	];
</script>

<main>
	<h1>ship UI prototypes</h1>
	<p>Five directions for a local web UI over the ship daemon. All data is mocked; nothing talks to ship.</p>
	<ol>
		{#each prototypes as p (p.href)}
			<li>
				<a href={p.href}>{p.name}</a>
				<span>{p.blurb}</span>
			</li>
		{/each}
	</ol>
</main>

<style>
	main {
		max-width: 760px;
		margin: 80px auto;
		padding: 0 24px;
		font: 16px/1.5 system-ui, sans-serif;
		color: #1a1a1a;
	}
	h1 {
		font-size: 28px;
		margin-bottom: 4px;
	}
	ol {
		padding: 0;
		list-style: none;
		display: grid;
		gap: 12px;
		margin-top: 32px;
	}
	li {
		display: grid;
		gap: 2px;
		padding: 16px 20px;
		border: 1px solid #e3e3e3;
		border-radius: 10px;
	}
	a {
		font-weight: 600;
		font-size: 18px;
		color: #1a1a1a;
	}
	span {
		color: #555;
	}
</style>
