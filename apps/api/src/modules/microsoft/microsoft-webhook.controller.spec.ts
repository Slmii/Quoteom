// Set encryption key BEFORE any module that pulls token-encryption is loaded transitively.
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY ?? 'ab'.repeat(32);

import { EmailProvider } from '@/generated/prisma/enums';
import { inngest } from '@/modules/inngest/inngest.client';
import type { LogService } from '@/modules/logger/log.service';
import { MicrosoftWebhookController } from '@/modules/microsoft/microsoft-webhook.controller';
import type { MicrosoftSubscriptionService } from '@/modules/microsoft/microsoft-subscription.service';
import type { PrismaService } from '@/modules/prisma/prisma.service';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import type { Request, Response } from 'express';

const logServiceStub = { logAction: jest.fn() } as unknown as LogService;

function makeRequest(body: unknown): Request {
	return { body } as unknown as Request;
}

interface ResponseSpy {
	res: Response;
	type: jest.Mock;
	status: jest.Mock;
	send: jest.Mock;
	get body(): unknown;
}

function makeResponseSpy(): ResponseSpy {
	let body: unknown;
	const spy: { res: Response; type: jest.Mock; status: jest.Mock; send: jest.Mock } = {
		res: undefined as unknown as Response,
		type: jest.fn(),
		status: jest.fn(),
		send: jest.fn()
	};
	const res = {
		type: spy.type.mockImplementation(() => res),
		status: spy.status.mockImplementation(() => res),
		send: spy.send.mockImplementation((b?: unknown) => {
			body = b;
			return res;
		})
	} as unknown as Response;
	spy.res = res;
	return {
		...spy,
		get body() {
			return body;
		}
	};
}

function makePrisma(rows: ReadonlyArray<{ subscriptionId: string; emailAccountId: string }>): PrismaService {
	return {
		emailAccount: {
			findFirst: jest.fn().mockImplementation((args: unknown) => {
				const subscriptionId = (args as { where: { subscriptionId: string } }).where.subscriptionId;
				const row = rows.find(r => r.subscriptionId === subscriptionId);
				if (!row) {
					return Promise.resolve(null);
				}
				return Promise.resolve({
					id: row.emailAccountId,
					organizationId: 'org-1',
					email: `${row.emailAccountId}@quoteom.dev`
				});
			})
		}
	} as unknown as PrismaService;
}

function makeSubscriptions(stateByAccountId: Record<string, string | null>): MicrosoftSubscriptionService {
	return {
		getClientStateForAccount: jest
			.fn<MicrosoftSubscriptionService['getClientStateForAccount']>()
			.mockImplementation(id => Promise.resolve(stateByAccountId[id] ?? null))
	} as unknown as MicrosoftSubscriptionService;
}

describe('MicrosoftWebhookController.receive', () => {
	beforeEach(() => {
		// Stub inngest.send so we don't actually emit events during unit tests. Reset
		// between tests so call history doesn't bleed across assertions.
		jest.restoreAllMocks();
		jest.spyOn(inngest, 'send').mockImplementation(() => Promise.resolve({ ids: [] }) as never);
	});

	it('echoes validationToken on the handshake path as raw plaintext without touching DB', async () => {
		const prisma = makePrisma([]);
		const subs = makeSubscriptions({});
		const controller = new MicrosoftWebhookController(prisma, subs, logServiceStub);
		const spy = makeResponseSpy();

		await controller.receive(makeRequest(undefined), spy.res, 'tok-abc');
		expect(spy.type).toHaveBeenCalledWith('text/plain');
		expect(spy.status).toHaveBeenCalledWith(200);
		expect(spy.send).toHaveBeenCalledWith('tok-abc');
		// Make sure the raw token (no JSON quotes) is the actual body.
		expect(spy.body).toBe('tok-abc');
		expect(prisma.emailAccount.findFirst).not.toHaveBeenCalled();
		expect(inngest.send).not.toHaveBeenCalled();
	});

	it('rejects requests without a `value` array', async () => {
		const controller = new MicrosoftWebhookController(makePrisma([]), makeSubscriptions({}), logServiceStub);
		await expect(controller.receive(makeRequest({}), makeResponseSpy().res, undefined)).rejects.toBeInstanceOf(
			BadRequestException
		);
		await expect(
			controller.receive(makeRequest({ value: 'not-array' }), makeResponseSpy().res, undefined)
		).rejects.toBeInstanceOf(BadRequestException);
	});

	it('acknowledges unknown subscriptions without enqueuing', async () => {
		const prisma = makePrisma([]); // no rows match
		const controller = new MicrosoftWebhookController(prisma, makeSubscriptions({}), logServiceStub);
		const spy = makeResponseSpy();

		await controller.receive(
			makeRequest({
				value: [
					{
						subscriptionId: 'sub-unknown',
						clientState: 'whatever',
						changeType: 'created'
					}
				]
			}),
			spy.res,
			undefined
		);

		expect(inngest.send).not.toHaveBeenCalled();
		expect(spy.status).toHaveBeenCalledWith(202);
	});

	it('drops the batch when clientState does not match the stored secret', async () => {
		const prisma = makePrisma([{ subscriptionId: 'sub-1', emailAccountId: 'ea-1' }]);
		const subs = makeSubscriptions({ 'ea-1': 'shared-secret-known' });
		const controller = new MicrosoftWebhookController(prisma, subs, logServiceStub);

		await controller.receive(
			makeRequest({
				value: [{ subscriptionId: 'sub-1', clientState: 'forged-secret', changeType: 'created' }]
			}),
			makeResponseSpy().res,
			undefined
		);

		expect(inngest.send).not.toHaveBeenCalled();
	});

	it('drops the batch when the account has no stored clientState (subscription pending)', async () => {
		const prisma = makePrisma([{ subscriptionId: 'sub-1', emailAccountId: 'ea-1' }]);
		const subs = makeSubscriptions({ 'ea-1': null });
		const controller = new MicrosoftWebhookController(prisma, subs, logServiceStub);

		await controller.receive(
			makeRequest({
				value: [{ subscriptionId: 'sub-1', clientState: 'anything', changeType: 'created' }]
			}),
			makeResponseSpy().res,
			undefined
		);

		expect(inngest.send).not.toHaveBeenCalled();
	});

	it('enqueues exactly one event per unique account in the batch', async () => {
		const prisma = makePrisma([{ subscriptionId: 'sub-1', emailAccountId: 'ea-1' }]);
		const subs = makeSubscriptions({ 'ea-1': 'shared-secret-known' });
		const controller = new MicrosoftWebhookController(prisma, subs, logServiceStub);

		await controller.receive(
			makeRequest({
				value: [
					{ subscriptionId: 'sub-1', clientState: 'shared-secret-known', changeType: 'created' },
					{ subscriptionId: 'sub-1', clientState: 'shared-secret-known', changeType: 'created' },
					{ subscriptionId: 'sub-1', clientState: 'shared-secret-known', changeType: 'created' }
				]
			}),
			makeResponseSpy().res,
			undefined
		);

		// 3 notifications for the same subscription → ONE Inngest event (per-mailbox dedup).
		expect(inngest.send).toHaveBeenCalledTimes(1);
		const sendArg = (inngest.send as jest.Mock).mock.calls[0]?.[0] as {
			name: string;
			data: { emailAccountId: string; organizationId: string };
		};
		expect(sendArg.name).toBe('microsoft/delta.changed');
		expect(sendArg.data.emailAccountId).toBe('ea-1');
		expect(sendArg.data.organizationId).toBe('org-1');
	});

	it('drops the whole batch when ANY notification fails clientState verification (mixed batch defense)', async () => {
		const prisma = makePrisma([{ subscriptionId: 'sub-1', emailAccountId: 'ea-1' }]);
		const subs = makeSubscriptions({ 'ea-1': 'shared-secret-known' });
		const controller = new MicrosoftWebhookController(prisma, subs, logServiceStub);

		await controller.receive(
			makeRequest({
				value: [
					{ subscriptionId: 'sub-1', clientState: 'shared-secret-known', changeType: 'created' },
					{ subscriptionId: 'sub-1', clientState: 'forged-secret', changeType: 'created' }
				]
			}),
			makeResponseSpy().res,
			undefined
		);

		// Even though one entry was valid, the bad mix-in causes the whole batch to be dropped.
		expect(inngest.send).not.toHaveBeenCalled();
	});

	// Sanity check: prove EmailProvider import is reachable. Jest treats unused imports as
	// warnings under noUnusedLocals in some configs.
	it('uses EmailProvider enum (compile-time sanity)', () => {
		expect(EmailProvider.MICROSOFT).toBeDefined();
	});
});
