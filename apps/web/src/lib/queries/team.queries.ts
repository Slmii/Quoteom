import { api } from '@/lib/api/client';
import {
	getInvitationsServer,
	getMembershipsServer,
	getMyMembershipServer,
	type Invitation,
	type MembershipRole
} from '@/lib/api/team.api';
import { BillingKeys } from '@/lib/queries/billing.queries';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

export type { Invitation, Membership, MembershipRole, MembershipUser } from '@/lib/api/team.api';

const TeamKeys = {
	memberships: ['team', 'memberships'] as const,
	myMembership: ['team', 'my-membership'] as const,
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

export const invitationsQueryOptions = queryOptions({
	queryKey: TeamKeys.invitations,
	queryFn: getInvitationsServer,
	staleTime: 30_000
});

interface CreateInvitationBody {
	email: string;
	role?: MembershipRole;
}

export function useCreateInvitation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: CreateInvitationBody) => api<Invitation>('/api/invitations', { method: 'POST', body }),
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
