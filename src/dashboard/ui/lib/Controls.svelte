<script lang="ts">
  import type { ControlAction } from '../../../db/index.ts';
  let { runId, agent, readonly, live }: { runId: string; agent?: string; readonly: boolean; live: boolean } = $props();
  const actions = $derived((agent ? [['pause', 'pause'], ['unpause', 'resume'], ['wake', 'wake now']] : [['stop', 'stop run'], ['kill', 'emergency kill']]) as [ControlAction, string][]);
  function confirmAction(event: SubmitEvent, action: ControlAction) {
    const text = action === 'kill' ? 'Emergency kill: docker kill every slopswarm container and stop the run?' : action === 'stop' ? 'Stop the run? No new wakes; running ones finish.' : null;
    if (text && !window.confirm(text)) event.preventDefault();
  }
</script>
{#if !readonly && live}<div class="row">
  {#each actions as [action, label]}<form method="post" action="/control" class="inline" onsubmit={event => confirmAction(event, action)}>
    <input type="hidden" name="run" value={runId} /><input type="hidden" name="action" value={action} />
    {#if agent}<input type="hidden" name="agent" value={agent} />{/if}
    <button class:danger={action === 'kill'}>{label}</button>
  </form>{/each}
</div>{/if}
