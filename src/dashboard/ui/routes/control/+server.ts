import type { RequestHandler } from './$types';
export const POST: RequestHandler = ({ platform, request }) => platform!.dashboard.control(request);
