import type { DashboardService } from '../service.ts';
declare global { namespace App { interface Platform { dashboard: DashboardService } } }
export {};
