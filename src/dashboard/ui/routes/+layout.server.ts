import type { LayoutServerLoad } from './$types';
export const load: LayoutServerLoad = ({ platform, url }) => platform!.dashboard.nav(url);
