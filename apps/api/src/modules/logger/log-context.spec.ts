import { logContext } from '@/modules/logger/log-context';
import { describe, expect, it } from '@jest/globals';

describe('logContext', () => {
	it('returns undefined outside a `run` boundary', () => {
		expect(logContext.get()).toBeUndefined();
	});

	it('exposes the active context inside `run`', () => {
		logContext.run({ requestId: 'req-1' }, () => {
			expect(logContext.get()).toEqual({ requestId: 'req-1' });
		});
	});

	it('propagates the context across awaits within the same frame', async () => {
		await logContext.run({ requestId: 'req-async' }, async () => {
			await Promise.resolve();
			expect(logContext.get()?.requestId).toBe('req-async');
			await new Promise(resolve => setImmediate(resolve));
			expect(logContext.get()?.requestId).toBe('req-async');
		});
	});

	it('isolates two parallel `run` invocations from each other', async () => {
		const observed: string[] = [];
		await Promise.all([
			logContext.run({ requestId: 'req-A' }, async () => {
				await Promise.resolve();
				observed.push(logContext.get()?.requestId ?? '?');
			}),
			logContext.run({ requestId: 'req-B' }, async () => {
				await Promise.resolve();
				observed.push(logContext.get()?.requestId ?? '?');
			})
		]);
		expect(observed.sort()).toEqual(['req-A', 'req-B']);
	});

	it('set() merges fields into the active store', () => {
		logContext.run({ requestId: 'req-merge' }, () => {
			logContext.set({ userId: 'user-1' });
			logContext.set({ organizationId: 'org-1' });
			expect(logContext.get()).toEqual({
				requestId: 'req-merge',
				userId: 'user-1',
				organizationId: 'org-1'
			});
		});
	});

	it('set() is a no-op outside a `run` boundary', () => {
		expect(() => logContext.set({ userId: 'user-1' })).not.toThrow();
		expect(logContext.get()).toBeUndefined();
	});
});
