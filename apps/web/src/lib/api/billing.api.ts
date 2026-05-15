import { serverFetch } from '@/lib/api/server-fetch';
import type { BillingStatus } from '@quoteom/shared';
import { createServerFn } from '@tanstack/react-start';

/**
 * Isomorphic billing-status fetch. Same code path SSR and client:
 *  - SSR → runs locally inside the handler with cookies forwarded via `getRequestHeader`.
 *  - Client → HTTP roundtrip to the TanStack Start server endpoint (browser cookies ride along).
 *
 * Throws a typed `Error` on non-2xx so the loader / `useSuspenseQuery` propagates to the
 * nearest router error boundary.
 */
export const getBillingStatusServer = createServerFn({ method: 'GET' }).handler(async (): Promise<BillingStatus> => {
	const response = await serverFetch('/api/billing/status');
	if (!response.ok) {
		throw new Error(`Failed to load billing status (${response.status})`);
	}

	return (await response.json()) as BillingStatus;
});
