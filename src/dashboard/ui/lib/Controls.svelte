<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import type { ControlAction } from '../../../db/index.ts';
  import { apiSend } from './api.ts';
  let { runId, agent, readonly, live }: { runId: string; agent?: string; readonly: boolean; live: boolean } = $props();
  const actions = $derived((agent ? [['pause', 'pause'], ['unpause', 'resume'], ['wake', 'wake now']] : [['stop', 'stop run'], ['kill', 'emergency kill']]) as [ControlAction, string][]);
  let error = $state('');
  // Through the API (src/api.ts); the plain form post to /control is the no-JavaScript fallback.
  async function send(event: SubmitEvent, action: ControlAction) {
    const text = action === 'kill' ? 'Emergency kill: docker kill every slopswarm container and stop the run?' : action === 'stop' ? 'Stop the run? No new wakes; running ones finish.' : null;
    event.preventDefault();
    if (text && !window.confirm(text)) return;
    error = '';
    try {
      const run = encodeURIComponent(runId);
      await apiSend('POST', agent ? `/runs/${run}/agents/${encodeURIComponent(agent)}/${action}` : `/runs/${run}/${action}`, {});
      await invalidateAll();
    } catch (e) { error = (e as Error).message; }
  }
</script>
{#if !readonly && live}<div class="row">
  {#each actions as [action, label]}<form method="post" action="/control" class="inline" onsubmit={event => send(event, action)}>
    <input type="hidden" name="run" value={runId} /><input type="hidden" name="action" value={action} />
    {#if agent}<input type="hidden" name="agent" value={agent} />{/if}
    <button class:danger={action === 'kill'}>{label}</button>
  </form>{/each}
  {#if error}<span class="err small">{error}</span>{/if}
</div>{/if}
