import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { writeFileSync } from 'node:fs';

// Emit a Fetch handler for the existing Bun server, rather than a second process/server.
export default {
  preprocess: vitePreprocess(),
  kit: {
    files: {
      routes: 'src/dashboard/ui/routes', lib: 'src/dashboard/ui/lib',
      appTemplate: 'src/dashboard/ui/app.html'
    },
    adapter: {
      name: 'embedded-bun',
      async emulate() {
        // Native Bun imports preserve SQL text/SQLite and worktree paths. Initialize lazily
        // on a development/preview request; compiling the UI must not open the run database.
        let dashboard;
        return {
          async platform() {
            dashboard ??= (async () => {
              const { openDb, DB_PATH } = await import('./src/db/index.ts');
              const { createDashboardService } = await import('./src/dashboard/service.ts');
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
        writeFileSync(`${out}/server/manifest.js`, `export const manifest = ${builder.generateManifest({ relativePath: '.' })};`);
      }
    }
  }
};
