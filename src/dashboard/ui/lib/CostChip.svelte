<script lang="ts">
  import type { RequestUsage } from '../../../types.ts'; import type { RequestRow } from '../../../db/index.ts'; import { int, usd } from '../../format.ts';
  let { usage: u, request: req }: { usage: RequestUsage; request?: RequestRow } = $props();
  const prompt = $derived(req?.prompt_tokens ?? u.freshInput + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h);
  const reasoning = $derived(req?.reasoning ?? u.reasoning);
  const title = $derived(req ? `fresh ${int(req.fresh_input)} · cache read ${int(req.cache_read)} · cache write ${int(req.cache_write_5m + req.cache_write_1h)} · out ${int(req.output)} · reasoning ${int(req.reasoning)}${req.tier ? ` · tier >${int(req.tier)}` : ''}` : '');
</script>
<span class="costchip" {title}>request <code>{u.requestId}</code> · {int(prompt)} in · {int(req?.output ?? u.output)} out{reasoning ? ` (${int(reasoning)} reasoning)` : ''} · <strong>{req ? usd(req.cost_usd, 5) : 'cost pending'}</strong></span>
