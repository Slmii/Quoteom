import { serverFetch } from '@/lib/api/server-fetch';
import type { OpportunityDismissedFilter, OpportunityList, OpportunityStatus } from '@quoteom/shared';
import { createServerFn } from '@tanstack/react-start';

export interface ListOpportunitiesInput {
	cursor?: string | null;
	limit?: number | null;
	status?: OpportunityStatus | null;
	search?: string | null;
	dismissed?: OpportunityDismissedFilter | null;
}

/**
 * Isomorphic GET /api/opportunities — same code path SSR + client via `createServerFn`.
 * `cursor` + `status` + `search` + `dismissed` are forwarded as query params; the API
 * treats nulls/undefineds as "no filter" so the FE doesn't need to build query strings
 * conditionally itself.
 */
export const listOpportunitiesServer = createServerFn({ method: 'GET' })
	.inputValidator((data: ListOpportunitiesInput) => data)
	.handler(async ({ data }): Promise<OpportunityList> => {
		const params = new URLSearchParams();
		if (data.cursor) {
			params.set('cursor', data.cursor);
		}

		if (data.limit !== null && data.limit !== undefined) {
			params.set('limit', String(data.limit));
		}

		if (data.status) {
			params.set('status', data.status);
		}

		const trimmedSearch = data.search?.trim();
		if (trimmedSearch) {
			params.set('search', trimmedSearch);
		}

		// `active` is the server default, no need to spend a query-string slot on it.
		if (data.dismissed && data.dismissed !== 'active') {
			params.set('dismissed', data.dismissed);
		}

		const qs = params.toString();
		const response = await serverFetch(`/api/opportunities${qs ? `?${qs}` : ''}`);
		if (!response.ok) {
			throw new Error(`Failed to load opportunities (${response.status})`);
		}

		return (await response.json()) as OpportunityList;
	});
