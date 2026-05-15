import {
	getGmailMessagesServer,
	getGmailStatusServer,
	getMicrosoftMessagesServer,
	getMicrosoftStatusServer
} from '@/lib/api/email.api';
import { api } from '@/lib/api/client';
import type { OkResponse } from '@quoteom/shared';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

export const EmailKeys = {
	gmailStatus: ['email', 'gmail', 'status'] as const,
	gmailMessages: ['email', 'gmail', 'messages'] as const,
	microsoftStatus: ['email', 'microsoft', 'status'] as const,
	microsoftMessages: ['email', 'microsoft', 'messages'] as const
};

export const gmailStatusQueryOptions = queryOptions({
	queryKey: EmailKeys.gmailStatus,
	queryFn: getGmailStatusServer,
	staleTime: 30_000
});

export const gmailMessagesQueryOptions = queryOptions({
	queryKey: EmailKeys.gmailMessages,
	queryFn: getGmailMessagesServer,
	staleTime: 60_000
});

export const microsoftStatusQueryOptions = queryOptions({
	queryKey: EmailKeys.microsoftStatus,
	queryFn: getMicrosoftStatusServer,
	staleTime: 30_000
});

export const microsoftMessagesQueryOptions = queryOptions({
	queryKey: EmailKeys.microsoftMessages,
	queryFn: getMicrosoftMessagesServer,
	staleTime: 60_000
});

export function useDisconnectGmail() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api<OkResponse>('/api/email/gmail/disconnect', { method: 'POST' }),
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: EmailKeys.gmailStatus });
			void queryClient.invalidateQueries({ queryKey: EmailKeys.gmailMessages });
		}
	});
}

export function useDisconnectMicrosoft() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api<OkResponse>('/api/email/microsoft/disconnect', { method: 'POST' }),
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: EmailKeys.microsoftStatus });
			void queryClient.invalidateQueries({ queryKey: EmailKeys.microsoftMessages });
		}
	});
}
