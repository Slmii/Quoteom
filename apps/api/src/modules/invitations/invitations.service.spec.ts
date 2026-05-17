import { trialSeatLimitReached } from '@/lib/errors';
import { SEATS_INCLUDED, TRIAL_SEAT_LIMIT_CODE } from '@/modules/billing/billing.constants';
import { BillingService } from '@/modules/billing/billing.service';
import { InvitationsService } from '@/modules/invitations/invitations.service';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HttpException, HttpStatus } from '@nestjs/common';

interface FakePrisma {
	membership: { count: jest.Mock };
	invitation: { count: jest.Mock };
}

function makePrisma(memberCount: number, pendingInviteCount: number): FakePrisma {
	return {
		membership: { count: jest.fn().mockReturnValue(Promise.resolve(memberCount)) },
		invitation: { count: jest.fn().mockReturnValue(Promise.resolve(pendingInviteCount)) }
	};
}

function makeBilling(state: string): BillingService {
	return {
		getStatus: jest.fn().mockReturnValue(Promise.resolve({ state }))
	} as unknown as BillingService;
}

/** Reach into the private `assertSeatBudget` method for focused testing. */
async function callAssertSeatBudget(service: InvitationsService, organizationId: string): Promise<void> {
	await (service as unknown as { assertSeatBudget(id: string): Promise<void> }).assertSeatBudget(organizationId);
}

describe('InvitationsService.assertSeatBudget', () => {
	let prisma: FakePrisma;
	const config = {} as unknown as ConstructorParameters<typeof InvitationsService>[1];
	// LogService stub — assertSeatBudget logs a warn-level action on cap-hit, which the
	// happy-path tests don't assert on; a no-op stub keeps the test surface unchanged.
	const logServiceStub = { logAction: () => undefined } as unknown as ConstructorParameters<
		typeof InvitationsService
	>[3];

	beforeEach(() => {
		prisma = makePrisma(0, 0);
	});

	describe('non-trial states bypass the cap', () => {
		it.each(['active', 'past_due', 'paused', 'canceled', 'unpaid', 'incomplete'])(
			'%s skips the seat check entirely (no Prisma calls)',
			async state => {
				const billing = makeBilling(state);
				const service = new InvitationsService(
					prisma as unknown as PrismaService,
					config,
					billing,
					logServiceStub
				);

				await expect(callAssertSeatBudget(service, 'org-1')).resolves.toBeUndefined();
				expect(prisma.membership.count).not.toHaveBeenCalled();
				expect(prisma.invitation.count).not.toHaveBeenCalled();
			}
		);

		it('state="none" (pre-Checkout) bypasses this cap — EntitlementGuard blocks earlier', async () => {
			const billing = makeBilling('none');
			const service = new InvitationsService(prisma as unknown as PrismaService, config, billing, logServiceStub);

			await expect(callAssertSeatBudget(service, 'org-1')).resolves.toBeUndefined();
			expect(prisma.membership.count).not.toHaveBeenCalled();
		});
	});

	describe('trial state enforces the cap', () => {
		it('allows the invitation when active + pending < SEATS_INCLUDED', async () => {
			const billing = makeBilling('trialing');
			const p = makePrisma(1, 1); // 1 + 1 = 2 < 3
			const service = new InvitationsService(p as unknown as PrismaService, config, billing, logServiceStub);

			await expect(callAssertSeatBudget(service, 'org-1')).resolves.toBeUndefined();
		});

		it('rejects with 402 trial_seat_limit when active + pending == SEATS_INCLUDED', async () => {
			const billing = makeBilling('trialing');
			const p = makePrisma(1, 2); // 1 + 2 = 3 == cap
			const service = new InvitationsService(p as unknown as PrismaService, config, billing, logServiceStub);

			expect.assertions(5);
			try {
				await callAssertSeatBudget(service, 'org-1');
			} catch (error) {
				expect(error).toBeInstanceOf(HttpException);
				const response = (error as HttpException).getResponse() as Record<string, unknown>;
				expect(response.statusCode).toBe(HttpStatus.PAYMENT_REQUIRED);
				expect(response.code).toBe(TRIAL_SEAT_LIMIT_CODE);
				expect(response.message).toBe(trialSeatLimitReached(SEATS_INCLUDED));
				expect(response.billingPath).toBe('/billing');
			}
		});

		it('rejects when active alone is already at the cap, even with 0 pending', async () => {
			const billing = makeBilling('trialing');
			const p = makePrisma(SEATS_INCLUDED, 0);
			const service = new InvitationsService(p as unknown as PrismaService, config, billing, logServiceStub);

			await expect(callAssertSeatBudget(service, 'org-1')).rejects.toBeInstanceOf(HttpException);
		});

		it('only counts pending invitations that are NOT yet accepted and NOT yet expired', async () => {
			// The Prisma query shape is the contract — verify it matches the docstring.
			const billing = makeBilling('trialing');
			const p = makePrisma(1, 0);
			const service = new InvitationsService(p as unknown as PrismaService, config, billing, logServiceStub);

			await callAssertSeatBudget(service, 'org-1');

			const invocation = p.invitation.count.mock.calls[0]?.[0] as {
				where: {
					organizationId: string;
					acceptedAt: null;
					expiresAt: { gt: Date };
				};
			};
			expect(invocation.where.organizationId).toBe('org-1');
			expect(invocation.where.acceptedAt).toBeNull();
			expect(invocation.where.expiresAt.gt).toBeInstanceOf(Date);
			// Cutoff is "now-ish" — within 5 seconds is plenty of slack for test execution.
			expect(Math.abs(invocation.where.expiresAt.gt.getTime() - Date.now())).toBeLessThan(5_000);
		});

		it('emits invitation.rejected.trial_seat_cap at warn level when the cap fires', async () => {
			const billing = makeBilling('trialing');
			const p = makePrisma(SEATS_INCLUDED, 0);
			const logAction = jest.fn();
			const recordingLog = { logAction } as unknown as ConstructorParameters<typeof InvitationsService>[3];
			const service = new InvitationsService(p as unknown as PrismaService, config, billing, recordingLog);

			await expect(callAssertSeatBudget(service, 'org-1')).rejects.toBeInstanceOf(HttpException);
			expect(logAction).toHaveBeenCalledTimes(1);
			expect(logAction).toHaveBeenCalledWith(
				expect.objectContaining({
					action: 'invitation.rejected.trial_seat_cap',
					level: 'warn',
					metadata: expect.objectContaining({
						organizationId: 'org-1',
						cap: SEATS_INCLUDED,
						memberCount: SEATS_INCLUDED,
						pendingInvites: 0
					})
				})
			);
		});
	});
});
