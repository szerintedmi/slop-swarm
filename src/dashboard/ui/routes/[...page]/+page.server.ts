import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
export const load = (async ({ platform, url }) => {
  const model = await platform!.dashboard.page(url);
  if (model.kind === 'missing') error(model.status, model.message);
  if (model.kind === 'file' && !model.file.ok) error(model.file.status, model.file.reason);
  return { model };
}) satisfies PageServerLoad;
