<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import type { PageOf } from '../../service.ts'; import Time from './Time.svelte';
  import { apiSend } from './api.ts';
  let { model }: { model: PageOf<'config'> } = $props();
  const rows = $derived(model.tab === 'agents' ? model.agents : model.presets);
  const kind = $derived(model.tab === 'agents' ? 'agents' : 'presets');
  const editing = $derived(model.edit === '+' ? { name: '', yaml: '', updated_at: 0 } : rows.find(r => r.name === model.edit) ?? null);
  let name = $state('');
  let yaml = $state('');
  let seedText = $state('');
  let seedName = $state('');
  let note = $state('');
  const seedNames = $derived([...new Set(model.seeds.map(s => s.name))]);
  let error = $state('');
  let saved = $state('');
  $effect(() => { name = editing?.name ?? ''; yaml = editing?.yaml ?? ''; error = ''; saved = ''; });
  // A new seed starts from the text of the one shown, so a variant doesn't begin from an empty page.
  $effect(() => { seedText = model.seed?.text ?? ''; seedName = model.newSeed ? '' : (model.seed?.name ?? ''); });
  async function save(event: SubmitEvent) {
    event.preventDefault();
    error = ''; saved = '';
    try {
      await apiSend('PUT', `/${kind}/${encodeURIComponent(name.trim())}`, { yaml });
      saved = 'saved';
      await goto(`/config?tab=${model.tab}&edit=${encodeURIComponent(name.trim())}`, { invalidateAll: true });
    } catch (e) { error = (e as Error).message; }
  }
  async function remove() {
    if (!editing || !window.confirm(`Delete ${kind === 'agents' ? 'agent profile' : 'preset'} ${editing.name}?`)) return;
    try { await apiSend('DELETE', `/${kind}/${encodeURIComponent(editing.name)}`); await goto(`/config?tab=${model.tab}`, { invalidateAll: true }); } catch (e) { error = (e as Error).message; }
  }
  async function saveSeed(event: SubmitEvent) {
    event.preventDefault();
    error = '';
    try { const s = await apiSend<{ id: number }>('POST', '/seeds', { name: seedName.trim(), text: seedText, note: note || undefined }); note = ''; await goto(`/config?tab=seeds&seed=${s.id}`, { invalidateAll: true }); } catch (e) { error = (e as Error).message; }
  }
  async function activate(id: number) {
    try { await apiSend('POST', `/seeds/${id}/activate`, {}); await invalidateAll(); } catch (e) { error = (e as Error).message; }
  }
  async function removeSeed(name: string) {
    if (!window.confirm(`Delete seed ${name} with all its versions?`)) return;
    try { await apiSend('DELETE', `/seeds/${encodeURIComponent(name)}`); await goto('/config?tab=seeds', { invalidateAll: true }); } catch (e) { error = (e as Error).message; }
  }
</script>
<h1>Config</h1>
<p class="sub">Presets, agent profiles and the seeds (a preset picks one with <code>seed:</code>; <code>default</code> when it names none) live in the controller's DB and are validated on save; every run freezes a snapshot of what it ran with. The egress allowlist and container limits are <code>config/host.yaml</code>, deployed with the controller.</p>
<nav class="tabs" style="margin-bottom:10px">{#each [['presets', `presets · ${model.presets.length}`], ['agents', `agent profiles · ${model.agents.length}`], ['seeds', `seeds · ${seedNames.length}`]] as [t, label]}<a href="/config?tab={t}" class:on={t === model.tab}>{label}</a>{/each}</nav>
{#if model.tab !== 'seeds'}
<div class="split"><div class="card treebox"><ul class="tree">
  {#each rows as r}<li class:on={r.name === model.edit}><a href="/config?tab={model.tab}&edit={encodeURIComponent(r.name)}"><span class="nm">{r.name}</span><span class="meta"><Time ts={r.updated_at} /></span></a></li>{/each}
  {#if !model.readonly}<li class:on={model.edit === '+'}><a href="/config?tab={model.tab}&edit=%2B"><span class="nm">+ new</span></a></li>{/if}
</ul></div><div class="viewer">
{#if editing}<form class="card" onsubmit={save}>
  <label class="block">name <input bind:value={name} required readonly={model.edit !== '+'} /></label>
  <label class="block">YAML<textarea class="code" bind:value={yaml} rows="24" spellcheck="false" readonly={model.readonly}></textarea></label>
  {#if !model.readonly}<div class="row"><button>save</button>{#if model.edit !== '+'}<button type="button" class="danger" onclick={remove}>delete</button>{/if}{#if saved}<span class="ok small">{saved}</span>{/if}{#if error}<span class="err small">{error}</span>{/if}</div>{/if}
</form>{:else}<div class="empty">Pick one to view or edit.</div>{/if}
</div></div>
{:else}
<div class="split"><div class="card treebox"><ul class="tree">
  {#each seedNames as n}<li class="group"><span class="nm">{n}</span></li>
    {#each model.seeds.filter(s => s.name === n) as s}<li class="v" class:on={!model.newSeed && s.id === model.seed?.id}><a href="/config?tab=seeds&seed={s.id}"><span class="nm">v{s.id}{s.active ? ' · active' : ''}</span><span class="meta"><Time ts={s.created_at} /></span></a></li>{/each}
  {/each}
  {#if !model.readonly}<li class:on={model.newSeed}><a href="/config?tab=seeds&name=%2B"><span class="nm">+ new seed</span></a></li>{/if}
</ul></div><div class="viewer">
{#if model.newSeed}<form class="card" onsubmit={saveSeed}>
  <label class="block">name <input bind:value={seedName} required pattern="[a-z0-9][a-z0-9_\-]{'{'}0,40{'}'}" placeholder="e.g. shock" /></label>
  <label class="block">text{#if model.seed} (starting from {model.seed.name} v{model.seed.id}){/if}<textarea class="code" bind:value={seedText} rows="24" spellcheck="false"></textarea></label>
  <div class="row"><input bind:value={note} placeholder="note for v1" /><button>create</button>{#if error}<span class="err small">{error}</span>{/if}</div>
</form>{:else if model.seed}<form class="card" onsubmit={saveSeed}>
  <div class="head"><span>{model.seed.name} v{model.seed.id}{model.seed.active ? ' (active)' : ''} · <code>{model.seed.sha256.slice(0, 12)}</code>{model.seed.note ? ` · ${model.seed.note}` : ''}</span>{#if !model.readonly}<span class="row">{#if !model.seed.active}<button type="button" onclick={() => activate(model.seed!.id)}>make active</button>{/if}{#if model.seed.name !== 'default'}<button type="button" class="danger" onclick={() => removeSeed(model.seed!.name)}>delete seed</button>{/if}</span>{/if}</div>
  <textarea class="code" bind:value={seedText} rows="24" spellcheck="false" readonly={model.readonly}></textarea>
  {#if !model.readonly}<div class="row"><input bind:value={note} placeholder="note for the new version" /><button disabled={seedText === model.seed.text}>save as a new version of {model.seed.name}</button>{#if error}<span class="err small">{error}</span>{/if}</div>{/if}
</form>{:else}<div class="empty">No seed yet.</div>{/if}
</div></div>
{/if}
