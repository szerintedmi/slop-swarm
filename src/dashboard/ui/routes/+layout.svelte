<script lang="ts">
  import { onMount } from 'svelte';
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import type { LayoutProps } from './$types';
  import '../app.css';
  let { data, children }: LayoutProps = $props();
  const q = $derived(data.runId ? `?run=${encodeURIComponent(data.runId)}` : '');
  const live = $derived('model' in page.data && page.data.model && 'live' in page.data.model ? page.data.model.live : false);
  // Live pages refresh every 5 s; idle ones every 20 s, so a page opened before a launch notices the run. Paused while the
  // tab is hidden, a held disclosure (the raw log) is open, or text is selected.
  onMount(() => {
    let refreshing = false;
    let tick = 0;
    const timer = setInterval(async () => {
      tick++;
      if (!live && tick % 4 !== 0) return;
      if (refreshing || document.hidden || document.querySelector('details[data-hold][open]') || String(window.getSelection()).length) return;
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
    <a href="/worlds" class:on={page.url.pathname.startsWith('/world')} aria-current={page.url.pathname.startsWith('/world') ? 'page' : undefined}>Worlds</a>
    <a href="/config" class:on={page.url.pathname === '/config'} aria-current={page.url.pathname === '/config' ? 'page' : undefined}>Config</a>
    {#if data.forgeUrl}<a href={data.forgeUrl} target="_blank" rel="noopener">Forge ↗</a>{/if}
    {#if data.pagesUrl}<a href={data.pagesUrl} target="_blank" rel="noopener">Pages ↗</a>{/if}
  </nav>
  <span class="spacer"></span>
  {#if data.diskLow}<span class="err small" title="free space on the data disk">disk {Math.round(data.diskLow.freeRatio * 100)}% free ({Math.round(data.diskLow.freeBytes / 1073741824 * 10) / 10} GB)</span>{/if}
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
