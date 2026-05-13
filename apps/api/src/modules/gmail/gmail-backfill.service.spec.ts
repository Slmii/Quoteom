import { EmailProvider } from '@/generated/prisma/enums';
import { EmailAccountsService } from '@/modules/email-accounts/email-accounts.service';
import { GmailApiService } from '@/modules/gmail/gmail-api.service';
import { GmailBackfillService } from '@/modules/gmail/gmail-backfill.service';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { describe, expect, it, jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';

interface FakePrisma {
	emailAccount: {
		findUnique: jest.Mock;
		update: jest.Mock;
	};
	rawMessage: {
		findMany: jest.Mock;
		createMany: jest.Mock;
	};
}

function makePrisma(
	emailAccountRow: object | null,
	existingRawIds: string[] = []
): FakePrisma {
	return {
		emailAccount: {
			findUnique: jest.fn().mockReturnValue(Promise.resolve(emailAccountRow)),
			update: jest.fn().mockReturnValue(Promise.resolve({}))
		},
		rawMessage: {
			findMany: jest
				.fn()
				.mockReturnValue(Promise.resolve(existingRawIds.map(id => ({ providerMessageId: id })))),
			createMany: jest.fn().mockImplementation((args: unknown) => {
				const data = (args as { data: unknown[] }).data;
				return Promise.resolve({ count: data.length });
			})
		}
	};
}

/**
 * Fake EmailAccountsService — just unwraps `withFreshAccessToken(scope, fn)` to fn('TOKEN').
 * The real implementation handles refresh-on-401 retries; for the backfill unit tests we
 * trust that those work (covered separately) and focus on the backfill logic.
 */
function makeAccounts(): EmailAccountsService {
	const withFreshAccessToken = jest.fn().mockImplementation((..._args: unknown[]) => {
		const fn = _args[1] as (t: string) => Promise<unknown>;
		return fn('TOKEN');
	});
	return { withFreshAccessToken } as unknown as EmailAccountsService;
}

interface MessageStub {
	id: string;
	threadId: string;
	subject: string;
	from?: string;
	internalMs?: number;
}

function makeApi(opts: {
	pages: ReadonlyArray<ReadonlyArray<MessageStub>>;
	historyId?: string;
}): GmailApiService {
	const pageIterator = opts.pages.values();
	const pageList = jest.fn().mockImplementation(() => {
		const next = pageIterator.next();
		if (next.done) {
			return Promise.resolve({ messages: [], nextPageToken: null, resultSizeEstimate: 0 });
		}
		const isLast = opts.pages.indexOf(next.value) === opts.pages.length - 1;
		return Promise.resolve({
			messages: next.value.map(m => ({ id: m.id, threadId: m.threadId })),
			nextPageToken: isLast ? null : `tok-after-${next.value[0]?.id ?? 'unk'}`,
			resultSizeEstimate: opts.pages.flat().length
		});
	});

	const allMessages = opts.pages.flat();
	const getFull = jest.fn().mockImplementation((_token: unknown, id: unknown) => {
		const m = allMessages.find(x => x.id === id);
		if (!m) {
			throw new Error(`stub message ${String(id)} not found`);
		}
		const headers: Array<{ name: string; value: string }> = [{ name: 'Subject', value: m.subject }];
		if (m.from) {
			headers.push({ name: 'From', value: m.from });
		}
		return Promise.resolve({
			id: m.id,
			threadId: m.threadId,
			internalDate: String(m.internalMs ?? Date.now()),
			snippet: '',
			payload: { headers }
		});
	});

	const getProfile = jest.fn().mockReturnValue(
		Promise.resolve({
			emailAddress: 'alice@quoteom.dev',
			messagesTotal: allMessages.length,
			threadsTotal: allMessages.length,
			historyId: opts.historyId ?? 'history-final'
		})
	);

	return {
		listMessagesPage: pageList,
		getMessageFull: getFull,
		getProfile
	} as unknown as GmailApiService;
}

const SCOPE_ROW = {
	id: 'ea-1',
	organizationId: 'org-1',
	userId: 'user-1',
	email: 'alice@quoteom.dev',
	provider: EmailProvider.GMAIL
};

describe('GmailBackfillService.run', () => {
	it('throws NotFoundException when EmailAccount is missing', async () => {
		const prisma = makePrisma(null);
		const service = new GmailBackfillService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			makeApi({ pages: [] })
		);
		await expect(service.run('ea-missing')).rejects.toBeInstanceOf(NotFoundException);
	});

	it('skips silently when EmailAccount has no userId (orphaned)', async () => {
		const prisma = makePrisma({ ...SCOPE_ROW, userId: null });
		const service = new GmailBackfillService(
			prisma as unknown as PrismaService,
			makeAccounts(),
			makeApi({ pages: [] })
		);

		const result = await service.run('ea-1');
		expect(result.pagesFetched).toBe(0);
		expect(result.messagesInserted).toBe(0);
		expect(prisma.rawMessage.findMany).not.toHaveBeenCalled();
	});

	it('persists messages from a single page and writes the trailing historyId', async () => {
		const prisma = makePrisma(SCOPE_ROW, []);
		const api = makeApi({
			pages: [
				[
					{ id: 'g-1', threadId: 't-1', subject: 'Offerte aanvraag', from: '"Bob Bouwer" <bob@example.com>' },
					{ id: 'g-2', threadId: 't-2', subject: 'Tuin keukenrenovatie', from: 'klant@gmail.com' }
				]
			],
			historyId: 'history-99'
		});
		const service = new GmailBackfillService(prisma as unknown as PrismaService, makeAccounts(), api);

		const result = await service.run('ea-1');

		expect(result).toMatchObject({
			pagesFetched: 1,
			messagesInserted: 2,
			messagesSkipped: 0,
			historyId: 'history-99'
		});
		expect(prisma.rawMessage.createMany).toHaveBeenCalledTimes(1);
		expect(prisma.emailAccount.update).toHaveBeenCalledWith({
			where: { id: 'ea-1' },
			data: { historyId: 'history-99' }
		});
	});

	it('paginates across multiple pages', async () => {
		const prisma = makePrisma(SCOPE_ROW, []);
		const api = makeApi({
			pages: [
				[{ id: 'g-1', threadId: 't-1', subject: 'A' }],
				[{ id: 'g-2', threadId: 't-2', subject: 'B' }],
				[{ id: 'g-3', threadId: 't-3', subject: 'C' }]
			]
		});
		const service = new GmailBackfillService(prisma as unknown as PrismaService, makeAccounts(), api);

		const result = await service.run('ea-1');

		expect(result.pagesFetched).toBe(3);
		expect(result.messagesInserted).toBe(3);
		expect(prisma.rawMessage.createMany).toHaveBeenCalledTimes(3);
	});

	it('skips messages already present (idempotent re-run)', async () => {
		const prisma = makePrisma(SCOPE_ROW, ['g-1', 'g-3']); // 2 already in DB
		const api = makeApi({
			pages: [
				[
					{ id: 'g-1', threadId: 't-1', subject: 'A' },
					{ id: 'g-2', threadId: 't-2', subject: 'B' },
					{ id: 'g-3', threadId: 't-3', subject: 'C' }
				]
			]
		});
		const service = new GmailBackfillService(prisma as unknown as PrismaService, makeAccounts(), api);

		const result = await service.run('ea-1');

		expect(result.messagesInserted).toBe(1);
		expect(result.messagesSkipped).toBe(2);
		// `createMany` was called with only the new message.
		const insertCall = prisma.rawMessage.createMany.mock.calls[0]?.[0] as { data: Array<{ providerMessageId: string }> };
		expect(insertCall.data.map(d => d.providerMessageId)).toEqual(['g-2']);
	});

	it('parses From header with display name', async () => {
		const prisma = makePrisma(SCOPE_ROW, []);
		const api = makeApi({
			pages: [
				[
					{
						id: 'g-1',
						threadId: 't-1',
						subject: 'Test',
						from: '"Bob Bouwer" <bob@example.com>'
					}
				]
			]
		});
		const service = new GmailBackfillService(prisma as unknown as PrismaService, makeAccounts(), api);

		await service.run('ea-1');

		const insertCall = prisma.rawMessage.createMany.mock.calls[0]?.[0] as {
			data: Array<{ fromEmail: string | null; fromName: string | null }>;
		};
		expect(insertCall.data[0]).toMatchObject({
			fromEmail: 'bob@example.com',
			fromName: 'Bob Bouwer'
		});
	});

	it('parses bare From header without display name', async () => {
		const prisma = makePrisma(SCOPE_ROW, []);
		const api = makeApi({
			pages: [
				[{ id: 'g-1', threadId: 't-1', subject: 'Test', from: 'lone@example.com' }]
			]
		});
		const service = new GmailBackfillService(prisma as unknown as PrismaService, makeAccounts(), api);

		await service.run('ea-1');

		const insertCall = prisma.rawMessage.createMany.mock.calls[0]?.[0] as {
			data: Array<{ fromEmail: string | null; fromName: string | null }>;
		};
		expect(insertCall.data[0]).toMatchObject({
			fromEmail: 'lone@example.com',
			fromName: null
		});
	});

	it('handles missing From header gracefully', async () => {
		const prisma = makePrisma(SCOPE_ROW, []);
		const api = makeApi({
			pages: [[{ id: 'g-1', threadId: 't-1', subject: 'No sender' }]]
		});
		const service = new GmailBackfillService(prisma as unknown as PrismaService, makeAccounts(), api);

		await service.run('ea-1');

		const insertCall = prisma.rawMessage.createMany.mock.calls[0]?.[0] as {
			data: Array<{ fromEmail: string | null; fromName: string | null }>;
		};
		expect(insertCall.data[0]).toMatchObject({ fromEmail: null, fromName: null });
	});

	it('handles a zero-message inbox without crashing', async () => {
		const prisma = makePrisma(SCOPE_ROW, []);
		const api = makeApi({ pages: [[]] });
		const service = new GmailBackfillService(prisma as unknown as PrismaService, makeAccounts(), api);

		const result = await service.run('ea-1');

		expect(result.pagesFetched).toBe(1);
		expect(result.messagesInserted).toBe(0);
		expect(prisma.rawMessage.createMany).not.toHaveBeenCalled();
	});
});
