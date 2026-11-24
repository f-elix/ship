<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Inbox from '#lib/prototypes/4-inbox/Inbox.svelte';

	const select = (id: string | null) => {
		const url = new URL(page.url.href);
		if (id) url.searchParams.set('item', id);
		else url.searchParams.delete('item');
		goto(url, { replace: true, shallow: true });
	};
</script>

<Inbox initial={page.url.searchParams.get('item')} onselect={select} />
