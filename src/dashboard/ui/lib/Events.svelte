<script lang="ts">
  import type { PageOf } from '../../service.ts'; import { truncate } from '../../format.ts'; import Chip from './Chip.svelte'; import Time from './Time.svelte';
  let { model }: { model: PageOf<'events'> } = $props();
</script>
<h1>Raw events</h1><p class="sub">The controller's event log, newest first (last 500).</p>
{#if model.events.length}<div class="scroll"><table><thead><tr><th>time</th><th>agent</th><th>kind</th><th>name</th><th></th><th>detail</th></tr></thead><tbody>
{#each model.events as e}<tr><td class="small"><Time ts={e.ts} /></td><td>{#if e.agent}<Chip name={e.agent} runId={model.run.id} />{:else}—{/if}</td><td>{e.kind}</td><td>{e.name ?? ''}</td><td>{#if e.ok != null}<span class={e.ok ? 'ok' : 'err'}>{e.ok ? 'ok' : 'err'}</span>{/if}</td><td>{#if e.wake_id}<a href="/wake/{e.wake_id}">#{e.wake_id}</a> {/if}<code>{truncate(e.detail ?? '', 300)}</code></td></tr>{/each}
</tbody></table></div>{:else}<div class="empty">No events yet.</div>{/if}
