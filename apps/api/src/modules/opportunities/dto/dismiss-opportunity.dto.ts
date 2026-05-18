import { OPPORTUNITY_DISMISS_REASONS, type DismissOpportunityInput } from '@quoteom/shared';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Request body for `PATCH /api/opportunities/:id/dismiss`. `notes` is captured into
 * the audit-log breadcrumb only (`LogService.logAction` metadata), not persisted on
 * the row — keeps the row schema simple, and the audit trail already has the right
 * retention + actor context.
 */
export class DismissOpportunityDto implements DismissOpportunityInput {
	@IsIn(OPPORTUNITY_DISMISS_REASONS)
	reason!: DismissOpportunityInput['reason'];

	@IsOptional()
	@IsString()
	@MaxLength(500)
	notes?: string;
}
