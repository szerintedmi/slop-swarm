<script lang="ts">
  import { agentHue } from '../../format.ts';
  let { name, runId, link = true }: { name: string; runId: string; link?: boolean } = $props();
</script>
{#if link}<a class="chip" style="--h:{agentHue(name)}" href="/agent/{encodeURIComponent(name)}?run={encodeURIComponent(runId)}"><span class="dot"></span>{name}</a>
{:else}<span class="chip" style="--h:{agentHue(name)}"><span class="dot"></span>{name}</span>{/if}
