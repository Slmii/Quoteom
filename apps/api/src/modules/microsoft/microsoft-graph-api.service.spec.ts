import type { LogService } from '@/modules/logger/log.service';
import { MicrosoftGraphApiService } from '@/modules/microsoft/microsoft-graph-api.service';
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

describe('MicrosoftGraphApiService.createSubscription', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('defaults `resource` to /me/mailFolders/Inbox/messages so pushes are inbox-scoped, matching backfill + delta-walk', async () => {
		const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() =>
			Promise.resolve(
				makeJsonResponse({
					id: 'sub-1',
					expirationDateTime: new Date().toISOString(),
					clientState: 'echo'
				})
			)
		);

		const service = new MicrosoftGraphApiService(logServiceStub);
		await service.createSubscription('TOKEN', {
			notificationUrl: 'https://example.com/hook',
			expirationDateTime: new Date(Date.now() + 60_000).toISOString(),
			clientState: 'shared'
			// resource intentionally omitted — exercises the default
		});

		const fetchInit = fetchSpy.mock.calls[0]?.[1] as RequestInit;
		const body = JSON.parse(String(fetchInit.body)) as { resource: string };
		expect(body.resource).toBe('/me/mailFolders/Inbox/messages');
	});

	it('honors an explicit resource override (for future use cases like calendar / files)', async () => {
		const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() =>
			Promise.resolve(
				makeJsonResponse({
					id: 'sub-2',
					expirationDateTime: new Date().toISOString(),
					clientState: 'echo'
				})
			)
		);

		const service = new MicrosoftGraphApiService(logServiceStub);
		await service.createSubscription('TOKEN', {
			notificationUrl: 'https://example.com/hook',
			expirationDateTime: new Date(Date.now() + 60_000).toISOString(),
			clientState: 'shared',
			resource: '/me/events'
		});

		const body = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body)) as {
			resource: string;
		};
		expect(body.resource).toBe('/me/events');
	});
});
