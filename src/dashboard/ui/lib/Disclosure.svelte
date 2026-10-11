<script lang="ts">
  import { onMount, untrack, type Snippet } from 'svelte';
  let { id, defaultOpen = false, hold = false, children }: { id: string; defaultOpen?: boolean; hold?: boolean; children: Snippet } = $props();
  let open = $state(untrack(() => defaultOpen));
  let remembered = $state<boolean | null>(null);
  onMount(() => {
    try {
      const value = sessionStorage.getItem(id);
      if (value !== null) { remembered = value === '1'; open = remembered; }
    } catch { /* storage unavailable */ }
  });
  $effect(() => { if (remembered === null) open = defaultOpen; });
  function save(event: Event) {
    remembered = (event.currentTarget as HTMLDetailsElement).open;
    try { sessionStorage.setItem(id, remembered ? '1' : '0'); } catch { /* storage unavailable */ }
  }
</script>
<details data-hold={hold ? true : undefined} data-key={id} bind:open ontoggle={save}>{@render children()}</details>
