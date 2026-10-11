<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { mdLite } from '../../format.ts';
  let { text, markdown = false, lines = 8, id }: { text: string; markdown?: boolean; lines?: number; id: string } = $props();
  let open = $state(false), overflow = $state(false), body: HTMLElement;
  onMount(() => {
    try { open = sessionStorage.getItem(`clip:${id}`) === '1'; } catch { /* storage unavailable */ }
    const measure = () => { if (!open) overflow = body.scrollHeight > body.clientHeight + 4; };
    const observer = new ResizeObserver(measure); observer.observe(body); measure();
    return () => observer.disconnect();
  });
  // Usage/text can grow while a wake is live without changing the element's dimensions.
  $effect(() => { void text; void lines; tick().then(() => { if (body && !open) overflow = body.scrollHeight > body.clientHeight + 4; }); });
  function toggle() { open = !open; try { sessionStorage.setItem(`clip:${id}`, open ? '1' : '0'); } catch { /* storage unavailable */ } }
</script>
<div class="clip" class:open style="--lines:{lines}">
  <div class="clip-body" bind:this={body}>{#if markdown}{@html mdLite(text)}{:else}<pre>{text}</pre>{/if}</div>
  <button type="button" class="more" hidden={!overflow && !open} onclick={toggle}>{open ? 'show less' : 'show more'}</button>
</div>
