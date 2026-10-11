<script lang="ts">
  import type { PageOf } from '../../service.ts'; import { clock, dur, int, triggerText, usd } from '../../format.ts'; import Disclosure from './Disclosure.svelte';
  import Chip from './Chip.svelte'; import Clip from './Clip.svelte'; import Stat from './Stat.svelte'; import ToolArgs from './ToolArgs.svelte'; import CostChip from './CostChip.svelte'; import RawLog from './RawLog.svelte';
  let { model }: { model: PageOf<'wake'> } = $props();
  const w = $derived(model.wake);
  const results = $derived(new Map(model.events.flatMap(e => e.kind === 'tool_result' ? [[e.id, e] as const] : [])));
  const calls = $derived(new Set(model.events.flatMap(e => e.kind === 'tool_call' ? [e.id] : [])));
</script>
<p class="small"><a href="/agent/{encodeURIComponent(w.agent)}?run={encodeURIComponent(w.run_id)}&tab=wakes">← {w.agent}'s wakes</a></p>
<h1><Chip name={w.agent} runId={w.run_id} /> wake #{w.seq} {#if model.live}<span class="badge st-waking">awake</span>{/if}</h1>
<p class="sub">{clock(w.started_at)} · woke for: {triggerText(w.trigger)}{w.resumed ? ' · continued its previous session' : ' · fresh context'}{w.slept_ms != null ? ` · after ${dur(w.slept_ms)} asleep` : ''}</p>
<div class="stats"><Stat value={usd(w.cost_usd, 5)} label={w.reported_cost_usd != null ? `cost (vendor ${usd(w.reported_cost_usd, 5)})` : 'cost'} /><Stat value={w.ended_at ? dur(w.ended_at - w.started_at) : '…'} label="duration" /><Stat value={int(w.requests)} label="API requests" />{#if w.web_searches}<Stat value={int(w.web_searches)} label="web searches" />{/if}<Stat value={int(w.tool_calls)} label="tool calls" /><Stat value={int(w.msgs_in)} label="unread notifications at start" /><Stat value={w.next_in_minutes == null ? '—' : `${w.next_in_minutes} min`} label={w.continue_requested ? 'then asked (continue)' : 'then asked to sleep'} /><Stat value={w.exit_reason ?? '—'} label="exit" /></div>
<Disclosure id="tok-{w.id}"><summary class="small muted">token breakdown</summary><p class="small">fresh {int(w.fresh_input)} · cache read {int(w.cache_read)} · cache write {int(w.cache_write_5m + w.cache_write_1h)} · output {int(w.output)} · reasoning {int(w.reasoning)} · session <code>{w.session_id ?? '—'}</code></p></Disclosure>
<h2>Transcript</h2>
{#if model.parserError}<p class="err">{model.parserError}</p>{:else if model.events.length}<ol class="tl">
{#each model.events as e, i}
  {@const key = `w${w.id}-${i}`}
  {#if e.kind === 'session'}<li class="notice"><div class="tag">session <code>{e.sessionId}</code></div></li>
  {:else if e.kind === 'reasoning'}<li class="reasoning"><div class="tag">thinking</div><Clip text={e.text} markdown lines={3} id={key} /></li>
  {:else if e.kind === 'message'}<li class={e.role === 'assistant' ? 'assistant' : 'notice'}><div class="tag">{e.role === 'assistant' ? 'says' : 'notice'}</div><Clip text={e.text} markdown={e.role === 'assistant'} lines={e.role === 'assistant' ? 12 : 4} id={key} /></li>
  {:else if e.kind === 'tool_call'}
    {@const result = results.get(e.id)}
    <li class="tool" class:err={result && !result.ok}><div class="tag">tool · {e.name}</div><ToolArgs args={e.args} id={key} />
    {#if result}<div class="result" class:err={!result.ok}><div class="tag">{result.ok ? 'result' : 'error'}</div>{#if result.summary.trim()}<Clip text={result.summary} id="{key}r" />{:else}<span class="muted small">(no output)</span>{/if}</div>{/if}</li>
  {:else if e.kind === 'tool_result' && !calls.has(e.id)}<li class="tool" class:err={!e.ok}><div class="tag">tool result</div><Clip text={e.summary} id={key} /></li>
  {:else if e.kind === 'usage'}<li style="border:0;padding:0 12px"><CostChip usage={e.usage} request={model.requests.find(r => r.request_id === e.usage.requestId)} /></li>
  {:else if e.kind === 'turn_end'}<li class="turn_end"><div class="tag">went to sleep · {e.reason}{e.numTurns != null ? ` · ${e.numTurns} turns` : ''}{e.reportedCostUsd != null ? ` · vendor-reported ${usd(e.reportedCostUsd, 5)}` : ''}</div>{#if e.detail}<div class="err small">{e.detail}</div>{/if}</li>{/if}
{/each}</ol>{:else}<div class="empty">{model.rawNote || 'Empty transcript.'}</div>{/if}
{#if model.unseen.length}<h2>API requests</h2><p class="muted small">Per-request usage from the session file (e.g. the Codex rollout), recorded after the wake. Relay web searches (<code>search:…</code>) come from the relay log.</p>
<div class="scroll"><table><thead><tr><th class="num">#</th><th>request</th><th class="num">fresh</th><th class="num">cache read</th><th class="num">cache write</th><th class="num">out</th><th class="num">reasoning</th><th class="num">prompt</th><th class="num">cost</th></tr></thead><tbody>
{#each model.unseen as r}<tr><td class="num">{r.seq}</td><td><code>{r.request_id}</code></td><td class="num">{int(r.fresh_input)}</td><td class="num">{int(r.cache_read)}</td><td class="num">{int(r.cache_write_5m + r.cache_write_1h)}</td><td class="num">{int(r.output)}</td><td class="num">{int(r.reasoning)}</td><td class="num">{int(r.prompt_tokens)}</td><td class="num">{usd(r.cost_usd, 5)}</td></tr>{/each}
</tbody></table></div>{/if}
<h2>Raw</h2><RawLog wakeId={w.id} note={model.rawNote} />
