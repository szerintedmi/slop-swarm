<script lang="ts">
  // The raw log can be megabytes: fetch it only when opened, never in the page data.
  let { wakeId, note }: { wakeId: number; note: string } = $props();
  let open = $state(false);
  let text = $state<string | null>(null);
  let error = $state('');
  $effect(() => {
    if (!open || text !== null) return;
    fetch(`/wake/${wakeId}/raw`).then(async r => { if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); text = await r.text(); })
      .catch(err => { error = `could not load raw log: ${String(err)}`; });
  });
</script>
<details data-hold bind:open><summary>raw JSONL{note ? ` (${note})` : ''}</summary>
{#if error}<p class="err">{error}</p>{:else if text === null}<p class="muted small">loading…</p>{:else}<pre>{text}</pre>{/if}</details>
