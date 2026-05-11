import { api } from '@/lib/api/client';
import { useMutation } from '@tanstack/react-query';

interface CheckoutSessionResponse {
	url: string;
}

interface BillingSyncResponse {
	ok: boolean;
	status: string | null;
}

/** Hit POST /api/billing/checkout-session, then redirect the browser to Stripe Checkout. */
export function useStartCheckout() {
	return useMutation({
		mutationFn: async () => {
			const { url } = await api<CheckoutSessionResponse>('/api/billing/checkout-session', {
				method: 'POST'
			});
			window.location.href = url;
		}
	});
}

/** Hit POST /api/billing/portal-session, then redirect the browser to the Customer Portal. */
export function useOpenPortal() {
	return useMutation({
		mutationFn: async () => {
			const { url } = await api<CheckoutSessionResponse>('/api/billing/portal-session', {
				method: 'POST'
			});
			window.location.href = url;
		}
	});
}

/** Force a re-sync of subscription state from Stripe. Called from /billing/success. */
export function useSyncBilling() {
	return useMutation({
		mutationFn: () => {
			return api<BillingSyncResponse>('/api/billing/sync', {
				method: 'POST'
			});
		}
	});
}
