<script lang="ts">
  import Clip from './Clip.svelte';
  let { args, id }: { args: string; id: string } = $props();
  function parse(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }
  const value = $derived(parse(args));
  const obj = $derived(value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
  const content = $derived(typeof obj?.content === 'string' ? obj.content : typeof obj?.new_string === 'string' ? obj.new_string : null);
</script>
{#if obj}
  {#if typeof obj.description === 'string'}<div class="small muted">{obj.description}</div>{/if}
  {#if typeof obj.command === 'string'}<Clip text={obj.command} {id} />
  {:else if typeof obj.file_path === 'string'}<div class="small"><code>{obj.file_path}</code></div>{#if content != null}<Clip text={content} {id} />{/if}
  {:else if typeof obj.query === 'string'}<div>search: <strong>{obj.query}</strong></div>
  {:else}<Clip text={JSON.stringify(value, null, 2)} {id} />{/if}
{:else}<Clip text={value == null ? args : JSON.stringify(value, null, 2)} {id} />{/if}
