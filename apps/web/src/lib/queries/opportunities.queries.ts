import { listOpportunitiesServer } from '@/lib/api/opportunities.api';
import { api } from '@/lib/api/client';
import type {
	DismissOpportunityInput,
	Opportunity,
	OpportunityDismissedFilter,
	OpportunityStatus
} from '@quoteom/shared';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

export const OpportunityKeys = {
	all: ['opportunities'] as const,
	list: (status: OpportunityStatus | null, search: string | null, dismissed: OpportunityDismissedFilter | null) =>
		['opportunities', 'list', { status, search: search?.trim() || null, dismissed: dismissed ?? 'active' }] as const
};

/**
 * First page of opportunities for the active org. Status + search + dismissed are part
 * of the query key, so each filter combination has its own cache entry and `Load more`
 * mutations only affect the page the user is viewing. `staleTime` is intentionally
 * short — the user expects brand-new emails to surface within seconds of arrival.
 */
export const opportunitiesListQueryOptions = (
	status: OpportunityStatus | null,
	search: string | null = null,
	dismissed: OpportunityDismissedFilter | null = null
) =>
	queryOptions({
		queryKey: OpportunityKeys.list(status, search, dismissed),
		queryFn: () => listOpportunitiesServer({ data: { status, search, dismissed, limit: 25 } }),
		staleTime: 15_000
	});

/**
 * PATCH /api/opportunities/:id/status — inline status change from the list row. On
 * success we invalidate every opportunities cache (filtered + unfiltered) so the row
 * disappears/appears under the right tab without manual refresh.
 */
export function useUpdateOpportunityStatus() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, status }: { id: string; status: OpportunityStatus }) =>
			api<Opportunity>(`/api/opportunities/${id}/status`, {
				method: 'PATCH',
				body: { status }
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: OpportunityKeys.all });
		}
	});
}

/**
 * W4.6 — `PATCH /api/opportunities/:id/dismiss`. Invalidates every opportunities cache
 * so the dismissed row disappears from the default list and shows up under the
 * "Toon afgewezen" view in the same tick.
 */
export function useDismissOpportunity() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, reason, notes }: { id: string } & DismissOpportunityInput) =>
			api<Opportunity>(`/api/opportunities/${id}/dismiss`, {
				method: 'PATCH',
				body: { reason, notes }
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: OpportunityKeys.all });
		}
	});
}

/**
 * W4.6 — `DELETE /api/opportunities/:id/dismiss`. Reverses a dismiss; the row returns
 * to the default list under whatever `status` it had before.
 */
export function useUndismissOpportunity() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id }: { id: string }) =>
			api<Opportunity>(`/api/opportunities/${id}/dismiss`, {
				method: 'DELETE'
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: OpportunityKeys.all });
		}
	});
}
