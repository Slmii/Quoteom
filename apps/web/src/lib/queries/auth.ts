import { api, postForm } from '@/lib/api/client';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';

export interface Session {
	user?: {
		id: string;
		email?: string | null;
		name?: string | null;
		image?: string | null;
		organizationId: string | null;
	};
	expires: string;
}

const AuthKeys = {
	session: ['auth', 'session'] as const,
	csrf: ['auth', 'csrf'] as const
};

async function fetchSession(): Promise<Session | null> {
	const session = await api<Session>('/api/auth/session');
	// Auth.js returns `{}` when there's no session; normalize to null.
	return session?.user ? session : null;
}

export const sessionQueryOptions = queryOptions({
	queryKey: AuthKeys.session,
	queryFn: fetchSession
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
			// Re-runs the route tree's beforeLoad → new context flows to all routes.
			await router.invalidate();
		}
	});
}
