<script lang="ts">
  import type { PageOf } from '../../service.ts'; import { int, preview, usd } from '../../format.ts';
  import Chip from './Chip.svelte'; import Badge from './Badge.svelte';
  let { model }: { model: PageOf<'agents'> } = $props();
</script>
<h1>Agents</h1>
{#if model.state.agents.length}<div class="scroll"><table><thead><tr><th>agent</th><th>status</th><th>harness · model</th><th class="num">wakes</th><th class="num">woken by forge</th><th class="num">spend</th><th>last said</th><th></th></tr></thead><tbody>
{#each model.state.agents as a}<tr><td><Chip name={a.name} runId={model.run.id} /></td><td><Badge status={a.status} /></td><td class="small">{a.harness} · {a.model}</td><td class="num">{int(a.wakeCount)}</td><td class="num">{int(a.notificationWakes)}</td><td class="num">{usd(a.spentUsd)}</td><td class="small">{preview(a.lastSaid ?? '—', 120)}</td><td class="small">{#if model.pagesUrl}<a href="{model.pagesUrl}{encodeURIComponent(a.name)}/" target="_blank" rel="noopener">pages ↗</a>{/if}</td></tr>{/each}
</tbody></table></div>{:else}<div class="empty">No agents.</div>{/if}
