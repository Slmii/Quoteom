import { api } from '@/lib/api/client';
import {
	getInvitationsServer,
	getMembershipsServer,
	getMyMembershipServer,
	getMyOrganizationsServer
} from '@/lib/api/team.api';
import { BillingKeys } from '@/lib/queries/billing.queries';
import type { CreateInvitationInput, Invitation, Membership } from '@quoteom/shared';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';

const TeamKeys = {
	memberships: ['team', 'memberships'] as const,
	myMembership: ['team', 'my-membership'] as const,
	myOrganizations: ['team', 'my-organizations'] as const,
	invitations: ['team', 'invitations'] as const
};

export const membershipsQueryOptions = queryOptions({
	queryKey: TeamKeys.memberships,
	queryFn: getMembershipsServer,
	staleTime: 30_000
});

/** Single membership for the current user in the active org — use for role checks. */
export const myMembershipQueryOptions = queryOptions({
	queryKey: TeamKeys.myMembership,
	queryFn: getMyMembershipServer,
	staleTime: 30_000
});

/** All orgs the current user is a member of (for the org switcher). */
export const myOrganizationsQueryOptions = queryOptions({
	queryKey: TeamKeys.myOrganizations,
	queryFn: getMyOrganizationsServer,
	staleTime: 30_000
});

export function useSwitchOrganization() {
	const queryClient = useQueryClient();
	const router = useRouter();
	return useMutation({
		mutationFn: (organizationId: string) => {
			return api<Membership>('/api/me/switch-organization', {
				method: 'POST',
				body: { organizationId }
			});
		},
		onSuccess: async () => {
			// Active-org context changed: every cached query is potentially stale.
			// Cheapest correct thing is to nuke the cache + force the router to refetch
			// its loaders. Subsequent loaders will see the new org via OrganizationGuard.
			queryClient.clear();
			await router.invalidate();
		}
	});
}

export const invitationsQueryOptions = queryOptions({
	queryKey: TeamKeys.invitations,
	queryFn: getInvitationsServer,
	staleTime: 30_000
});

export function useCreateInvitation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: CreateInvitationInput) => api<Invitation>('/api/invitations', { method: 'POST', body }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: TeamKeys.invitations });
			// Seat counts on the billing status panel may change too — invalidate so
			// the next /billing view reflects the new pending invitation.
			void queryClient.invalidateQueries({ queryKey: BillingKeys.status });
		}
	});
}

export function useRevokeInvitation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (invitationId: string) => api<void>(`/api/invitations/${invitationId}`, { method: 'DELETE' }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: TeamKeys.invitations });
			void queryClient.invalidateQueries({ queryKey: BillingKeys.status });
		}
	});
}

/**
 * Remove a member from the active org. Owner-only on the server; the UI hides the button
 * for non-owners, but a direct call would still 403.
 *
 * Invalidates memberships (the row disappears) AND billing status (seat count decreases →
 * different overage math) on success.
 */
export function useRemoveMember() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (userId: string) => api<void>(`/api/me/memberships/${userId}`, { method: 'DELETE' }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: TeamKeys.memberships });
			void queryClient.invalidateQueries({ queryKey: BillingKeys.status });
		}
	});
}
