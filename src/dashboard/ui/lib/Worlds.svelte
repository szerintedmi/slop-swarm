<script lang="ts">
  import type { PageOf } from '../../service.ts'; import Time from './Time.svelte'; import Launch from './Launch.svelte';
  let { model }: { model: PageOf<'worlds'> } = $props();
</script>
<h1>Worlds</h1>
<p class="sub">A world is a forge plus the agents' homes; a run is a time-boxed session in one world. Continue a world to carry its forge, homes and sessions over.</p>
{#if !model.readonly}<h2>Launch a run</h2><Launch presets={model.presets} worlds={model.worlds} />{/if}
<h2>All worlds</h2>
{#if model.worlds.length}<div class="scroll"><table><thead><tr><th>world</th><th>status</th><th class="num">runs</th><th>last run</th><th>agents (home generation)</th><th>forge</th></tr></thead><tbody>
{#each model.worlds as w}<tr class="click"><td><a href="/world/{encodeURIComponent(w.id)}">{w.id}</a><div class="small muted">{w.name}</div></td>
<td>{#if w.activeRun}<a class="st-running" href="/?run={encodeURIComponent(w.activeRun)}">active</a>{:else}<span class="st-sleeping">{w.status}</span>{/if}</td>
<td class="num">{w.runs}</td><td class="small">{#if w.lastRunAt}<Time ts={w.lastRunAt} />{:else}—{/if}</td>
<td class="small">{#each w.agents as a, i}{i ? ', ' : ''}<a href="/world/{encodeURIComponent(w.id)}?agent={encodeURIComponent(a.name)}" class:muted={!!a.removed_at}>{a.name}</a>{a.home_generation ? ` g${a.home_generation}` : ''}{/each}</td>
<td class="small">{#if w.forgeUrl}<a href={w.forgeUrl} target="_blank" rel="noopener">open ↗</a>{:else}<span class="muted">{w.forge_image.replace(/^.*\//, '')}</span>{/if}</td></tr>{/each}
</tbody></table></div>{:else}<div class="empty">No worlds yet: launch a run.</div>{/if}
