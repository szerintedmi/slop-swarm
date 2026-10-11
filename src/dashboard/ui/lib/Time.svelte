<script lang="ts">
  import { clock, hms, rel } from '../../format.ts';
  let { ts }: { ts: number | null | undefined } = $props();
</script>
{#if ts != null}<time datetime={new Date(ts).toISOString()} title="{clock(ts)} · {rel(ts)}">{hms(ts)}</time>{:else}—{/if}
