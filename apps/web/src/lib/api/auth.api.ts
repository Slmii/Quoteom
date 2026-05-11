import { createServerFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/react-start/server';

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

const API_URL = `${import.meta.env.VITE_API_URL}`;

export const getSessionServer = createServerFn({ method: 'GET' }).handler(async () => {
	const cookie = getRequestHeader('cookie');
	const response = await fetch(`${API_URL}/api/auth/session`, {
		headers: cookie ? { cookie } : {}
	});

	if (!response.ok) return null;

	const session = (await response.json()) as Session | null;
	return session?.user ? session : null;
});
