import { getSessionServer } from '@/lib/api/auth.api';
import { api, postForm } from '@/lib/api/client';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';

const AuthKeys = {
	session: ['auth', 'session'] as const
};

/**
 * Single code path for session fetch — `createServerFn` dispatches automatically:
 *  - SSR → executes locally with `getRequestHeader` access (cookies forwarded to API).
 *  - Client → HTTP call to the TanStack Start server endpoint (browser cookies ride along).
 * No `typeof window` branching needed.
 */
export const sessionQueryOptions = queryOptions({
	queryKey: AuthKeys.session,
	queryFn: getSessionServer
});

async function getCsrfToken(): Promise<string> {
	const { csrfToken } = await api<{ csrfToken: string }>('/api/auth/csrf');
	return csrfToken;
}

export function useSignInWithEmail() {
	return useMutation({
		mutationFn: async (email: string) => {
			const csrfToken = await getCsrfToken();
			await postForm('/api/auth/signin/resend', { email, csrfToken });
		}
	});
}

export function useSignOut() {
	const queryClient = useQueryClient();
	const router = useRouter();

	return useMutation({
		mutationFn: async () => {
			const csrfToken = await getCsrfToken();
			await postForm('/api/auth/signout', { csrfToken });
		},
		onSuccess: async () => {
			queryClient.setQueryData(AuthKeys.session, null);
			await router.invalidate();
		}
	});
}
