<script lang="ts">import { page } from '$app/state';</script>
<svelte:head><title>{page.status} · Slop Swarm</title></svelte:head>
<h1>{page.status === 404 ? 'Not found' : 'Unable to open page'}</h1>
<p class="err">{page.error?.message}</p>
