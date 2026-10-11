<script lang="ts">
  import type { PageProps } from './$types';
  import Overview from '$lib/Overview.svelte'; import Agents from '$lib/Agents.svelte'; import Agent from '$lib/Agent.svelte'; import Events from '$lib/Events.svelte'; import Wake from '$lib/Wake.svelte'; import FileViewer from '$lib/FileViewer.svelte'; import Chip from '$lib/Chip.svelte';
  let { data }: PageProps = $props();
  const m = $derived(data.model);
  const title = $derived(m.kind === 'overview' ? m.run.name : m.kind === 'agent' ? m.agent.name : m.kind === 'wake' ? `${m.wake.agent} #${m.wake.seq}` : m.kind === 'events' ? 'Raw events' : m.kind === 'file' ? 'File' : m.kind === 'agents' ? 'Agents' : 'Slop Swarm');
</script>
<svelte:head><title>{title} · Slop Swarm</title></svelte:head>
{#if m.kind === 'overview'}<Overview model={m} />
{:else if m.kind === 'agents'}<Agents model={m} />
{:else if m.kind === 'agent'}{#key `${m.run.id}:${m.agent.name}`}<Agent model={m} />{/key}
{:else if m.kind === 'events'}<Events model={m} />
{:else if m.kind === 'wake'}{#key m.wake.id}<Wake model={m} />{/key}
{:else if m.kind === 'file'}<h1>File</h1><p class="sub"><Chip name={m.name} runId={m.run.id} /> home</p><FileViewer file={m.file} selected={m.selected} id="file-{m.run.id}-{m.name}-{m.selected}" />
{:else}<h1>No runs yet</h1><p class="muted">Start one with <code>just smoke</code> or <code>just up</code>.</p>{/if}
