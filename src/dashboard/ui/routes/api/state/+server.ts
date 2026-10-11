import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = ({ platform, url }) => json(platform!.dashboard.state(url));
