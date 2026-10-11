<script lang="ts">
  import type { SafeRead } from '../../data.ts'; import { bytes, isMarkdown } from '../../format.ts'; import Clip from './Clip.svelte'; import Time from './Time.svelte';
  let { file, selected, id }: { file: SafeRead; selected: string; id: string } = $props();
</script>
{#if !file.ok}<p class="err">{file.reason}</p>{:else}
<div class="card"><div class="head"><code>{selected}</code><span class="muted small">{bytes(file.size)} · modified <Time ts={file.mtime} /></span></div>
{#if file.truncated}<p class="muted small">Showing the first {bytes(file.text.length)}.</p>{/if}
{#key id}<Clip text={file.text} markdown={isMarkdown(selected)} {id} lines={40} />{/key}
</div>{/if}
