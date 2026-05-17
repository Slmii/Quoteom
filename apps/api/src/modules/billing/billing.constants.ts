/**
 * Stripe Subscription.status values that entitle the org to write access.
 * - `trialing`: free trial period with a saved payment method.
 * - `active`: paid and current.
 * - `past_due`: last invoice failed; Stripe is retrying. Don't lock the customer out
 *    mid-retry — billing dunning will handle it. If retries are exhausted, Stripe flips
 *    to `unpaid` or `canceled` and the gate engages.
 */
export const ENTITLED_STRIPE_STATUSES: ReadonlyArray<string> = ['trialing', 'active', 'past_due'];

/**
 * Stripe Subscription statuses that should block a new Checkout session. We allow at most
 * one live subscription per org — if the org is in any of these states, send them to the
 * Customer Portal to manage the existing sub instead of letting them create a second one.
 *
 * `incomplete` is included because Stripe still considers the row live until it expires;
 * starting a new Checkout would leave two subscriptions on the customer.
 */
export const LIVE_SUBSCRIPTION_STATUSES: ReadonlyArray<string> = [
	'trialing',
	'active',
	'past_due',
	'paused',
	'incomplete'
];

/**
 * HTTP methods that count as "reads" and bypass the entitlement gate. Even an unsubscribed
 * or canceled org can still list their data and view their dashboard — they just can't
 * make changes until they have a live subscription.
 */
export const READ_METHODS: ReadonlyArray<string> = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Stable error code surfaced in the 402 response body. Web clients pattern-match on this
 * to redirect to /billing instead of showing a generic error.
 */
export const BILLING_REQUIRED_CODE = 'billing_required';

/**
 * Seats included in the €149 base price. Any additional active membership beyond this
 * gets billed at `PER_SEAT_OVERAGE_CENTS` per month via Stripe's graduated tier 2.
 *
 * MUST match the Stripe Price's `tiers` configuration. If you change either of these
 * constants, update the Stripe Price (Dashboard → Products → Quoteom monthly).
 */
export const SEATS_INCLUDED = 3;
export const PER_SEAT_OVERAGE_CENTS = 3000;

/**
 * States in which we cap orgs at `SEATS_INCLUDED` seats. Prevents a trial user from
 * inviting an unbounded team and then being surprised by a large first invoice when
 * the trial ends. Once they actually subscribe (`active | past_due | paused`), they can
 * grow past the included tier and pay overage.
 *
 * Note: only Stripe's `trialing` state qualifies — a brand-new org with no Subscription
 * row at all is in state `'none'` and `EntitlementGuard` blocks the invitation write before
 * this cap is ever evaluated.
 */
export const TRIAL_STATES: ReadonlyArray<string> = ['trialing'];

/**
 * Error code surfaced when an invitation is rejected because the org is at its trial
 * seat cap. Web client switches on this to show "upgrade to invite more" inline rather
 * than auto-redirecting like the `billing_required` 402 does.
 */
export const TRIAL_SEAT_LIMIT_CODE = 'trial_seat_limit';

/**
 * Stripe Subscription statuses where it's safe to call `subscriptions.update` to change
 * the seat quantity. `canceled | incomplete_expired | unpaid` either don't have an
 * updateable sub or are in a state where Stripe will reject quantity changes.
 *
 * `past_due` is included by user policy: invites stay open during dunning so the org
 * doesn't lose the ability to add a teammate while their card is being retried.
 *
 * `paused` is deliberately EXCLUDED: Stripe rejects `subscriptions.update` on paused
 * subs with `subscription_status_invalid`. The seat-sync try/catch in BillingService
 * would swallow that error but spend a round-trip + emit a noisy ERROR action log on
 * every invitation accept while paused. Skipping cleanly here avoids the noise; the
 * next non-paused state transition (resume → active) will sync seats then.
 */
export const SEAT_SYNC_STATUSES: ReadonlyArray<string> = ['trialing', 'active', 'past_due', 'incomplete'];
