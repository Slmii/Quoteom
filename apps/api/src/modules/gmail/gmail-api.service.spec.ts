import { GmailApiService } from '@/modules/gmail/gmail-api.service';
import type { LogService } from '@/modules/logger/log.service';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

const logServiceStub = { logAction: jest.fn() } as unknown as LogService;

function makeJsonResponse(body: unknown, init: Partial<{ status: number; ok: boolean }> = {}): Response {
	return {
		status: init.status ?? 200,
		ok: init.ok ?? true,
		text: () => Promise.resolve(''),
		json: () => Promise.resolve(body)
	} as unknown as Response;
}

describe('GmailApiService.listRecentInboxMessages', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it("scopes the recent-list to INBOX via labelIds=INBOX (matches backfill q=in:inbox, watch labelIds=['INBOX'], history.list labelId=INBOX)", async () => {
		const fetchSpy = jest
			.spyOn(global, 'fetch')
			.mockImplementation(() => Promise.resolve(makeJsonResponse({ messages: [] })));

		const service = new GmailApiService(logServiceStub);
		await service.listRecentInboxMessages('TOKEN', 10);

		const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
		expect(calledUrl).toContain('labelIds=INBOX');
		expect(calledUrl).toContain('maxResults=10');
	});
});

describe('GmailApiService.listHistoryPage', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('scopes the history walk to INBOX (defense in depth — push delivery is INBOX-only but the walk shouldn\'t pick up Sent/Drafts even on stray pushes)', async () => {
		const fetchSpy = jest
			.spyOn(global, 'fetch')
			.mockImplementation(() =>
				Promise.resolve(makeJsonResponse({ history: [], historyId: '99' }))
			);

		const service = new GmailApiService(logServiceStub);
		await service.listHistoryPage('TOKEN', { startHistoryId: '42' });

		const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
		expect(calledUrl).toContain('historyTypes=messageAdded');
		expect(calledUrl).toContain('labelId=INBOX');
		expect(calledUrl).toContain('startHistoryId=42');
	});
});
