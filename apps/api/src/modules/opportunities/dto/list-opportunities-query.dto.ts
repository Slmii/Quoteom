import {
	OPPORTUNITY_DISMISSED_FILTERS,
	OPPORTUNITY_SORTS,
	OPPORTUNITY_STATUSES,
	type OpportunityDismissedFilter,
	type OpportunitySort,
	type OpportunityStatus
} from '@quoteom/shared';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Query params for `GET /api/opportunities`.
 * - `cursor`: opaque base64url cursor from a prior page's `nextCursor`.
 * - `limit`: server-clamped to [1, 100], default 25.
 * - `status`: optional filter on `OpportunityStatus`. Cursor pagination respects it.
 * - `sort`: optional ordering. Cursor pagination is only stable when paired with the
 *   matching sort field — see `OpportunityListCursor` for the keyset shape.
 */
export class ListOpportunitiesQueryDto {
	@IsOptional()
	@IsString()
	cursor?: string;

	@IsOptional()
	@Type(() => Number)
	@Transform(({ value }) => (typeof value === 'string' ? Number(value) : value))
	@IsInt()
	@Min(1)
	@Max(100)
	limit?: number;

	@IsOptional()
	@IsIn(OPPORTUNITY_STATUSES)
	status?: OpportunityStatus;

	@IsOptional()
	@IsIn(OPPORTUNITY_SORTS)
	sort?: OpportunitySort;

	/**
	 * Free-text search across `customerName`, `address`, `requestType`, `fromName`, and
	 * `subject` via case-insensitive `ILIKE`. Empty/whitespace-only is ignored. Capped
	 * server-side to 80 chars to bound the query plan (and prevent the user from
	 * accidentally pasting a 5KB email body into the box).
	 */
	@IsOptional()
	@IsString()
	@MaxLength(80)
	search?: string;

	/**
	 * W4.6 — Whether to include dismissed rows. Default behavior (omitted) is `active`
	 * (hide dismissed). The web "Toon afgewezen" toggle sends `dismissed`. `all`
	 * exists mostly for tests + the future admin precision panel.
	 */
	@IsOptional()
	@IsIn(OPPORTUNITY_DISMISSED_FILTERS)
	dismissed?: OpportunityDismissedFilter;
}
