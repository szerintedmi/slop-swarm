import type { RequestHandler } from './$types';
export const GET: RequestHandler = ({ platform, params }) => platform!.dashboard.rawLog(Number(params.id));
