import { serverFetch } from '@/lib/api/server-fetch';
import type { Session } from '@quoteom/shared';
import { createServerFn } from '@tanstack/react-start';

export const getSessionServer = createServerFn({ method: 'GET' }).handler(async () => {
	const response = await serverFetch('/api/auth/session');
	if (!response.ok) {
		return null;
	}

	const session = (await response.json()) as Session | null;
	return session?.user ? session : null;
});
