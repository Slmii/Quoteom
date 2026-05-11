import { api } from '@/lib/api/client';
import { useMutation } from '@tanstack/react-query';

interface AcceptInvitationResponse {
	userId: string;
	email: string;
	organizationId: string;
	organizationName: string;
}

export const useAcceptInvitation = () => {
	return useMutation({
		mutationFn: async (token: string) => {
			return api<AcceptInvitationResponse>('/api/invitations/accept', {
				method: 'POST',
				body: { token }
			});
		}
	});
};
