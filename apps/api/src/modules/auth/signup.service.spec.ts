import { MembershipRole } from '@/generated/prisma/client';
import { ACCOUNT_ALREADY_EXISTS } from '@/lib/errors';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { SignupService } from '@/modules/auth/signup.service';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConflictException } from '@nestjs/common';

interface FakePrisma {
	user: { findUnique: jest.Mock };
	$transaction: jest.Mock;
}

function makePrisma(opts: {
	existingUser?: { id: string } | null;
	createdOrgId?: string;
	createdUserId?: string;
}): { prisma: FakePrisma; tx: { organization: { create: jest.Mock }; user: { create: jest.Mock }; membership: { create: jest.Mock } } } {
	const tx = {
		organization: { create: jest.fn().mockReturnValue(Promise.resolve({ id: opts.createdOrgId ?? 'org-1' })) },
		user: {
			create: jest.fn().mockReturnValue(
				Promise.resolve({ id: opts.createdUserId ?? 'user-1' })
			)
		},
		membership: { create: jest.fn().mockReturnValue(Promise.resolve({ id: 'm-1' })) }
	};

	const prisma: FakePrisma = {
		user: { findUnique: jest.fn().mockReturnValue(Promise.resolve(opts.existingUser ?? null)) },
		$transaction: jest.fn().mockImplementation(async (cb: unknown) => {
			return (cb as (t: typeof tx) => Promise<unknown>)(tx);
		})
	};

	return { prisma, tx };
}

// LogService stub — signup logs `signup.org_created` / `signup.rejected.duplicate_email`,
// which these tests don't assert on; a no-op stub keeps the existing assertion surface.
const logServiceStub = { logAction: () => undefined } as unknown as ConstructorParameters<typeof SignupService>[1];

describe('SignupService', () => {
	let service: SignupService;
	let prisma: FakePrisma;
	let tx: ReturnType<typeof makePrisma>['tx'];

	beforeEach(() => {
		const built = makePrisma({});
		prisma = built.prisma;
		tx = built.tx;
		service = new SignupService(prisma as unknown as PrismaService, logServiceStub);
	});

	describe('happy path', () => {
		it('creates Organization + User + OWNER Membership in one transaction', async () => {
			const result = await service.signup('founder@quoteom.dev', 'Quoteom BV');

			expect(prisma.$transaction).toHaveBeenCalledTimes(1);
			expect(tx.organization.create).toHaveBeenCalledWith({ data: { name: 'Quoteom BV' } });
			expect(tx.user.create).toHaveBeenCalledWith({
				data: { email: 'founder@quoteom.dev', currentOrganizationId: 'org-1' }
			});
			expect(tx.membership.create).toHaveBeenCalledWith({
				data: { userId: 'user-1', organizationId: 'org-1', role: MembershipRole.OWNER }
			});
			expect(result).toEqual({
				userId: 'user-1',
				organizationId: 'org-1',
				email: 'founder@quoteom.dev'
			});
		});

		it('lowercases the email before persisting', async () => {
			const result = await service.signup('Founder@Quoteom.Dev', 'Quoteom BV');

			expect(prisma.user.findUnique).toHaveBeenCalledWith({
				where: { email: 'founder@quoteom.dev' },
				select: { id: true }
			});
			expect(tx.user.create).toHaveBeenCalledWith({
				data: { email: 'founder@quoteom.dev', currentOrganizationId: 'org-1' }
			});
			expect(result.email).toBe('founder@quoteom.dev');
		});

		it('trims whitespace from the email AND company name', async () => {
			await service.signup('  founder@quoteom.dev  ', '  Quoteom BV  ');

			expect(tx.organization.create).toHaveBeenCalledWith({ data: { name: 'Quoteom BV' } });
			expect(tx.user.create).toHaveBeenCalledWith({
				data: { email: 'founder@quoteom.dev', currentOrganizationId: 'org-1' }
			});
		});
	});

	describe('duplicate email', () => {
		it('throws ConflictException without entering the transaction', async () => {
			const built = makePrisma({ existingUser: { id: 'existing-1' } });
			const dupService = new SignupService(built.prisma as unknown as PrismaService, logServiceStub);

			await expect(dupService.signup('taken@quoteom.dev', 'New Co')).rejects.toBeInstanceOf(ConflictException);
			expect(built.prisma.$transaction).not.toHaveBeenCalled();
		});

		it('uses the original error message from `ACCOUNT_ALREADY_EXISTS`', async () => {
			const built = makePrisma({ existingUser: { id: 'existing-1' } });
			const dupService = new SignupService(built.prisma as unknown as PrismaService, logServiceStub);

			await expect(dupService.signup('taken@quoteom.dev', 'New Co')).rejects.toThrow(ACCOUNT_ALREADY_EXISTS);
		});

		it('case-insensitively detects an existing user (uppercased input still rejected)', async () => {
			const built = makePrisma({ existingUser: { id: 'existing-1' } });
			const dupService = new SignupService(built.prisma as unknown as PrismaService, logServiceStub);

			await expect(dupService.signup('TAKEN@quoteom.dev', 'New Co')).rejects.toBeInstanceOf(ConflictException);
			// findUnique was called with the lowercased form — proves we did not skip normalization.
			expect(built.prisma.user.findUnique).toHaveBeenCalledWith({
				where: { email: 'taken@quoteom.dev' },
				select: { id: true }
			});
		});
	});

	describe('action logging', () => {
		it('emits signup.org_created on success', async () => {
			const built = makePrisma({});
			const logAction = jest.fn();
			const recordingLog = { logAction } as unknown as ConstructorParameters<typeof SignupService>[1];
			const recordingService = new SignupService(built.prisma as unknown as PrismaService, recordingLog);

			await recordingService.signup('founder@quoteom.dev', 'Quoteom BV');

			expect(logAction).toHaveBeenCalledTimes(1);
			expect(logAction).toHaveBeenCalledWith(
				expect.objectContaining({
					action: 'signup.org_created',
					metadata: expect.objectContaining({
						email: 'founder@quoteom.dev',
						companyName: 'Quoteom BV',
						userId: 'user-1',
						organizationId: 'org-1'
					})
				})
			);
		});

		it('emits signup.rejected.duplicate_email at warn level on duplicate', async () => {
			const built = makePrisma({ existingUser: { id: 'existing-1' } });
			const logAction = jest.fn();
			const recordingLog = { logAction } as unknown as ConstructorParameters<typeof SignupService>[1];
			const recordingService = new SignupService(built.prisma as unknown as PrismaService, recordingLog);

			await expect(recordingService.signup('taken@quoteom.dev', 'New Co')).rejects.toBeInstanceOf(
				ConflictException
			);
			expect(logAction).toHaveBeenCalledTimes(1);
			expect(logAction).toHaveBeenCalledWith(
				expect.objectContaining({
					action: 'signup.rejected.duplicate_email',
					level: 'warn',
					metadata: { email: 'taken@quoteom.dev' }
				})
			);
		});
	});
});
