import { serverFetch } from '@/lib/api/server-fetch';
import { createServerFn } from '@tanstack/react-start';

export interface Session {
	user?: {
		id: string;
		email?: string | null;
		name?: string | null;
		image?: string | null;
	};
	expires: string;
}

export const getSessionServer = createServerFn({ method: 'GET' }).handler(async () => {
	const response = await serverFetch('/api/auth/session');
	if (!response.ok) {
		return null;
	}

	const session = (await response.json()) as Session | null;
	return session?.user ? session : null;
});
