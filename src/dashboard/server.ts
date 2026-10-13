// Embed the SvelteKit Fetch handler in the controller's Bun process.
import type { Database } from 'bun:sqlite';
import type { Server as KitServer, SSRManifest } from '@sveltejs/kit';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Harness, StreamParser } from '../types.ts';
import type { AgentHost } from '../host/agent-host.ts';
import { buildDashboard } from './build.ts';
import { createDashboardService } from './service.ts';
import { createApi, type ApiService } from '../api.ts';
export { fileTree, overviewState } from './data.ts';

export interface DashboardOptions {
  db: Database;
  port: number;
  /** Bind address (default 127.0.0.1; the VPS also binds its tailnet address). */
  hostname?: string;
  readonly?: boolean;
  runId?: string;
  forge?: { runId: string; url: string };
  /** The owner's view of a world's forge, when the service runs it. */
  forgeFor?: (world: string) => string | null;
  /**
   * Host names this server answers to (besides localhost and its bind address): a request for any other Host is
   * refused, so a page that rebinds its own name to this address (DNS rebinding) can't use the API.
   */
  allowedHosts?: string[];
  /** The HTTP API (src/api.ts) on the same server; without `service` it is read-only. */
  api?: { token?: string; service?: ApiService };
  /** The agent host's runner: homes are read live through it while it answers, else from the VPS copy. */
  host?: AgentHost;
  parserFor?: (harness: Harness) => StreamParser | Promise<StreamParser>;
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

/** Whether a request's Host names this server (localhost, the bind address, or a configured name). */
export function hostAllowed(host: string | null, opts: Pick<DashboardOptions, 'hostname' | 'allowedHosts'>): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1').toLowerCase();
  // Bound to every interface with no names given: nothing to check against.
  if (opts.hostname === '0.0.0.0' && !opts.allowedHosts?.length) return true;
  const allowed = new Set(['localhost', '127.0.0.1', '::1', ...(opts.hostname ? [opts.hostname] : []), ...(opts.allowedHosts ?? [])].map(h => h.toLowerCase()));
  return allowed.has(name);
}

export async function startDashboard(opts: DashboardOptions): Promise<{ stop(): void; url: string }> {
  const { kit, assets } = await loadKit();
  const dashboard = createDashboardService(opts);
  const api = createApi({ db: opts.db, readonly: opts.readonly || !opts.api?.service, token: opts.api?.token, host: opts.host, service: opts.api?.service });
  const server = Bun.serve({
    hostname: opts.hostname ?? '127.0.0.1', port: opts.port,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (!hostAllowed(req.headers.get('host'), opts)) return new Response('unknown host', { status: 421 });
      const fromApi = await api(req);
      if (fromApi) return fromApi;
      const asset = assets.get(url.pathname);
      if (asset && (req.method === 'GET' || req.method === 'HEAD')) return new Response(req.method === 'HEAD' ? null : Bun.file(asset), {
        headers: { 'content-type': Bun.file(asset).type, 'cache-control': url.pathname.startsWith('/_app/immutable/') ? 'public, max-age=31536000, immutable' : 'no-cache' }
      });
      return kit.respond(req, { platform: { dashboard }, getClientAddress: () => server.requestIP(req)?.address ?? '127.0.0.1' });
    },
  });
  const shown = !opts.hostname || opts.hostname === '127.0.0.1' ? 'localhost' : opts.hostname;
  return { url: `http://${shown}:${server.port}`, stop: () => { server.stop(true); } };
}
