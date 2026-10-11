<script lang="ts">
  import type { DashboardActivity } from '../../service.ts';
  import { dur, int, truncate, triggerText, usd } from '../../format.ts';
  import Chip from './Chip.svelte'; import Time from './Time.svelte';
  let { items, runId }: { items: DashboardActivity[]; runId: string } = $props();
</script>
{#if items.length}<ul class="feed">{#each items as a}
  <li class="k-{a.kind}"><Time ts={a.ts} /><div class="what">
    {#if a.kind === 'wake'}
      <Chip name={a.agent} {runId} /> <a href="/wake/{a.wake.id}">woke #{a.wake.seq}</a>
      <span class="muted">({triggerText(a.wake.trigger)}{a.wake.resumed ? ', continued session' : ''})</span>
      <span class="muted small">· {a.wake.ended_at == null ? 'awake now' : dur(a.wake.ended_at - a.wake.started_at)} · {int(a.wake.tool_calls)} {a.wake.tool_calls === 1 ? 'tool' : 'tools'} · {usd(a.wake.cost_usd)}
        {#if a.wake.msgs_in} · {int(a.wake.msgs_in)} unread{/if}
        {#if a.wake.ended_at != null && a.wake.next_in_minutes != null} · asked to sleep {a.wake.next_in_minutes} min{/if}
        {#if a.wake.exit_reason && a.wake.exit_reason !== 'completed'} · <span class="err">{a.wake.exit_reason}</span>{/if}
      </span>
    {:else if a.kind === 'pull'}<Chip name={a.agent} {runId} /> <span class="muted">has {a.text} forge notification(s); next wake pulled</span>
    {:else if a.kind === 'error'}{#if a.agent}<Chip name={a.agent} {runId} />{/if} {#if a.wakeId}<a href="/wake/{a.wakeId}">error</a>{:else}error{/if}: {truncate(a.text, 300)}
    {:else}<span class="muted">{a.text}</span>{/if}
  </div></li>
{/each}</ul>{:else}<div class="empty">Nothing has happened yet.</div>{/if}
