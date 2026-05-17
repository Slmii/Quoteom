import { AdminEmailGuard } from '@/common/guards/admin-email.guard';
import { AIUsageController } from '@/modules/ai-usage/ai-usage.controller';
import { AIUsageService } from '@/modules/ai-usage/ai-usage.service';
import { Module } from '@nestjs/common';

/**
 * Dev/admin endpoints around the `AICall` audit log. Today: token + cost dashboard.
 * Later: will likely grow per-org cost breakdowns the way the usage-tier billing model
 * will need them.
 *
 * `AdminEmailGuard` extends `AuthGuard` (no separate provider needed for the auth check
 * — same pattern as `OrganizationGuard`).
 */
@Module({
	controllers: [AIUsageController],
	providers: [AIUsageService, AdminEmailGuard]
})
export class AIUsageModule {}
