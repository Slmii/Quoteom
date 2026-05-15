import { getSessionServer } from '@/lib/api/auth.api';
import { api, postForm } from '@/lib/api/client';
import type { OAuthProviderId } from '@quoteom/shared';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';

export const AuthKeys = {
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

export async function signInWithOAuth(providerId: OAuthProviderId): Promise<void> {
	const csrfToken = await getCsrfToken();

	const form = document.createElement('form');
	form.method = 'POST';
	form.action = `/api/auth/signin/${providerId}`;
	form.style.display = 'none';

	const csrfInput = document.createElement('input');
	csrfInput.name = 'csrfToken';
	csrfInput.value = csrfToken;
	form.appendChild(csrfInput);

	// Return the user to the home page after the OAuth callback succeeds. Auth.js reads
	// `callbackUrl` to decide where to land. Defaults to /, but explicit is safer.
	const callbackInput = document.createElement('input');
	callbackInput.name = 'callbackUrl';
	callbackInput.value = '/';
	form.appendChild(callbackInput);

	document.body.appendChild(form);
	form.submit();
}

interface SignupInput {
	email: string;
	companyName: string;
}

interface SignupResponse {
	ok: boolean;
	email: string;
}

/**
 * Self-signup. Two-step:
 *  1. POST /api/signup → creates User + Organization + OWNER Membership in a transaction.
 *  2. POST /api/auth/signin/resend → Auth.js sees the now-existing User and emails the
 *     magic link via the standard signin flow (reuses the same code path as /sign-in).
 * Caller redirects to /verify-request on success.
 */
export function useSignUp() {
	return useMutation({
		mutationFn: async ({ email, companyName }: SignupInput) => {
			const { email: normalized } = await api<SignupResponse>('/api/signup', {
				method: 'POST',
				body: { email, companyName }
			});
			const csrfToken = await getCsrfToken();
			await postForm('/api/auth/signin/resend', { email: normalized, csrfToken });
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
