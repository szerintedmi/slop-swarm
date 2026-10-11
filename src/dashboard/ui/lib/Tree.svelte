<script lang="ts">
  import type { TreeNode } from '../../data.ts'; import { bytes } from '../../format.ts'; import Disclosure from './Disclosure.svelte'; import Time from './Time.svelte';
  let { nodes, selected, base, treeKey, prefix = '' }: { nodes: TreeNode[]; selected: string; base: string; treeKey: string; prefix?: string } = $props();
  const ordered = $derived(nodes.filter(n => n.kind === 'file' || n.kind === 'dir' || n.truncated).toSorted((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name)));
</script>
{#snippet branch(items: TreeNode[], parent: string)}
<ul class="tree">{#each items as n (n.name)}
  {@const path = parent + n.name}
  {#if n.kind === 'other'}<li class="x"><span class="nm muted">… more entries not listed</span></li>
  {:else if n.kind === 'file'}<li class:on={path === selected}><a href="{base}{encodeURIComponent(path)}" aria-current={path === selected ? 'true' : undefined}><span class="nm">{n.name}</span><span class="meta">{bytes(n.size)} · <Time ts={n.mtime} /></span></a></li>
  {:else if n.opaque}<li class="x"><span class="nm">{n.name}/</span><span class="meta">not listed</span></li>
  {:else}
    {@const kids = (n.children ?? []).filter(k => k.kind === 'file' || k.kind === 'dir' || k.truncated).toSorted((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name))}
    {@const count = kids.filter(k => k.kind === 'file' || k.kind === 'dir').length}
    {@const meta = n.truncated ? 'too deep, not listed' : count ? `${count} item${count === 1 ? '' : 's'}` : 'empty'}
    {#if n.truncated || !count}<li class="x"><span class="nm">{n.name}/</span><span class="meta">{meta}</span></li>
    {:else}<li><Disclosure id="{treeKey}:{path}" defaultOpen={selected.startsWith(path + '/')}><summary><span class="nm">{n.name}/</span><span class="meta">{meta}</span></summary>{@render branch(kids, path + '/')}</Disclosure></li>{/if}
  {/if}
{/each}</ul>
{/snippet}
{@render branch(ordered, prefix)}
