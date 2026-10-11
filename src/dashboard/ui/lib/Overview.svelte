<script lang="ts">
  import type { PageOf } from '../../service.ts';
  import { clock, dur, int, rel, triggerText, usd } from '../../format.ts';
  import Badge from './Badge.svelte'; import Bar from './Bar.svelte'; import Chip from './Chip.svelte'; import Clip from './Clip.svelte'; import Controls from './Controls.svelte'; import Feed from './Feed.svelte'; import Stat from './Stat.svelte';
  let { model }: { model: PageOf<'overview'> } = $props();
  const r = $derived(model.state.run);
  const clockLabel = $derived(model.live ? model.run.deadline_at > Date.now() ? `world ends ${rel(model.run.deadline_at)} (${clock(model.run.deadline_at)})` : 'world end reached; finishing running wakes' : `ended ${rel(model.run.ended_at ?? model.run.deadline_at)}${r.stopReason ? ` · ${r.stopReason}` : ''}`);
</script>
<div class="row" style="justify-content:space-between"><div><h1>{r.name} <Badge status={r.status} /></h1><p class="sub small">run <code>{r.id}</code> · started {clock(r.startedAt)}</p></div><Controls runId={r.id} readonly={model.readonly} live={model.live} /></div>
<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr))">
  <div class="card meter"><div class="lbl"><span>World time</span><span>{dur(Math.min(r.elapsedMs, r.maxDurationMs))} / {dur(r.maxDurationMs)}</span></div><Bar value={Math.min(r.elapsedMs, r.maxDurationMs)} max={r.maxDurationMs} label={clockLabel} /><div class="small muted">{clockLabel}</div></div>
  <div class="card meter"><div class="lbl"><span>Spend</span><span>{usd(r.spentUsd)}{r.swarmBudgetUsd != null ? ` / ${usd(r.swarmBudgetUsd, 2)}` : ''}</span></div>{#if r.swarmBudgetUsd != null}<Bar value={r.spentUsd} max={r.swarmBudgetUsd} />{/if}<div class="small muted">{r.elapsedMs > 0 ? `${usd(r.spentUsd / r.elapsedMs * 3_600_000)} per hour` : ''}</div></div>
  <div class="card"><div class="stats" style="margin:0"><Stat value={int(model.state.agents.reduce((n, a) => n + a.wakeCount, 0))} label="wakes" /><Stat value={int(r.notificationWakes)} label="woken by forge" /><Stat value={int(r.runningWakes)} label="awake now" /></div></div>
</div>
<h2>Agents</h2><div class="grid">
{#each model.state.agents as a (a.name)}<div class="card"><div class="head"><Chip name={a.name} runId={r.id} /><Badge status={a.status} /></div>
<div class="muted small">{a.runtime} · {a.model} · {a.effort}</div>
{#if a.lastSaid}<div class="small muted">last said</div><Clip text={a.lastSaid} markdown lines={3} id="said-{r.id}-{a.name}" />{:else}<p class="muted small">Has not said anything yet.</p>{/if}
<dl class="kv"><dt>next wake</dt><dd>{#if a.nextWakeAt != null}{rel(a.nextWakeAt)} <span class="muted">({triggerText(a.nextTrigger ?? '')})</span>{:else}—{/if}</dd><dt>wakes</dt><dd>{int(a.wakeCount)}</dd><dt>woken by forge</dt><dd>{int(a.notificationWakes)}</dd><dt>spend</dt><dd>{usd(a.spentUsd)} of {usd(a.budgetUsd, 2)}</dd></dl>
<Bar value={a.spentUsd} max={a.budgetUsd} /><Controls runId={r.id} agent={a.name} readonly={model.readonly} live={model.live} />
</div>{:else}<div class="empty">No agents.</div>{/each}</div>
<h2>What happened <span class="small" style="text-transform:none;letter-spacing:0"><a href="/events?run={encodeURIComponent(r.id)}">raw events</a></span></h2>
<Feed items={model.feed} runId={r.id} />
