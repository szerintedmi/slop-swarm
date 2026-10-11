<script lang="ts">
  import { dur, usd } from '../../format.ts';
  let { points }: { points: { t: number; v: number }[] } = $props();
  const first = $derived(points[0]?.t ?? 0), last = $derived(points.at(-1)?.t ?? first);
  const max = $derived(Math.max(...points.map(p => p.v)) || 1);
  const coordinates = $derived(points.map(p => `${(last === first ? 2 : (p.t - first) / (last - first) * 316 + 2).toFixed(1)},${(58 - p.v / max * 56).toFixed(1)}`).join(' '));
</script>
{#if points.length < 2}<p class="muted">Not enough wakes for a chart yet.</p>{:else}
<svg class="spark" viewBox="0 0 320 60" width="320" height="60" role="img" aria-label="cumulative spend"><polyline fill="none" stroke="currentColor" stroke-width="2" points={coordinates} /></svg>
<div class="muted small">{usd(0, 2)} → {usd(max)} over {dur(last - first)}</div>{/if}
