// Embed the SvelteKit Fetch handler in the controller's Bun process.
import type { Database } from 'bun:sqlite';
import type { Server as KitServer, SSRManifest } from '@sveltejs/kit';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Runtime, StreamParser } from '../types.ts';
import { buildDashboard } from './build.ts';
import { createDashboardService } from './service.ts';
export { fileTree, overviewState } from './data.ts';

export interface DashboardOptions {
  db: Database;
  port: number;
  readonly?: boolean;
  runId?: string;
  forge?: { runId: string; url: string };
  parserFor?: (runtime: Runtime) => StreamParser | Promise<StreamParser>;
}

interface Kit { kit: KitServer; assets: Map<string, string> }
// One SvelteKit server per build directory; a failed load is dropped so the next start retries.
const kits = new Map<string, Promise<Kit>>();
async function loadKit(): Promise<Kit> {
  const dir = await buildDashboard();
  let kit = kits.get(dir);
  if (!kit) {
    kit = (async () => {
      const { Server } = await import(pathToFileURL(join(dir, 'server/index.js')).href) as { Server: new (manifest: SSRManifest) => KitServer };
      const { manifest } = await import(pathToFileURL(join(dir, 'server/manifest.js')).href) as { manifest: SSRManifest };
      const kit = new Server(manifest);
      // No application secrets need to be exposed to SvelteKit's environment modules.
      await kit.init({ env: {} });
      const assets = new Map<string, string>();
      function walk(path: string, prefix = '') {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const child = join(path, entry.name), url = `${prefix}/${entry.name}`;
          if (entry.isDirectory()) walk(child, url);
          else if (entry.isFile()) assets.set(url, child);
        }
      }
      walk(join(dir, 'client'));
      return { kit, assets };
    })();
    kits.set(dir, kit);
    kit.catch(() => kits.delete(dir));
  }
  return kit;
}

export async function startDashboard(opts: DashboardOptions): Promise<{ stop(): void; url: string }> {
  const { kit, assets } = await loadKit();
  const dashboard = createDashboardService(opts);
  const server = Bun.serve({
    hostname: '127.0.0.1', port: opts.port,
    async fetch(req, server) {
      const url = new URL(req.url);
      const asset = assets.get(url.pathname);
      if (asset && (req.method === 'GET' || req.method === 'HEAD')) return new Response(req.method === 'HEAD' ? null : Bun.file(asset), {
        headers: { 'content-type': Bun.file(asset).type, 'cache-control': url.pathname.startsWith('/_app/immutable/') ? 'public, max-age=31536000, immutable' : 'no-cache' }
      });
      return kit.respond(req, { platform: { dashboard }, getClientAddress: () => server.requestIP(req)?.address ?? '127.0.0.1' });
    },
  });
  return { url: `http://localhost:${server.port}`, stop: () => { server.stop(true); } };
}
