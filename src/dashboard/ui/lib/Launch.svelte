<script lang="ts">
  import { goto } from '$app/navigation';
  import { launch } from './api.ts';
  let { presets, worlds, world = '' }: { presets: string[]; worlds: { id: string; activeRun: string | null; status: string }[]; world?: string } = $props();
  let preset = $state('');
  let target = $state('');
  let brief = $state('');
  let busy = $state(false);
  let error = $state('');
  $effect(() => { if (!preset) preset = presets.includes('smoke') ? 'smoke' : (presets[0] ?? ''); });
  $effect(() => { target = world; });
  async function go(event: SubmitEvent) {
    event.preventDefault();
    busy = true; error = '';
    try {
      const run = await launch({ preset, world: target || undefined, brief: brief.trim() || undefined });
      await goto(`/?run=${encodeURIComponent(run)}`);
    } catch (e) { error = (e as Error).message; } finally { busy = false; }
  }
</script>
<form class="card launch" onsubmit={go}>
  <div class="row">
    <label>preset <select bind:value={preset} required>{#each presets as p}<option value={p}>{p}</option>{/each}</select></label>
    <label>world <select bind:value={target}>
      <option value="">a new world</option>
      {#each worlds.filter(w => w.status !== 'archived') as w}<option value={w.id} disabled={!!w.activeRun}>continue {w.id}{w.activeRun ? ' (active)' : ''}</option>{/each}
    </select></label>
  </div>
  <label class="block">run brief (optional: added to each agent's first wake note)<textarea bind:value={brief} rows="2" placeholder="e.g. bramble/pubrepo has open PRs"></textarea></label>
  <div class="row"><button disabled={busy || !preset}>{busy ? 'launching…' : 'launch'}</button>{#if error}<span class="err small">{error}</span>{/if}</div>
</form>
