# SvelteKit dashboard migration

Status: done (2026-10-11)

- [x] Replace HTML-string pages and DOM swapping with Svelte components, SvelteKit routing and reactive refresh.
- [x] Embed SvelteKit in the existing Bun CLI server, retain controls/API and startup/stop semantics, and build automatically when stale.
- [x] Preserve file confinement, transcript/request accounting, readonly mode, run selection and forge links.
- [x] Document build/development workflow; verify dashboard integration, `just test`, `just typecheck` and a production build.

Validation: `just ui-build` passed; `just test` passed (103 tests); `just typecheck` passed with zero Svelte errors/warnings. Browser QA verified hydration, navigation, live spend updates, directory/text persistence and readonly development mode. Build failures are checked before creating a run or changing Docker containers.
