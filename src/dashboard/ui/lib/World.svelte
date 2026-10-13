<script lang="ts">
  import type { PageOf } from '../../service.ts'; import Time from './Time.svelte'; import Tree from './Tree.svelte'; import FileViewer from './FileViewer.svelte'; import Launch from './Launch.svelte'; import Badge from './Badge.svelte';
  let { model }: { model: PageOf<'world'> } = $props();
  const w = $derived(model.world);
  const base = $derived(`/world/${encodeURIComponent(w.id)}`);
</script>
<h1>World {w.id}</h1>
<p class="sub">{w.name} · {w.runs} run(s) · forge image <code>{w.forge_image}</code>{#if w.forgeUrl} · <a href={w.forgeUrl} target="_blank" rel="noopener">forge ↗</a>{/if}</p>
{#if !model.readonly && !w.activeRun}<h2>Continue this world</h2><Launch presets={model.presets} worlds={[w]} world={w.id} />{/if}
<h2>Agents</h2>
<div class="scroll"><table><thead><tr><th>agent</th><th>harness</th><th>session carried over</th><th class="num">home generation</th><th>joined</th><th></th></tr></thead><tbody>
{#each w.agents as a}<tr><td>{a.name}{#if a.removed_at} <span class="small muted">(left)</span>{/if}</td><td class="small">{a.harness}</td><td class="small">{a.last_session_id ? `${a.last_session_id.slice(0, 13)}…${a.continue_next ? ' (continues)' : ''}` : '—'}</td><td class="num">{a.home_generation || '—'}</td><td class="small"><Time ts={a.added_at} /></td><td><a href="{base}?agent={encodeURIComponent(a.name)}">home</a></td></tr>{/each}
</tbody></table></div>
{#if model.home}
<h2>{model.home.agent}'s home</h2>
<p class="sub small">{#if model.home.source.live}<span class="st-waking">live</span> from the agent host{:else if model.home.source.generation}VPS copy, as of generation {model.home.source.generation} (agent host not reachable){:else}no copy of this home yet{/if}</p>
{#if model.home.fileCount}<div class="split"><div class="card treebox"><Tree nodes={model.home.tree} selected={model.home.selected} base="{base}?agent={encodeURIComponent(model.home.agent)}&path=" treeKey="wtree:{w.id}:{model.home.agent}" /></div><div class="viewer">
{#if model.home.selected && model.home.file}<FileViewer file={model.home.file} selected={model.home.selected} id="wmem-{w.id}-{model.home.agent}-{model.home.selected}" />{:else}<div class="empty">Pick a file in the tree.</div>{/if}
</div></div>{:else}<div class="empty">No files yet.</div>{/if}
{/if}
<h2>Runs</h2>
<div class="scroll"><table><thead><tr><th>run</th><th>status</th><th>started</th><th>brief</th></tr></thead><tbody>
{#each model.runs as r}<tr class="click"><td><a href="/?run={encodeURIComponent(r.id)}">{r.id}</a></td><td><Badge status={r.status} /></td><td class="small"><Time ts={r.started_at} /></td><td class="small">{r.brief ?? ''}</td></tr>{/each}
</tbody></table></div>
