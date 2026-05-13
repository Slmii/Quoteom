import { PER_SEAT_OVERAGE_CENTS, SEATS_INCLUDED } from '@/modules/billing/billing.constants';
import { BillingService } from '@/modules/billing/billing.service';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { describe, expect, it, jest } from '@jest/globals';

interface FakePrisma {
	subscription: {
		findUnique: jest.Mock;
		update: jest.Mock;
		upsert: jest.Mock;
	};
	membership: { count: jest.Mock };
	organization: { findUniqueOrThrow: jest.Mock };
}

function makePrisma(overrides?: {
	subscription?: Partial<FakePrisma['subscription']>;
	membership?: Partial<FakePrisma['membership']>;
	organization?: Partial<FakePrisma['organization']>;
}): FakePrisma {
	return {
		subscription: {
			findUnique: jest.fn().mockReturnValue(Promise.resolve(null)),
			update: jest.fn().mockReturnValue(Promise.resolve({})),
			upsert: jest.fn().mockReturnValue(Promise.resolve({})),
			...overrides?.subscription
		},
		membership: {
			count: jest.fn().mockReturnValue(Promise.resolve(0)),
			...overrides?.membership
		},
		organization: {
			findUniqueOrThrow: jest.fn().mockReturnValue(Promise.resolve({ id: 'org-1', name: 'Acme BV' })),
			...overrides?.organization
		}
	};
}

function makeConfig(): { get(key: string): string | undefined } {
	return {
		get(key: string): string | undefined {
			if (key === 'STRIPE_SECRET_KEY') {
				return 'sk_test_dummy';
			}

			if (key === 'STRIPE_PRICE_ID') {
				return 'price_dummy';
			}

			if (key === 'WEB_ORIGIN') {
				return 'http://localhost:3000';
			}
			return undefined;
		}
	};
}

/**
 * Build a service and stub out its private `stripe` instance with a hand-rolled fake.
 * BillingService constructs `new Stripe(...)` in its ctor, so we let that succeed
 * (with a dummy key) and then overwrite the `stripe` field on the instance for the
 * methods we exercise.
 */
function buildService(prisma: FakePrisma, stripeFake: Record<string, unknown>): BillingService {
	// LogService is used for logAction calls only — tests don't assert on them, so a stub
	// with a no-op method is sufficient. Action logging is exercised by its own spec.
	const logService = { logAction: () => undefined } as unknown as ConstructorParameters<typeof BillingService>[2];
	const service = new BillingService(
		prisma as unknown as PrismaService,
		makeConfig() as unknown as ConstructorParameters<typeof BillingService>[1],
		logService
	);
	(service as unknown as { stripe: unknown }).stripe = stripeFake;
	return service;
}

describe('BillingService.getStatus', () => {
	it('returns state="none" with null period and zero seats when no Subscription row exists', async () => {
		const prisma = makePrisma({
			subscription: { findUnique: jest.fn().mockReturnValue(Promise.resolve(null)) },
			membership: { count: jest.fn().mockReturnValue(Promise.resolve(0)) }
		});
		const service = buildService(prisma, {});

		const status = await service.getStatus('org-1');

		expect(status.state).toBe('none');
		expect(status.currentPeriodEnd).toBeNull();
		expect(status.cancelAtPeriodEnd).toBe(false);
		expect(status.paymentMethodBrand).toBeNull();
		expect(status.paymentMethodLast4).toBeNull();
		expect(status.seats).toEqual({
			used: 0,
			included: SEATS_INCLUDED,
			overagePerSeatCents: PER_SEAT_OVERAGE_CENTS
		});
	});

	it.each(['trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused', 'incomplete', 'incomplete_expired'])(
		'maps Subscription.status="%s" straight through to BillingState',
		async status => {
			const periodEnd = new Date('2026-06-01T00:00:00Z');
			const prisma = makePrisma({
				subscription: {
					findUnique: jest.fn().mockReturnValue(
						Promise.resolve({
							status,
							currentPeriodEnd: periodEnd,
							cancelAtPeriodEnd: false,
							paymentMethodBrand: 'card',
							paymentMethodLast4: '4242'
						})
					)
				}
			});
			const service = buildService(prisma, {});

			const result = await service.getStatus('org-1');
			expect(result.state).toBe(status);
			expect(result.currentPeriodEnd).toBe(periodEnd.toISOString());
			expect(result.paymentMethodBrand).toBe('card');
			expect(result.paymentMethodLast4).toBe('4242');
		}
	);

	it('passes through cancelAtPeriodEnd=true', async () => {
		const prisma = makePrisma({
			subscription: {
				findUnique: jest.fn().mockReturnValue(
					Promise.resolve({
						status: 'active',
						currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
						cancelAtPeriodEnd: true,
						paymentMethodBrand: 'card',
						paymentMethodLast4: '4242'
					})
				)
			}
		});
		const service = buildService(prisma, {});
		const status = await service.getStatus('org-1');
		expect(status.cancelAtPeriodEnd).toBe(true);
	});

	it('counts active memberships into seats.used', async () => {
		const prisma = makePrisma({
			membership: { count: jest.fn().mockReturnValue(Promise.resolve(4)) }
		});
		const service = buildService(prisma, {});
		const status = await service.getStatus('org-1');
		expect(status.seats.used).toBe(4);
	});

	it('falls back to state="none" when sub row exists but status is null (post-cleanup)', async () => {
		// syncFromStripe clears the status to null when Stripe reports no subscriptions.
		// The customer row still exists; getStatus should treat this as "none" too.
		const prisma = makePrisma({
			subscription: {
				findUnique: jest.fn().mockReturnValue(
					Promise.resolve({
						status: null,
						currentPeriodEnd: null,
						cancelAtPeriodEnd: false,
						paymentMethodBrand: null,
						paymentMethodLast4: null
					})
				)
			}
		});
		const service = buildService(prisma, {});
		const status = await service.getStatus('org-1');
		expect(status.state).toBe('none');
	});
});

describe('BillingService.syncFromStripe', () => {
	it('clears all synced fields when Stripe reports no subscriptions', async () => {
		const prisma = makePrisma();
		const stripeFake = {
			subscriptions: {
				list: jest.fn().mockReturnValue(Promise.resolve({ data: [] }))
			}
		};
		const service = buildService(prisma, stripeFake);

		const result = await service.syncFromStripe('cus_123');

		expect(result.status).toBeNull();
		expect(prisma.subscription.update).toHaveBeenCalledWith({
			where: { stripeCustomerId: 'cus_123' },
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
	});

	it('persists a trialing subscription with period dates from the item (not the sub root)', async () => {
		const prisma = makePrisma();
		const periodStart = 1_730_000_000; // unix seconds
		const periodEnd = 1_730_999_999;
		const stripeFake = {
			subscriptions: {
				list: jest.fn().mockReturnValue(
					Promise.resolve({
						data: [
							{
								id: 'sub_1',
								status: 'trialing',
								cancel_at_period_end: false,
								default_payment_method: null,
								items: {
									data: [
										{
											price: { id: 'price_abc' },
											current_period_start: periodStart,
											current_period_end: periodEnd
										}
									]
								}
							}
						]
					})
				)
			}
		};
		const service = buildService(prisma, stripeFake);

		const result = await service.syncFromStripe('cus_123');

		expect(result.status).toBe('trialing');
		expect(prisma.subscription.update).toHaveBeenCalledWith({
			where: { stripeCustomerId: 'cus_123' },
			data: {
				stripeSubscriptionId: 'sub_1',
				status: 'trialing',
				priceId: 'price_abc',
				currentPeriodStart: new Date(periodStart * 1000),
				currentPeriodEnd: new Date(periodEnd * 1000),
				cancelAtPeriodEnd: false,
				paymentMethodBrand: null,
				paymentMethodLast4: null
			}
		});
	});

	it('extracts card last4 from the default_payment_method', async () => {
		const prisma = makePrisma();
		const stripeFake = {
			subscriptions: {
				list: jest.fn().mockReturnValue(
					Promise.resolve({
						data: [
							{
								id: 'sub_1',
								status: 'active',
								cancel_at_period_end: false,
								default_payment_method: {
									type: 'card',
									card: { last4: '4242' }
								},
								items: {
									data: [{ price: { id: 'p' }, current_period_start: 1, current_period_end: 2 }]
								}
							}
						]
					})
				)
			}
		};
		const service = buildService(prisma, stripeFake);

		await service.syncFromStripe('cus_123');

		const call = prisma.subscription.update.mock.calls[0]?.[0] as {
			data: { paymentMethodBrand: string; paymentMethodLast4: string };
		};
		expect(call.data.paymentMethodBrand).toBe('card');
		expect(call.data.paymentMethodLast4).toBe('4242');
	});

	it('extracts SEPA last4 from the default_payment_method', async () => {
		const prisma = makePrisma();
		const stripeFake = {
			subscriptions: {
				list: jest.fn().mockReturnValue(
					Promise.resolve({
						data: [
							{
								id: 'sub_1',
								status: 'active',
								cancel_at_period_end: false,
								default_payment_method: {
									type: 'sepa_debit',
									sepa_debit: { last4: '3000' }
								},
								items: {
									data: [{ price: { id: 'p' }, current_period_start: 1, current_period_end: 2 }]
								}
							}
						]
					})
				)
			}
		};
		const service = buildService(prisma, stripeFake);

		await service.syncFromStripe('cus_123');

		const call = prisma.subscription.update.mock.calls[0]?.[0] as {
			data: { paymentMethodBrand: string; paymentMethodLast4: string };
		};
		expect(call.data.paymentMethodBrand).toBe('sepa_debit');
		expect(call.data.paymentMethodLast4).toBe('3000');
	});

	it('passes cancel_at_period_end through to the DB column', async () => {
		const prisma = makePrisma();
		const stripeFake = {
			subscriptions: {
				list: jest.fn().mockReturnValue(
					Promise.resolve({
						data: [
							{
								id: 'sub_1',
								status: 'active',
								cancel_at_period_end: true,
								default_payment_method: null,
								items: {
									data: [{ price: { id: 'p' }, current_period_start: 1, current_period_end: 2 }]
								}
							}
						]
					})
				)
			}
		};
		const service = buildService(prisma, stripeFake);

		await service.syncFromStripe('cus_123');

		const call = prisma.subscription.update.mock.calls[0]?.[0] as { data: { cancelAtPeriodEnd: boolean } };
		expect(call.data.cancelAtPeriodEnd).toBe(true);
	});

	it('tolerates a subscription item missing the price (defensive null)', async () => {
		const prisma = makePrisma();
		const stripeFake = {
			subscriptions: {
				list: jest.fn().mockReturnValue(
					Promise.resolve({
						data: [
							{
								id: 'sub_1',
								status: 'active',
								cancel_at_period_end: false,
								default_payment_method: null,
								items: { data: [] } // no items at all — exotic but possible
							}
						]
					})
				)
			}
		};
		const service = buildService(prisma, stripeFake);

		await service.syncFromStripe('cus_123');

		const call = prisma.subscription.update.mock.calls[0]?.[0] as {
			data: { priceId: string | null; currentPeriodStart: Date | null };
		};
		expect(call.data.priceId).toBeNull();
		expect(call.data.currentPeriodStart).toBeNull();
	});
});
