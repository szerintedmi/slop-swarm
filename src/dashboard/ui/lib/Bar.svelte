<script lang="ts">
  import { usd } from '../../format.ts';
  let { value, max, label }: { value: number; max: number; label?: string } = $props();
  const pct = $derived(max > 0 ? Math.max(0, Math.min(100, value / max * 100)) : 0);
</script>
<div class="bar" title={label ?? `${usd(value)} of ${usd(max, 2)}`}><div class="fill" class:warm={pct >= 60 && pct < 90} class:hot={pct >= 90} style="width:{pct.toFixed(1)}%"></div></div>
