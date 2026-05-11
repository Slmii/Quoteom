import type { EnvSchema } from '@/config/env.schema';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

/**
 * Stripe events we react to. Anything outside this list is ignored.
 * Every tracked event triggers a full re-sync from Stripe → DB, NOT a partial update
 * from the event payload — this avoids the split-brain problem of trusting event order
 * or partial data. See: Theo's "How I Stay Sane Implementing Stripe".
 */
const TRACKED_EVENTS: ReadonlyArray<string> = [
	'checkout.session.completed',
	'customer.subscription.created',
	'customer.subscription.updated',
	'customer.subscription.deleted',
	'customer.subscription.paused',
	'customer.subscription.resumed',
	'customer.subscription.pending_update_applied',
	'customer.subscription.pending_update_expired',
	'customer.subscription.trial_will_end',
	'invoice.paid',
	'invoice.payment_failed',
	'invoice.payment_action_required',
	'invoice.upcoming',
	'invoice.marked_uncollectible',
	'invoice.payment_succeeded',
	'payment_intent.succeeded',
	'payment_intent.payment_failed',
	'payment_intent.canceled'
];

@Injectable()
export class BillingService {
	private readonly logger = new Logger(BillingService.name);
	private readonly stripe: InstanceType<typeof Stripe>;

	constructor(
		private readonly prisma: PrismaService,
		private readonly config: ConfigService<EnvSchema, true>
	) {
		const secretKey = this.config.get('STRIPE_SECRET_KEY', { infer: true });
		if (!secretKey) {
			throw new Error('STRIPE_SECRET_KEY is not set');
		}

		// Pin the API version. Bumping is a deliberate decision documented in the upgrade
		// guide at https://docs.stripe.com/upgrades — never let the SDK silently roll
		// forward into a breaking change.
		this.stripe = new Stripe(secretKey, {
			apiVersion: '2026-04-22.dahlia'
		});
	}

	/** Get the Stripe instance for signature verification in the controller. */
	get stripeClient(): InstanceType<typeof Stripe> {
		return this.stripe;
	}

	/**
	 * Ensure there's a Stripe customer for this org (and a Subscription row pointing at it).
	 * Idempotent — returns the existing customerId if it's still alive in Stripe, otherwise
	 * heals the row by creating a fresh customer (handles the common dev scenario where
	 * Stripe test data is cleared or you switch test accounts).
	 */
	async getOrCreateCustomer(organizationId: string): Promise<string> {
		const existing = await this.prisma.subscription.findUnique({
			where: { organizationId }
		});

		if (existing) {
			// Verify the customer still exists in the current Stripe account. If it was
			// deleted out from under us (account swap, test data wiped), fall through to
			// re-create instead of failing every checkout attempt forever.
			try {
				const customer = await this.stripe.customers.retrieve(existing.stripeCustomerId);
				if (!customer.deleted) {
					return existing.stripeCustomerId;
				}

				this.logger.warn(`Stripe customer ${existing.stripeCustomerId} was deleted upstream — recreating`);
			} catch (error) {
				if (isResourceMissingError(error)) {
					this.logger.warn(`Stripe customer ${existing.stripeCustomerId} no longer exists — recreating`);
				} else {
					throw error;
				}
			}
		}

		const org = await this.prisma.organization.findUniqueOrThrow({
			where: { id: organizationId }
		});

		const customer = await this.stripe.customers.create({
			name: org.name,
			metadata: { organizationId }
		});

		// Upsert because the Subscription row may already exist with a stale customerId.
		// Reset all the synced fields too — they belong to the dead customer.
		await this.prisma.subscription.upsert({
			where: { organizationId },
			create: {
				organizationId,
				stripeCustomerId: customer.id
			},
			update: {
				stripeCustomerId: customer.id,
				stripeSubscriptionId: null,
				status: null,
				priceId: null,
				currentPeriodStart: null,
				currentPeriodEnd: null,
				cancelAtPeriodEnd: false,
				paymentMethodBrand: null,
				paymentMethodLast4: null
			}
		});

		this.logger.log(`Created Stripe customer ${customer.id} for org ${organizationId}`);
		return customer.id;
	}

	/**
	 * Create a Stripe Checkout session for the org's subscription. Returns the hosted
	 * checkout URL to redirect the user to. Always uses a pre-created customer to avoid
	 * Stripe's "ephemeral customer" footgun.
	 */
	async createCheckoutSession(organizationId: string): Promise<{ url: string }> {
		const priceId = this.config.get('STRIPE_PRICE_ID', { infer: true });
		if (!priceId) {
			throw new InternalServerErrorException('STRIPE_PRICE_ID is not configured');
		}

		const customerId = await this.getOrCreateCustomer(organizationId);
		const webOrigin = this.config.get('WEB_ORIGIN', { infer: true });

		const session = await this.stripe.checkout.sessions.create({
			customer: customerId,
			mode: 'subscription',
			line_items: [{ price: priceId, quantity: 1 }],
			// Payment methods are configured in the Stripe Dashboard (Payment Method
			// Configurations) — DO NOT pass `payment_method_types` here. Letting Stripe
			// pick dynamically maximizes conversion + lets you enable iDEAL/SEPA/cards
			// per region from the Dashboard without a deploy. For Quoteom: enable
			// "card", "ideal", and "sepa_debit" in the Dashboard's payment methods
			// settings for your account. iDEAL signs a SEPA mandate during checkout;
			// recurring charges run via SEPA Direct Debit automatically.
			currency: 'eur',
			allow_promotion_codes: true,
			success_url: `${webOrigin}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
			cancel_url: `${webOrigin}/billing/cancel`,
			subscription_data: {
				metadata: { organizationId },
				// W2.5: every new subscription starts with 14 days free. Stripe charges
				// the saved payment method at the end of the trial automatically. The
				// `Subscription.status` flips from "trialing" → "active" at that moment;
				// our sync function picks that up via `customer.subscription.updated`.
				trial_period_days: 14
			}
		});

		if (!session.url) {
			throw new InternalServerErrorException('Stripe did not return a checkout URL');
		}

		return { url: session.url };
	}

	/**
	 * Create a Stripe Customer Portal session. The Portal is Stripe's hosted UI for
	 * subscription management — users can update their payment method, see invoices,
	 * cancel/resume their subscription, and update billing details there.
	 *
	 * Configuration (what features are visible) is set in the Stripe Dashboard at
	 * https://dashboard.stripe.com/test/settings/billing/portal — not via code. Enable
	 * "Customer can update payment methods", "Customer can cancel subscriptions", etc.
	 */
	async createPortalSession(organizationId: string): Promise<{ url: string }> {
		const sub = await this.prisma.subscription.findUnique({
			where: { organizationId }
		});
		if (!sub) {
			throw new InternalServerErrorException(`No Stripe customer exists for organization ${organizationId}`);
		}

		const webOrigin = this.config.get('WEB_ORIGIN', { infer: true });
		const session = await this.stripe.billingPortal.sessions.create({
			customer: sub.stripeCustomerId,
			return_url: `${webOrigin}/billing`
		});

		return { url: session.url };
	}

	/**
	 * Fetch the current state of the customer's subscription from Stripe and persist it
	 * to our local DB. Single source-of-truth function — called from the success
	 * endpoint AND every webhook. Never trust webhook payloads directly.
	 */
	async syncFromStripe(customerId: string): Promise<{ status: string | null }> {
		const subscriptions = await this.stripe.subscriptions.list({
			customer: customerId,
			limit: 1,
			status: 'all',
			expand: ['data.default_payment_method', 'data.items']
		});

		if (subscriptions.data.length === 0) {
			await this.prisma.subscription.update({
				where: { stripeCustomerId: customerId },
				data: {
					stripeSubscriptionId: null,
					status: null,
					priceId: null,
					currentPeriodStart: null,
					currentPeriodEnd: null,
					cancelAtPeriodEnd: false,
					paymentMethodBrand: null,
					paymentMethodLast4: null
				}
			});
			this.logger.log(`Customer ${customerId} has no subscription — cleared local state`);
			return { status: null };
		}

		const sub = subscriptions.data[0]!;
		// Stripe moved `current_period_*` from Subscription → SubscriptionItem in 2024.
		const item = sub.items.data[0];
		const pm = sub.default_payment_method;
		const paymentMethod = pm && typeof pm !== 'string' ? pm : null;

		await this.prisma.subscription.update({
			where: { stripeCustomerId: customerId },
			data: {
				stripeSubscriptionId: sub.id,
				status: sub.status,
				priceId: item?.price.id ?? null,
				currentPeriodStart: item?.current_period_start ? new Date(item.current_period_start * 1000) : null,
				currentPeriodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
				cancelAtPeriodEnd: sub.cancel_at_period_end,
				paymentMethodBrand: paymentMethod?.type ?? null,
				paymentMethodLast4: extractLast4(paymentMethod)
			}
		});

		this.logger.log(`Synced subscription ${sub.id} (${sub.status}) for customer ${customerId}`);
		return { status: sub.status };
	}

	/**
	 * Webhook event router. Skips non-tracked events; for tracked ones, extracts the
	 * customer id from the event payload and triggers a full re-sync. Errors are caught
	 * by the caller and logged — the webhook endpoint always 200s to prevent Stripe
	 * retry storms while a sync transiently fails.
	 */
	async handleWebhookEvent(
		event: ReturnType<InstanceType<typeof Stripe>['webhooks']['constructEvent']>
	): Promise<void> {
		if (!TRACKED_EVENTS.includes(event.type)) {
			return;
		}

		const object = event.data.object as { customer?: string | null };
		const customerId = object.customer;

		if (typeof customerId !== 'string') {
			this.logger.warn(`Event ${event.type} has no customer id — skipping`);
			return;
		}

		await this.syncFromStripe(customerId);
	}
}

interface PaymentMethodLike {
	type: string;
	card?: { last4?: string | null } | null;
	sepa_debit?: { last4?: string | null } | null;
}

/**
 * Stripe's "No such customer / object" errors come back as `code: 'resource_missing'`.
 * Detect via duck-typing to avoid relying on the SDK's instanceof types (which are
 * awkward to access via Stripe's CJS `export =`).
 */
function isResourceMissingError(error: unknown): boolean {
	return error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'resource_missing';
}

function extractLast4(pm: PaymentMethodLike | null): string | null {
	if (!pm) {
		return null;
	}

	if (pm.type === 'card') {
		return pm.card?.last4 ?? null;
	}

	if (pm.type === 'sepa_debit') {
		return pm.sepa_debit?.last4 ?? null;
	}

	return null;
}
