// Set encryption key BEFORE token-encryption module is imported, so `encrypt()` succeeds
// when this spec eagerly encrypts a stub clientState during prisma row construction.
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY ?? 'ab'.repeat(32);

import type { EnvSchema } from '@/config/env.schema';
import { EmailProvider } from '@/generated/prisma/enums';
import { encrypt } from '@/lib/crypto/token-encryption';
import type { EmailAccountsService } from '@/modules/email-accounts/email-accounts.service';
import type { LogService } from '@/modules/logger/log.service';
import {
	MicrosoftSubscriptionNotFoundException,
	type MicrosoftGraphApiService
} from '@/modules/microsoft/microsoft-graph-api.service';
import { MicrosoftSubscriptionService } from '@/modules/microsoft/microsoft-subscription.service';
import type { PrismaService } from '@/modules/prisma/prisma.service';
import { describe, expect, it, jest } from '@jest/globals';
import { InternalServerErrorException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

interface AccountSeed {
	id: string;
	subscriptionId?: string | null;
	deltaLink?: string | null;
	watchExpiresAt?: Date | null;
}

interface FakePrisma {
	emailAccount: {
		findUnique: jest.Mock;
		findMany: jest.Mock;
		update: jest.Mock;
		updateMany: jest.Mock;
	};
}

function makePrisma(rows: ReadonlyArray<AccountSeed>): FakePrisma {
	return {
		emailAccount: {
			findUnique: jest.fn().mockImplementation((args: unknown) => {
				const id = (args as { where: { id: string } }).where.id;
				const row = rows.find(r => r.id === id);
				if (!row) {
					return Promise.resolve(null);
				}
				return Promise.resolve({
					id: row.id,
					organizationId: 'org-1',
					userId: 'user-1',
					email: `${row.id}@quoteom.dev`,
					provider: EmailProvider.MICROSOFT,
					subscriptionId: row.subscriptionId ?? null,
					subscriptionClientState: encrypt('shared-secret-known')
				});
			}),
			findMany: jest.fn().mockReturnValue(
				Promise.resolve(
					rows.map(r => ({
						id: r.id,
						subscriptionId: r.subscriptionId ?? null,
						organizationId: 'org-1',
						userId: 'user-1',
						email: `${r.id}@quoteom.dev`,
						provider: EmailProvider.MICROSOFT
					}))
				)
			),
			update: jest.fn().mockReturnValue(Promise.resolve({})),
			updateMany: jest.fn().mockReturnValue(Promise.resolve({ count: 1 }))
		}
	};
}

function makeAccounts(): EmailAccountsService {
	const withFreshAccessToken = jest.fn().mockImplementation((..._args: unknown[]) => {
		const fn = _args[1] as (t: string) => Promise<unknown>;
		return fn('TOKEN');
	});
	return { withFreshAccessToken } as unknown as EmailAccountsService;
}

function makeApi(overrides: Partial<MicrosoftGraphApiService> = {}): MicrosoftGraphApiService {
	return {
		createSubscription: jest.fn().mockImplementation(() =>
			Promise.resolve({
				id: 'sub-new',
				expirationDateTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
			})
		),
		renewSubscription: jest.fn().mockImplementation(() =>
			Promise.resolve({
				id: 'sub-existing',
				expirationDateTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
			})
		),
		deleteSubscription: jest.fn().mockReturnValue(Promise.resolve()),
		...overrides
	} as unknown as MicrosoftGraphApiService;
}

function makeConfig(url: string | undefined): ConfigService<EnvSchema, true> {
	return { get: jest.fn().mockReturnValue(url) } as unknown as ConfigService<EnvSchema, true>;
}

const logServiceStub = { logAction: jest.fn() } as unknown as LogService;

describe('MicrosoftSubscriptionService.startSubscriptionForAccount', () => {
	it('no-ops when MICROSOFT_GRAPH_NOTIFICATION_URL is not configured', async () => {
		const prisma = makePrisma([{ id: 'ea-1' }]);
		const api = makeApi();
		const service = new MicrosoftSubscriptionService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			api,
			makeConfig(undefined),
			logServiceStub
		);
		const result = await service.startSubscriptionForAccount('ea-1');
		expect(result).toBeNull();
		expect(api.createSubscription).not.toHaveBeenCalled();
		expect(prisma.emailAccount.update).not.toHaveBeenCalled();
	});

	it('returns null when account is missing or provider is not MICROSOFT', async () => {
		const prisma = makePrisma([]);
		const service = new MicrosoftSubscriptionService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			makeApi(),
			makeConfig('https://app.example.com/hook'),
			logServiceStub
		);
		const result = await service.startSubscriptionForAccount('ea-missing');
		expect(result).toBeNull();
	});

	it('persists subscriptionId + clientState + watchExpiresAt on success', async () => {
		const prisma = makePrisma([{ id: 'ea-1' }]);
		const api = makeApi();
		const service = new MicrosoftSubscriptionService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			api,
			makeConfig('https://app.example.com/hook'),
			logServiceStub
		);

		const result = await service.startSubscriptionForAccount('ea-1');
		expect(result?.expiration).toBeInstanceOf(Date);
		expect(api.createSubscription).toHaveBeenCalledTimes(1);
		const updateCall = prisma.emailAccount.updateMany.mock.calls[0]?.[0] as {
			data: { subscriptionId: string; subscriptionClientState: string; watchExpiresAt: Date };
		};
		expect(updateCall.data.subscriptionId).toBe('sub-new');
		expect(typeof updateCall.data.subscriptionClientState).toBe('string');
		// Stored encrypted (`v1:...` ciphertext format) — never raw.
		expect(updateCall.data.subscriptionClientState.startsWith('v1:')).toBe(true);
		expect(updateCall.data.watchExpiresAt).toBeInstanceOf(Date);
	});

	it('stops a prior subscription before creating a fresh one (idempotent retry)', async () => {
		const prisma = makePrisma([{ id: 'ea-1', subscriptionId: 'sub-old' }]);
		const api = makeApi();
		const service = new MicrosoftSubscriptionService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			api,
			makeConfig('https://app.example.com/hook'),
			logServiceStub
		);
		await service.startSubscriptionForAccount('ea-1');
		expect(api.deleteSubscription).toHaveBeenCalledTimes(1);
		const deleteArg = (api.deleteSubscription as jest.Mock).mock.calls[0]?.[1];
		expect(deleteArg).toBe('sub-old');
		expect(api.createSubscription).toHaveBeenCalledTimes(1);
	});
});

describe('MicrosoftSubscriptionService.stopSubscriptionForAccount', () => {
	it('returns silently when account has no subscriptionId', async () => {
		const prisma = makePrisma([{ id: 'ea-1', subscriptionId: null }]);
		const api = makeApi();
		const service = new MicrosoftSubscriptionService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			api,
			makeConfig('https://app.example.com/hook'),
			logServiceStub
		);
		await service.stopSubscriptionForAccount('ea-1');
		expect(api.deleteSubscription).not.toHaveBeenCalled();
	});

	it('swallows Graph errors so disconnect cannot fail on a Graph hiccup', async () => {
		const prisma = makePrisma([{ id: 'ea-1', subscriptionId: 'sub-existing' }]);
		const api = makeApi({
			deleteSubscription: jest
				.fn<MicrosoftGraphApiService['deleteSubscription']>()
				.mockImplementation(() => Promise.reject(new InternalServerErrorException('graph-down')))
		});
		const service = new MicrosoftSubscriptionService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			api,
			makeConfig('https://app.example.com/hook'),
			logServiceStub
		);
		// Should NOT throw.
		await expect(service.stopSubscriptionForAccount('ea-1')).resolves.toBeUndefined();
	});
});

describe('MicrosoftSubscriptionService.renewExpiringSubscriptions', () => {
	it('no-ops when MICROSOFT_GRAPH_NOTIFICATION_URL is not configured', async () => {
		const prisma = makePrisma([{ id: 'ea-1', subscriptionId: 'sub-1' }]);
		const api = makeApi();
		const service = new MicrosoftSubscriptionService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			api,
			makeConfig(undefined),
			logServiceStub
		);
		const result = await service.renewExpiringSubscriptions();
		expect(result).toEqual({ scanned: 0, renewed: 0, skipped: 0, failed: 0 });
		expect(api.renewSubscription).not.toHaveBeenCalled();
	});

	it('PATCHes the existing subscription and persists the new expiry', async () => {
		const prisma = makePrisma([{ id: 'ea-1', subscriptionId: 'sub-existing' }]);
		const api = makeApi();
		const service = new MicrosoftSubscriptionService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			api,
			makeConfig('https://app.example.com/hook'),
			logServiceStub
		);
		const result = await service.renewExpiringSubscriptions();
		expect(result.scanned).toBe(1);
		expect(result.renewed).toBe(1);
		expect(result.failed).toBe(0);
		expect(api.renewSubscription).toHaveBeenCalledTimes(1);
		expect(prisma.emailAccount.updateMany).toHaveBeenCalled();
	});

	it('recreates the subscription when Graph returns 404 on renew', async () => {
		const prisma = makePrisma([{ id: 'ea-1', subscriptionId: 'sub-stale' }]);
		const api = makeApi({
			renewSubscription: jest
				.fn<MicrosoftGraphApiService['renewSubscription']>()
				.mockImplementation(() => Promise.reject(new MicrosoftSubscriptionNotFoundException('sub-stale')))
		});
		const service = new MicrosoftSubscriptionService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			api,
			makeConfig('https://app.example.com/hook'),
			logServiceStub
		);
		const result = await service.renewExpiringSubscriptions();
		// 404 path → falls through to startSubscriptionForAccount → createSubscription.
		expect(api.createSubscription).toHaveBeenCalledTimes(1);
		expect(result.renewed).toBe(1);
		expect(result.failed).toBe(0);
	});

	it('records failures without aborting the batch', async () => {
		const prisma = makePrisma([
			{ id: 'ea-good', subscriptionId: 'sub-good' },
			{ id: 'ea-bad', subscriptionId: 'sub-bad' }
		]);
		let calls = 0;
		const api = makeApi({
			renewSubscription: jest.fn<MicrosoftGraphApiService['renewSubscription']>().mockImplementation((_t, id) => {
				calls += 1;
				if (id === 'sub-bad') {
					return Promise.reject(new Error('graph-bad-request'));
				}
				return Promise.resolve({
					id: id as string,
					expirationDateTime: new Date(Date.now() + 1000).toISOString()
				});
			})
		});
		const service = new MicrosoftSubscriptionService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			api,
			makeConfig('https://app.example.com/hook'),
			logServiceStub
		);
		const result = await service.renewExpiringSubscriptions();
		expect(calls).toBe(2);
		expect(result.scanned).toBe(2);
		expect(result.renewed).toBe(1);
		expect(result.failed).toBe(1);
	});
});

describe('MicrosoftSubscriptionService.getClientStateForAccount', () => {
	it('returns decrypted plaintext for a MICROSOFT row with a stored clientState', async () => {
		const prisma = makePrisma([{ id: 'ea-1', subscriptionId: 'sub-1' }]);
		const service = new MicrosoftSubscriptionService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			makeApi(),
			makeConfig('https://app.example.com/hook'),
			logServiceStub
		);
		const value = await service.getClientStateForAccount('ea-1');
		expect(value).toBe('shared-secret-known');
	});

	it('returns null for an unknown account', async () => {
		const prisma = makePrisma([]);
		const service = new MicrosoftSubscriptionService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			makeApi(),
			makeConfig('https://app.example.com/hook'),
			logServiceStub
		);
		const value = await service.getClientStateForAccount('ea-missing');
		expect(value).toBeNull();
	});
});
