import { api } from '@/lib/api/client';
import type { AcceptInvitationResponse } from '@quoteom/shared';
import { useMutation } from '@tanstack/react-query';

export const useAcceptInvitation = () => {
	return useMutation({
		mutationFn: async (token: string) =>
			api<AcceptInvitationResponse>('/api/invitations/accept', {
				method: 'POST',
				body: { token }
			})
	});
};
