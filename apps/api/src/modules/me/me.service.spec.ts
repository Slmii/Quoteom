import { MembershipRole } from '@/generated/prisma/client';
import { CANNOT_REMOVE_OWNER, CANNOT_REMOVE_SELF, MEMBERSHIP_NOT_FOUND } from '@/lib/errors';
import type { BillingService } from '@/modules/billing/billing.service';
import type { LogService } from '@/modules/logger/log.service';
import { MeService } from '@/modules/me/me.service';
import type { PrismaService } from '@/modules/prisma/prisma.service';
import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

interface FakeTx {
	membership: { delete: jest.Mock; findFirst: jest.Mock };
	emailAccount: { deleteMany: jest.Mock };
	user: { update: jest.Mock };
}

interface FakePrisma {
	membership: { findFirst: jest.Mock };
	$transaction: jest.Mock;
	tx: FakeTx;
}

interface TargetRow {
	id: string;
	role: MembershipRole;
	user: { id: string; email: string; currentOrganizationId: string | null };
}

function makePrisma(target: TargetRow | null, fallback: { organizationId: string } | null = null): FakePrisma {
	const tx: FakeTx = {
		membership: {
			delete: jest.fn().mockReturnValue(Promise.resolve({})),
			findFirst: jest.fn().mockReturnValue(Promise.resolve(fallback))
		},
		emailAccount: { deleteMany: jest.fn().mockReturnValue(Promise.resolve({ count: 0 })) },
		user: { update: jest.fn().mockReturnValue(Promise.resolve({})) }
	};

	return {
		membership: { findFirst: jest.fn().mockReturnValue(Promise.resolve(target)) },
		$transaction: jest.fn().mockImplementation(async (cb: unknown) => {
			return (cb as (t: FakeTx) => Promise<unknown>)(tx);
		}),
		tx
	};
}

const billingStub = { syncSeatCount: jest.fn().mockReturnValue(Promise.resolve()) } as unknown as BillingService;
const logStub = { logAction: jest.fn() } as unknown as LogService;

function buildService(prisma: FakePrisma): MeService {
	return new MeService(prisma as unknown as PrismaService, billingStub, logStub);
}

describe('MeService.removeMember', () => {
	const ORG = 'org-1';
	const OWNER_ID = 'owner-1';
	const TARGET_ID = 'member-1';

	const memberTarget: TargetRow = {
		id: 'm-1',
		role: MembershipRole.MEMBER,
		user: { id: TARGET_ID, email: 'member@quoteom.dev', currentOrganizationId: ORG }
	};

	it('rejects removing yourself', async () => {
		const prisma = makePrisma(memberTarget);
		const service = buildService(prisma);

		await expect(service.removeMember(OWNER_ID, ORG, OWNER_ID)).rejects.toBeInstanceOf(BadRequestException);
		await expect(service.removeMember(OWNER_ID, ORG, OWNER_ID)).rejects.toThrow(CANNOT_REMOVE_SELF);
		// Short-circuits before any DB lookup.
		expect(prisma.membership.findFirst).not.toHaveBeenCalled();
	});

	it('rejects removing a user who is not in the org (404)', async () => {
		const prisma = makePrisma(null);
		const service = buildService(prisma);

		await expect(service.removeMember(OWNER_ID, ORG, TARGET_ID)).rejects.toBeInstanceOf(NotFoundException);
		await expect(service.removeMember(OWNER_ID, ORG, TARGET_ID)).rejects.toThrow(MEMBERSHIP_NOT_FOUND);
	});

	it('rejects removing an OWNER role (409)', async () => {
		const ownerTarget: TargetRow = {
			...memberTarget,
			role: MembershipRole.OWNER
		};
		const prisma = makePrisma(ownerTarget);
		const service = buildService(prisma);

		await expect(service.removeMember(OWNER_ID, ORG, TARGET_ID)).rejects.toBeInstanceOf(ConflictException);
		await expect(service.removeMember(OWNER_ID, ORG, TARGET_ID)).rejects.toThrow(CANNOT_REMOVE_OWNER);
		// No tx ran — the role check is pre-tx.
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it('happy path: deletes membership + email accounts, repoints currentOrgId, syncs seats, logs action', async () => {
		const prisma = makePrisma(memberTarget);
		const service = buildService(prisma);

		await service.removeMember(OWNER_ID, ORG, TARGET_ID);

		expect(prisma.tx.membership.delete).toHaveBeenCalledWith({ where: { id: 'm-1' } });
		expect(prisma.tx.emailAccount.deleteMany).toHaveBeenCalledWith({
			where: { userId: TARGET_ID, organizationId: ORG }
		});
		// `currentOrganizationId` pointed at this org → re-point to null (no fallback).
		expect(prisma.tx.user.update).toHaveBeenCalledWith({
			where: { id: TARGET_ID },
			data: { currentOrganizationId: null }
		});
		expect(billingStub.syncSeatCount).toHaveBeenCalledWith(ORG);
		expect(logStub.logAction).toHaveBeenCalledWith(
			expect.objectContaining({
				action: 'membership.removed',
				metadata: expect.objectContaining({
					organizationId: ORG,
					removedUserId: TARGET_ID,
					removedEmail: 'member@quoteom.dev',
					removedRole: MembershipRole.MEMBER,
					removedBy: OWNER_ID
				})
			})
		);
	});

	it('re-points removed user to their oldest remaining org when they had others', async () => {
		const prisma = makePrisma(memberTarget, { organizationId: 'org-2' });
		const service = buildService(prisma);

		await service.removeMember(OWNER_ID, ORG, TARGET_ID);

		expect(prisma.tx.user.update).toHaveBeenCalledWith({
			where: { id: TARGET_ID },
			data: { currentOrganizationId: 'org-2' }
		});
	});

	it('does NOT touch currentOrganizationId when removed user was active in a different org', async () => {
		const targetActiveElsewhere: TargetRow = {
			...memberTarget,
			user: { ...memberTarget.user, currentOrganizationId: 'some-other-org' }
		};
		const prisma = makePrisma(targetActiveElsewhere);
		const service = buildService(prisma);

		await service.removeMember(OWNER_ID, ORG, TARGET_ID);

		expect(prisma.tx.user.update).not.toHaveBeenCalled();
	});
});
