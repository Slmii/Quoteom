import { logContext } from '@/modules/logger/log-context';
import { LogService } from '@/modules/logger/log.service';
import type { PrismaService } from '@/modules/prisma/prisma.service';
import { describe, expect, it, jest } from '@jest/globals';

interface CapturedRow {
	level: string;
	message: string;
	context?: string | null;
	stack?: string | null;
	metadata?: Record<string, unknown> | null;
	requestId?: string | null;
	userId?: string | null;
	organizationId?: string | null;
}

function makeService(): { service: LogService; created: CapturedRow[] } {
	const created: CapturedRow[] = [];
	const prisma = {
		log: {
			create: jest.fn().mockImplementation((args: unknown) => {
				const row = (args as { data: CapturedRow }).data;
				created.push(row);
				return Promise.resolve(row);
			})
		}
	} as unknown as PrismaService;

	const service = new LogService(prisma);
	return { service, created };
}

/**
 * The persist path is fire-and-forget — `logAction` / `warn` / `error` schedule the
 * Prisma write via `void this.persist(...)`. To assert on the written row we yield to the
 * microtask queue with a single tick. Two awaits cover Prisma's typical Promise chain.
 */
async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe('LogService', () => {
	it('persists requestId / userId / organizationId from the active log context', async () => {
		const { service, created } = makeService();

		await logContext.run({ requestId: 'req-1', userId: 'user-1', organizationId: 'org-1' }, async () => {
			service.warn('something happened', 'TestContext');
			await flush();
		});

		expect(created).toHaveLength(1);
		const row = created[0]!;
		expect(row).toMatchObject({
			level: 'WARN',
			message: 'something happened',
			context: 'TestContext',
			requestId: 'req-1',
			userId: 'user-1',
			organizationId: 'org-1'
		});
	});

	it('persists with no correlation fields when called outside a request boundary', async () => {
		const { service, created } = makeService();

		service.warn('background job warned', 'Cron');
		await flush();

		expect(created).toHaveLength(1);
		const row = created[0]!;
		expect(row).toMatchObject({
			level: 'WARN',
			requestId: undefined,
			userId: undefined,
			organizationId: undefined
		});
	});

	it('logAction writes an INFO row by default with the action in metadata', async () => {
		const { service, created } = makeService();

		await logContext.run({ requestId: 'req-2', userId: 'u-2', organizationId: 'org-2' }, async () => {
			service.logAction({
				action: 'email.connect',
				message: 'Gmail connected for alice@quoteom.dev',
				metadata: { provider: 'GMAIL', emailAccountId: 'ea-1' },
				context: 'EmailAccountsService'
			});
			await flush();
		});

		expect(created).toHaveLength(1);
		const row = created[0]!;
		expect(row).toMatchObject({
			level: 'INFO',
			message: 'Gmail connected for alice@quoteom.dev',
			context: 'EmailAccountsService',
			requestId: 'req-2',
			userId: 'u-2',
			organizationId: 'org-2'
		});
		expect(row.metadata).toEqual({
			action: 'email.connect',
			provider: 'GMAIL',
			emailAccountId: 'ea-1'
		});
	});

	it('logAction with level=error writes an ERROR row with the stack column populated', async () => {
		const { service, created } = makeService();

		const err = new Error('Stripe API timed out');
		service.logAction({
			action: 'billing.stripe.api_failed',
			message: err.message,
			metadata: { organizationId: 'org-1' },
			level: 'error',
			stack: err.stack
		});
		await flush();

		const row = created[0]!;
		expect(row.level).toBe('ERROR');
		expect(row.stack).toBe(err.stack);
		expect(row.metadata).toEqual({ action: 'billing.stripe.api_failed', organizationId: 'org-1' });
	});

	it('logAction with level=fatal writes a FATAL row', async () => {
		const { service, created } = makeService();

		service.logAction({
			action: 'system.boot_failed',
			message: 'Could not initialize Prisma',
			level: 'fatal'
		});
		await flush();

		expect(created[0]!.level).toBe('FATAL');
	});

	it('logAction with level=warn writes a WARN row', async () => {
		const { service, created } = makeService();

		service.logAction({
			action: 'oauth.microsoft.admin_consent_required',
			message: 'Admin consent required for tenant',
			metadata: { errorCode: 'AADSTS65001' },
			level: 'warn'
		});
		await flush();

		const row = created[0]!;
		expect(row.level).toBe('WARN');
		expect(row.metadata).toEqual({
			action: 'oauth.microsoft.admin_consent_required',
			errorCode: 'AADSTS65001'
		});
	});

	it('logAction defaults context to "Action" when not provided', async () => {
		const { service, created } = makeService();

		service.logAction({ action: 'test.simple', message: 'no context provided' });
		await flush();

		expect(created[0]!.context).toBe('Action');
	});

	it('log/debug/verbose do NOT persist (would flood the table)', async () => {
		const { service, created } = makeService();

		service.log('hello', 'TestContext');
		service.debug('debug', 'TestContext');
		service.verbose('verbose', 'TestContext');
		await flush();

		expect(created).toHaveLength(0);
	});
});
