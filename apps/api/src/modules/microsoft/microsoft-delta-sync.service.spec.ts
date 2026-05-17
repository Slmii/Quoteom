import { EmailProvider } from '@/generated/prisma/enums';
import type { EmailAccountsService } from '@/modules/email-accounts/email-accounts.service';
import { MicrosoftDeltaSyncService } from '@/modules/microsoft/microsoft-delta-sync.service';
import {
	MicrosoftDeltaTokenExpiredException,
	type MicrosoftDeltaPage,
	type MicrosoftGraphApiService
} from '@/modules/microsoft/microsoft-graph-api.service';
import type { PrismaService } from '@/modules/prisma/prisma.service';
import { describe, expect, it, jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';

const logServiceStub = { logAction: () => undefined } as unknown as ConstructorParameters<
	typeof MicrosoftDeltaSyncService
>[3];

interface FakePrisma {
	emailAccount: { findUnique: jest.Mock; update: jest.Mock };
	rawMessage: { findMany: jest.Mock; createMany: jest.Mock };
}

function makePrisma(emailAccountRow: object | null, existingIds: string[] = []): FakePrisma {
	return {
		emailAccount: {
			findUnique: jest.fn().mockReturnValue(Promise.resolve(emailAccountRow)),
			update: jest.fn().mockReturnValue(Promise.resolve({}))
		},
		rawMessage: {
			findMany: jest.fn().mockReturnValue(Promise.resolve(existingIds.map(id => ({ providerMessageId: id })))),
			createMany: jest.fn().mockImplementation((args: unknown) => {
				const data = (args as { data: unknown[] }).data;
				return Promise.resolve({ count: data.length });
			})
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

interface DeltaStub {
	messages: ReadonlyArray<{ id: string }>;
	nextLink?: string;
	deltaLink?: string;
}

function makeApi(opts: {
	pages: ReadonlyArray<DeltaStub>;
	expireOnFirstCall?: boolean;
	expireAfterPage?: number;
	recoveryDeltaLink?: string;
}): MicrosoftGraphApiService {
	const iterator = opts.pages.values();
	let pageIndex = 0;
	let recovered = false;

	const getDelta = jest
		.fn<(token: string, cursor: string | null) => Promise<MicrosoftDeltaPage>>()
		.mockImplementation((_t, cursor) => {
			// First call to recovery walk (after expiry) — start fresh, return new deltaLink.
			if (recovered) {
				return Promise.resolve({
					messages: [],
					nextLink: null,
					deltaLink: opts.recoveryDeltaLink ?? 'delta-recovered'
				});
			}
			if (opts.expireOnFirstCall && cursor === null) {
				// Initial walk on null cursor — return one page so we can advance, expiry only
				// triggers when a stored cursor (non-null) is passed. To exercise pure expire-
				// on-first-call, we'd need a non-null deltaLink on the account row anyway.
				return Promise.resolve({ messages: [], nextLink: null, deltaLink: 'delta-initial' });
			}
			if (opts.expireOnFirstCall) {
				recovered = true;
				return Promise.reject(new MicrosoftDeltaTokenExpiredException());
			}
			if (typeof opts.expireAfterPage === 'number' && pageIndex >= opts.expireAfterPage) {
				recovered = true;
				return Promise.reject(new MicrosoftDeltaTokenExpiredException());
			}
			const next = iterator.next();
			if (next.done) {
				return Promise.resolve({ messages: [], nextLink: null, deltaLink: 'delta-end' });
			}
			pageIndex += 1;
			const page = next.value;
			return Promise.resolve({
				messages: page.messages.map(m => ({
					id: m.id,
					conversationId: `c-${m.id}`,
					receivedDateTime: '2026-01-01T00:00:00Z',
					subject: `Subject ${m.id}`,
					bodyPreview: '',
					from: { emailAddress: { address: 'sender@example.com', name: 'Sender' } }
				})) as MicrosoftDeltaPage['messages'],
				nextLink: page.nextLink ?? null,
				deltaLink: page.deltaLink ?? null
			});
		});

	return {
		getDelta
	} as unknown as MicrosoftGraphApiService;
}

const SCOPE_ROW = {
	id: 'ea-1',
	organizationId: 'org-1',
	userId: 'user-1',
	email: 'alice@quoteom.dev',
	provider: EmailProvider.MICROSOFT,
	deltaLink: 'delta-prior'
};

describe('MicrosoftDeltaSyncService.run', () => {
	it('throws NotFoundException when EmailAccount is missing', async () => {
		const prisma = makePrisma(null);
		const service = new MicrosoftDeltaSyncService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			makeApi({ pages: [] }),
			logServiceStub
		);
		await expect(service.run('ea-missing')).rejects.toBeInstanceOf(NotFoundException);
	});

	it('throws NotFoundException when provider is GMAIL (cross-provider guard)', async () => {
		const prisma = makePrisma({ ...SCOPE_ROW, provider: EmailProvider.GMAIL });
		const service = new MicrosoftDeltaSyncService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			makeApi({ pages: [] }),
			logServiceStub
		);
		await expect(service.run('ea-1')).rejects.toBeInstanceOf(NotFoundException);
	});

	it('skips when EmailAccount has no userId (orphaned)', async () => {
		const prisma = makePrisma({ ...SCOPE_ROW, userId: null });
		const service = new MicrosoftDeltaSyncService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			makeApi({ pages: [] }),
			logServiceStub
		);
		const result = await service.run('ea-1');
		expect(result.pagesFetched).toBe(0);
		expect(prisma.emailAccount.update).not.toHaveBeenCalled();
	});

	it('persists messages from a single delta page and advances the cursor', async () => {
		const prisma = makePrisma(SCOPE_ROW, []);
		const service = new MicrosoftDeltaSyncService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			makeApi({
				pages: [{ messages: [{ id: 'm-1' }, { id: 'm-2' }], deltaLink: 'delta-new' }]
			}),
			logServiceStub
		);

		const result = await service.run('ea-1');

		expect(result).toMatchObject({
			pagesFetched: 1,
			messagesInserted: 2,
			messagesSkipped: 0,
			deltaLink: 'delta-new',
			deltaTokenExpired: false
		});
		expect(prisma.emailAccount.update).toHaveBeenCalledWith({
			where: { id: 'ea-1' },
			data: { deltaLink: 'delta-new' }
		});
	});

	it('walks nextLink pages until deltaLink terminates the walk', async () => {
		const prisma = makePrisma(SCOPE_ROW, []);
		const service = new MicrosoftDeltaSyncService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			makeApi({
				pages: [
					{ messages: [{ id: 'm-1' }], nextLink: 'next-1' },
					{ messages: [{ id: 'm-2' }], deltaLink: 'delta-final' }
				]
			}),
			logServiceStub
		);

		const result = await service.run('ea-1');
		expect(result.pagesFetched).toBe(2);
		expect(result.messagesInserted).toBe(2);
		expect(result.deltaLink).toBe('delta-final');
	});

	it('skips messages already present (idempotency via unique index)', async () => {
		const prisma = makePrisma(SCOPE_ROW, ['m-1']);
		const service = new MicrosoftDeltaSyncService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			makeApi({
				pages: [{ messages: [{ id: 'm-1' }, { id: 'm-2' }], deltaLink: 'delta-new' }]
			}),
			logServiceStub
		);

		const result = await service.run('ea-1');
		expect(result.messagesInserted).toBe(1);
		expect(result.messagesSkipped).toBe(1);
		const createCall = prisma.rawMessage.createMany.mock.calls[0]?.[0] as {
			data: Array<{ providerMessageId: string }>;
		};
		expect(createCall.data.map(d => d.providerMessageId)).toEqual(['m-2']);
	});

	it('preserves prior pages when deltaLink expires mid-walk (recovers cursor)', async () => {
		const prisma = makePrisma(SCOPE_ROW, []);
		const service = new MicrosoftDeltaSyncService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			makeApi({
				pages: [{ messages: [{ id: 'm-1' }], nextLink: 'next-1' }],
				expireAfterPage: 1,
				recoveryDeltaLink: 'delta-recovered'
			}),
			logServiceStub
		);

		const result = await service.run('ea-1');
		expect(result.deltaTokenExpired).toBe(true);
		expect(result.pagesFetched).toBe(1);
		expect(result.messagesInserted).toBe(1);
		expect(result.deltaLink).toBe('delta-recovered');
		expect(prisma.rawMessage.createMany).toHaveBeenCalledTimes(1);
		expect(prisma.emailAccount.update).toHaveBeenCalledWith({
			where: { id: 'ea-1' },
			data: { deltaLink: 'delta-recovered' }
		});
	});

	it('never overwrites an existing cursor with null when no new deltaLink was captured', async () => {
		const prisma = makePrisma(SCOPE_ROW, []);
		// Pages exhaust without ever returning deltaLink — newDeltaLink stays null. The
		// service should NOT call update() in that case.
		const service = new MicrosoftDeltaSyncService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			makeApi({ pages: [{ messages: [{ id: 'm-1' }] }] }), // no nextLink + no deltaLink → break
			logServiceStub
		);
		const result = await service.run('ea-1');
		expect(result.deltaLink).toBeNull();
		expect(prisma.emailAccount.update).not.toHaveBeenCalled();
	});
});
