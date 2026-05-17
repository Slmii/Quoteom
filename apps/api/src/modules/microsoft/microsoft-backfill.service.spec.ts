import { EmailProvider } from '@/generated/prisma/enums';
import { EmailAccountsService } from '@/modules/email-accounts/email-accounts.service';
import { MicrosoftBackfillService } from '@/modules/microsoft/microsoft-backfill.service';
import { MicrosoftGraphApiService } from '@/modules/microsoft/microsoft-graph-api.service';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { describe, expect, it, jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';

// LogService stub — same rationale as gmail-backfill.service.spec.ts.
const logServiceStub = { logAction: () => undefined } as unknown as ConstructorParameters<
	typeof MicrosoftBackfillService
>[3];

interface FakePrisma {
	emailAccount: { findUnique: jest.Mock };
	rawMessage: {
		findMany: jest.Mock;
		createMany: jest.Mock;
	};
}

function makePrisma(emailAccountRow: object | null, existingRawIds: string[] = []): FakePrisma {
	return {
		emailAccount: {
			findUnique: jest.fn().mockReturnValue(Promise.resolve(emailAccountRow))
		},
		rawMessage: {
			findMany: jest.fn().mockReturnValue(Promise.resolve(existingRawIds.map(id => ({ providerMessageId: id })))),
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

interface MessageStub {
	id: string;
	conversationId: string;
	subject: string;
	fromName?: string;
	fromAddr?: string;
	receivedIso?: string;
}

function makeApi(opts: { pages: ReadonlyArray<ReadonlyArray<MessageStub>> }): MicrosoftGraphApiService {
	const pageIterator = opts.pages.values();
	const listPage = jest.fn().mockImplementation(() => {
		const next = pageIterator.next();
		if (next.done) {
			return Promise.resolve({ messages: [], nextLink: null });
		}
		const isLast = opts.pages.indexOf(next.value) === opts.pages.length - 1;
		return Promise.resolve({
			messages: next.value.map(m => ({
				id: m.id,
				conversationId: m.conversationId,
				subject: m.subject,
				receivedDateTime: m.receivedIso ?? '2026-05-01T10:00:00Z',
				bodyPreview: '',
				from: m.fromAddr ? { emailAddress: { name: m.fromName ?? null, address: m.fromAddr } } : null
			})),
			nextLink: isLast ? null : `https://graph.microsoft.com/...skip${next.value[0]?.id}`
		});
	});

	return { listInboxMessagesPage: listPage } as unknown as MicrosoftGraphApiService;
}

const SCOPE_ROW = {
	id: 'ea-1',
	organizationId: 'org-1',
	userId: 'user-1',
	email: 'alice@quoteom.dev',
	provider: EmailProvider.MICROSOFT
};

describe('MicrosoftBackfillService.run', () => {
	it('throws NotFoundException when EmailAccount is missing', async () => {
		const prisma = makePrisma(null);
		const service = new MicrosoftBackfillService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			makeApi({ pages: [] }),
			logServiceStub
		);
		await expect(service.run('ea-missing')).rejects.toBeInstanceOf(NotFoundException);
	});

	it('throws NotFoundException when EmailAccount is the wrong provider', async () => {
		const prisma = makePrisma({ ...SCOPE_ROW, provider: EmailProvider.GMAIL });
		const service = new MicrosoftBackfillService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			makeApi({ pages: [] }),
			logServiceStub
		);
		await expect(service.run('ea-1')).rejects.toBeInstanceOf(NotFoundException);
	});

	it('skips silently when EmailAccount has no userId (orphaned)', async () => {
		const prisma = makePrisma({ ...SCOPE_ROW, userId: null });
		const service = new MicrosoftBackfillService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			makeApi({ pages: [] }),
			logServiceStub
		);
		const result = await service.run('ea-1');
		expect(result.pagesFetched).toBe(0);
		expect(prisma.rawMessage.findMany).not.toHaveBeenCalled();
	});

	it('persists messages from a single page', async () => {
		const prisma = makePrisma(SCOPE_ROW, []);
		const api = makeApi({
			pages: [
				[
					{
						id: 'm-1',
						conversationId: 'c-1',
						subject: 'Offerte aanvraag',
						fromName: 'Bob Bouwer',
						fromAddr: 'bob@example.com'
					},
					{ id: 'm-2', conversationId: 'c-2', subject: 'Hello', fromAddr: 'lone@example.com' }
				]
			]
		});
		const service = new MicrosoftBackfillService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			api,
			logServiceStub
		);

		const result = await service.run('ea-1');
		expect(result.messagesInserted).toBe(2);
		expect(result.pagesFetched).toBe(1);
	});

	it('paginates via @odata.nextLink', async () => {
		const prisma = makePrisma(SCOPE_ROW, []);
		const api = makeApi({
			pages: [
				[{ id: 'm-1', conversationId: 'c-1', subject: 'A' }],
				[{ id: 'm-2', conversationId: 'c-2', subject: 'B' }],
				[{ id: 'm-3', conversationId: 'c-3', subject: 'C' }]
			]
		});
		const service = new MicrosoftBackfillService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			api,
			logServiceStub
		);

		const result = await service.run('ea-1');
		expect(result.pagesFetched).toBe(3);
		expect(result.messagesInserted).toBe(3);
	});

	it('skips messages already present (idempotent re-run)', async () => {
		const prisma = makePrisma(SCOPE_ROW, ['m-1', 'm-3']);
		const api = makeApi({
			pages: [
				[
					{ id: 'm-1', conversationId: 'c-1', subject: 'A' },
					{ id: 'm-2', conversationId: 'c-2', subject: 'B' },
					{ id: 'm-3', conversationId: 'c-3', subject: 'C' }
				]
			]
		});
		const service = new MicrosoftBackfillService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			api,
			logServiceStub
		);

		const result = await service.run('ea-1');
		expect(result.messagesInserted).toBe(1);
		expect(result.messagesSkipped).toBe(2);
		const insertCall = prisma.rawMessage.createMany.mock.calls[0]?.[0] as {
			data: Array<{ providerMessageId: string }>;
		};
		expect(insertCall.data.map(d => d.providerMessageId)).toEqual(['m-2']);
	});

	it('parses From into email + name fields', async () => {
		const prisma = makePrisma(SCOPE_ROW, []);
		const api = makeApi({
			pages: [
				[
					{
						id: 'm-1',
						conversationId: 'c-1',
						subject: 'X',
						fromName: 'Bob Bouwer',
						fromAddr: 'BOB@example.com'
					}
				]
			]
		});
		const service = new MicrosoftBackfillService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			api,
			logServiceStub
		);

		await service.run('ea-1');
		const insertCall = prisma.rawMessage.createMany.mock.calls[0]?.[0] as {
			data: Array<{ fromEmail: string | null; fromName: string | null }>;
		};
		// Lowercased on persist for case-insensitive matching downstream.
		expect(insertCall.data[0]).toMatchObject({ fromEmail: 'bob@example.com', fromName: 'Bob Bouwer' });
	});

	it('handles missing From gracefully', async () => {
		const prisma = makePrisma(SCOPE_ROW, []);
		const api = makeApi({
			pages: [[{ id: 'm-1', conversationId: 'c-1', subject: 'No sender' }]]
		});
		const service = new MicrosoftBackfillService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			api,
			logServiceStub
		);

		await service.run('ea-1');
		const insertCall = prisma.rawMessage.createMany.mock.calls[0]?.[0] as {
			data: Array<{ fromEmail: string | null; fromName: string | null }>;
		};
		expect(insertCall.data[0]).toMatchObject({ fromEmail: null, fromName: null });
	});

	it('handles a zero-message inbox without crashing', async () => {
		const prisma = makePrisma(SCOPE_ROW, []);
		const api = makeApi({ pages: [[]] });
		const service = new MicrosoftBackfillService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			api,
			logServiceStub
		);

		const result = await service.run('ea-1');
		expect(result.pagesFetched).toBe(1);
		expect(result.messagesInserted).toBe(0);
		expect(prisma.rawMessage.createMany).not.toHaveBeenCalled();
	});
});
