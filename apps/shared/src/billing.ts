/**
 * Discriminator the UI switches on. Values mirror Stripe's Subscription.status enum
 * plus one non-Stripe state for orgs that have never reached Checkout:
 *  - `none`: no Subscription row yet. Writes are gated; user must Checkout to start
 *    the 14-day Stripe-managed trial.
 */
export type BillingState =
	| 'none'
	| 'trialing'
	| 'active'
	| 'past_due'
	| 'unpaid'
	| 'canceled'
	| 'paused'
	| 'incomplete'
	| 'incomplete_expired';

export interface BillingSeats {
	/** Active memberships on the org right now. */
	used: number;
	/** Seats included in the base price (graduated tier 1). */
	included: number;
	/** Per-seat price for seats beyond `included`, in cents (EUR). */
	overagePerSeatCents: number;
}

/** `GET /api/billing/status` response. The UI renders state-specific copy off `state`. */
export interface BillingStatus {
	state: BillingState;
	/**
	 * ISO timestamp of when the current period ends.
	 *  - `none`: `null` (no period — the user hasn't started a trial yet).
	 *  - `trialing`: end of trial (also the date Stripe makes the first charge).
	 *  - `active`: next renewal date.
	 *  - terminal states (canceled with no remaining period): `null`.
	 */
	currentPeriodEnd: string | null;
	cancelAtPeriodEnd: boolean;
	paymentMethodBrand: string | null;
	paymentMethodLast4: string | null;
	seats: BillingSeats;
}

/** `POST /api/billing/checkout-session` response. UI redirects browser to `url`. */
export interface CheckoutSessionResponse {
	url: string;
}

/** `POST /api/billing/portal-session` response. Same shape as checkout — Stripe Customer Portal URL. */
export interface PortalSessionResponse {
	url: string;
}

/** `POST /api/billing/sync` response. Returned after post-Checkout `?sync=1` round-trip. */
export interface BillingSyncResponse {
	ok: boolean;
	status: string | null;
}
