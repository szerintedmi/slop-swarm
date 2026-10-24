import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Vite bundles this file; a computed specifier keeps the controller's modules out of the bundle (Bun imports them natively).
const controllerModule = (path: string) => import(new URL(`./src/${path}`, import.meta.url).href);

// Emit a Fetch handler for the existing Bun server, rather than a second process/server.
export default defineConfig({
  plugins: [sveltekit({
    preprocess: vitePreprocess(),
    files: {
      routes: 'src/dashboard/ui/routes',
      appTemplate: 'src/dashboard/ui/app.html'
    },
    adapter: {
      name: 'embedded-bun',
      async emulate() {
        // Native Bun imports preserve SQL text/SQLite and worktree paths. Initialize lazily
        // on a development/preview request; compiling the UI must not open the run database.
        let dashboard: Promise<unknown> | undefined;
        return {
          async platform() {
            dashboard ??= (async () => {
              const { openDb, DB_PATH } = await controllerModule('db/index.ts');
              const { createDashboardService } = await controllerModule('dashboard/service.ts');
              openDb().close();
              return createDashboardService({ db: openDb(DB_PATH, { readonly: true }), port: 0, readonly: true });
            })();
            return { dashboard: await dashboard };
          }
        };
      },
      async adapt(builder) {
        // The CLI picks a fresh directory per build (src/dashboard/build.ts); a plain `vite build` uses build/dashboard/dev.
        const out = process.env.SLOPSWARM_DASHBOARD_OUT ?? 'build/dashboard/dev';
        builder.rimraf(out);
        builder.writeClient(`${out}/client`);
        builder.writeServer(`${out}/server`);
        builder.generateServerInstance(`${out}/server/instance.js`, { serverDirectory: `${out}/server` });
      }
    }
  })],
  envDir: false
});
