<script lang="ts">
  import type { PageOf } from '../../service.ts'; import { dur, int, rel, triggerText, usd } from '../../format.ts';
  import Chip from './Chip.svelte'; import Badge from './Badge.svelte'; import Controls from './Controls.svelte'; import Stat from './Stat.svelte'; import Bar from './Bar.svelte'; import Clip from './Clip.svelte'; import Sparkline from './Sparkline.svelte'; import Feed from './Feed.svelte'; import Time from './Time.svelte'; import Tree from './Tree.svelte'; import FileViewer from './FileViewer.svelte';
  let { model }: { model: PageOf<'agent'> } = $props();
  const a = $derived(model.agent);
  const base = $derived(`/agent/${encodeURIComponent(a.name)}?run=${encodeURIComponent(model.run.id)}`);
  const done = $derived(model.wakes.filter(w => w.ended_at != null));
</script>
<div class="row" style="justify-content:space-between"><div><h1 style="font-size:22px"><Chip name={a.name} runId={model.run.id} link={false} /> <Badge status={a.status} /></h1><p class="sub small">{a.runtime} · {a.model} · {a.effort} effort</p></div><Controls runId={model.run.id} agent={a.name} readonly={model.readonly} live={model.live} /></div>
<nav class="tabs" style="margin-bottom:10px">{#each ['summary', 'wakes', 'memory'] as tab}<a href="{base}&tab={tab}" class:on={tab === model.tab}>{tab}{tab === 'wakes' ? ` · ${model.wakes.length}` : tab === 'memory' ? ` · ${model.fileCount}` : ''}</a>{/each}</nav>
{#if model.tab === 'summary'}
<div class="stats"><Stat value={usd(a.spent_usd)} label="spent of {usd(a.budget_usd, 2)}" /><Stat value={int(a.wake_count)} label="wakes" /><Stat value={done.length ? usd(done.reduce((n, w) => n + w.cost_usd, 0) / done.length) : '—'} label="avg per wake" /><Stat value={int(model.wakes.filter(w => w.trigger === 'message').length)} label="woken by forge" /><Stat value={model.live && a.next_wake_at ? rel(a.next_wake_at) : '—'} label="next wake" /></div><Bar value={a.spent_usd} max={a.budget_usd} />
<h2>Last said</h2>{#if model.lastSaid}<div class="card"><Clip text={model.lastSaid} markdown lines={10} id="asaid-{model.run.id}-{a.name}" /></div>{:else}<div class="empty">Nothing yet.</div>{/if}
<h2>Spend over time</h2><Sparkline points={model.points} /><h2>Activity</h2><Feed items={model.feed} runId={model.run.id} />
{:else if model.tab === 'wakes'}
{#if model.wakes.length}<div class="scroll"><table><thead><tr><th class="num">#</th><th>started</th><th>why</th><th class="num">took</th><th>exit</th><th class="num">tools</th><th class="num">requests</th><th class="num">cost</th><th class="num">unread at start</th><th>then asked</th></tr></thead><tbody>
{#each model.wakes as w}<tr class="click"><td class="num"><a href="/wake/{w.id}">{w.seq}</a></td><td class="small"><Time ts={w.started_at} /></td><td>{triggerText(w.trigger)}{w.resumed ? ' · continued' : ''}</td><td class="num">{#if w.ended_at}{dur(w.ended_at - w.started_at)}{:else}<span class="st-waking">running</span>{/if}</td><td>{w.exit_reason ?? ''}</td><td class="num">{int(w.tool_calls)}</td><td class="num">{int(w.requests)}</td><td class="num">{usd(w.cost_usd)}</td><td class="num">{int(w.msgs_in)}</td><td class="small">{w.next_in_minutes == null ? '—' : `${w.next_in_minutes} min`}{w.continue_requested ? ' · continue' : ''}</td></tr>{/each}
</tbody></table></div>{:else}<div class="empty">No wakes yet.</div>{/if}
{:else}
<p class="sub">The agent's private home (<code>/home/agent</code>): its memory between wakes. Symlinks are not shown; <code>.git</code> is not listed.</p>
{#if model.fileCount}<div class="split"><div class="card treebox"><Tree nodes={model.tree} selected={model.selected} base="{base}&tab=memory&path=" treeKey="tree:{model.run.id}:{a.name}" /></div><div class="viewer">
{#if model.selected && model.file}<FileViewer file={model.file} selected={model.selected} id="mem-{model.run.id}-{a.name}-{model.selected}" /><p class="small"><a href="/file?run={encodeURIComponent(model.run.id)}&agent={encodeURIComponent(a.name)}&path={encodeURIComponent(model.selected)}">open on its own page</a></p>{:else}<div class="empty">Pick a file in the tree.</div>{/if}
</div></div>{:else}<div class="empty">No files yet.</div>{/if}
{/if}
