import type { BillingSeats, BillingState, BillingStatus } from '@quoteom/shared';

export class BillingSeatsDto implements BillingSeats {
	/** Active memberships on the org right now. */
	used!: number;
	/** Seats included in the base price (graduated tier 1). */
	included!: number;
	/** Per-seat price for seats beyond `included`, in cents (EUR). */
	overagePerSeatCents!: number;
}

export class BillingStatusResponseDto implements BillingStatus {
	state!: BillingState;

	/**
	 * ISO timestamp of when the current period ends.
	 *  - `none`: `null` (no period — the user hasn't started a trial yet).
	 *  - `trialing`: end of trial (also the date Stripe makes the first charge).
	 *  - `active`: next renewal date.
	 *  - terminal states (canceled with no remaining period): `null`.
	 */
	currentPeriodEnd!: string | null;

	cancelAtPeriodEnd!: boolean;

	paymentMethodBrand!: string | null;
	paymentMethodLast4!: string | null;

	seats!: BillingSeatsDto;
}
