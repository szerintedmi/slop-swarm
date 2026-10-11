<script lang="ts">
  import { onMount } from 'svelte';
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import type { LayoutProps } from './$types';
  import '../app.css';
  let { data, children }: LayoutProps = $props();
  const q = $derived(data.runId ? `?run=${encodeURIComponent(data.runId)}` : '');
  const live = $derived('model' in page.data && page.data.model && 'live' in page.data.model ? page.data.model.live : false);
  onMount(() => {
    let refreshing = false;
    const timer = setInterval(async () => {
      if (!live || refreshing || document.hidden || document.querySelector('details[data-hold][open]') || String(window.getSelection()).length) return;
      refreshing = true;
      try { await invalidateAll(); } catch { /* retry on the next tick */ } finally { refreshing = false; }
    }, 5000);
    return () => clearInterval(timer);
  });
</script>
<header class="top">
  <span class="brand">Slop Swarm</span>
  <nav class="tabs">
    <a href="/{q}" class:on={page.url.pathname === '/'} aria-current={page.url.pathname === '/' ? 'page' : undefined}>Overview</a>
    <a href="/agents{q}" class:on={page.url.pathname.startsWith('/agent')} aria-current={page.url.pathname.startsWith('/agent') ? 'page' : undefined}>Agents</a>
    {#if data.forgeUrl}<a href={data.forgeUrl} target="_blank" rel="noopener">Forge ↗</a>{/if}
  </nav>
  <span class="spacer"></span>
  {#if data.live}<span class="live">live</span>{/if}
  {#if data.readonly}<span class="ro">read-only</span>{/if}
  {#if data.runs.length}
    <form method="get" action="/" class="inline">
      <select name="run" aria-label="run" value={data.runId ?? ''} onchange={(event) => goto(`/?run=${encodeURIComponent(event.currentTarget.value)}`)}>
        {#each data.runs as run}<option value={run.id}>{run.id} · {run.status}</option>{/each}
      </select>
      <noscript><button>go</button></noscript>
    </form>
  {/if}
</header>
<main data-live={live ? '1' : undefined}>{@render children()}</main>
