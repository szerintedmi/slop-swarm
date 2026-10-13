// The dashboard's writes go through the controller's HTTP API (src/api.ts), like the CLI's.
export class ApiError extends Error {}

export async function apiSend<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: { 'x-slopswarm': 'dashboard', 'x-slopswarm-source': 'dashboard', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* text */ }
  if (!res.ok) throw new ApiError((data as { error?: string })?.error ?? `${res.status} ${text}`);
  return data as T;
}

/** Launch a run and wait for the controller to take it: the run id, or the reason it was refused. */
export async function launch(r: { preset: string; world?: string; brief?: string }): Promise<string> {
  const { id } = await apiSend<{ id: number }>('POST', '/launches', r);
  for (;;) {
    const l = await apiSend<{ status: string; run?: string; error?: string }>('GET', `/launches/${id}`);
    if (l.status === 'done') return l.run!;
    if (l.status === 'failed') throw new ApiError(l.error ?? 'launch failed');
    await new Promise(res => setTimeout(res, 500));
  }
}
