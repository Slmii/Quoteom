import { processOpportunitiesInBatches } from '@/modules/inngest/functions/process-opportunities-in-batches';
import type { LogService } from '@/modules/logger/log.service';
import type { OpportunitiesService } from '@/modules/opportunities/opportunities.service';
import type {
	OpportunityProcessingBatchResult,
	OpportunityProcessingResult
} from '@/modules/opportunities/opportunities.types';
import { PROCESS_MAX_BATCHES_PER_RUN } from '@/modules/opportunities/opportunities.types';
import { describe, expect, it, jest } from '@jest/globals';

function makeStep() {
	// `jest.fn(...)` erases the generic on `run<T>`, so we use a plain method here.
	// The shape still satisfies `ProcessOpportunitiesInBatchesArgs['step']`, and we
	// track invocation count + ordering via the `calls` array rather than jest matchers.
	const calls: string[] = [];
	const step = {
		async run<T>(name: string, handler: () => Promise<T>): Promise<T> {
			calls.push(name);
			return handler();
		}
	};
	return { step, calls };
}

function emptyResult(emailAccountId: string): OpportunityProcessingResult {
	return {
		emailAccountId,
		scanned: 0,
		classifiedPositive: 0,
		classifiedNegative: 0,
		opportunitiesCreated: 0,
		opportunitiesSkipped: 0,
		failed: 0
	};
}

function batchResult(
	overrides: Partial<OpportunityProcessingResult>,
	opts: { exhausted: boolean; failedRawMessageIds?: string[] }
): OpportunityProcessingBatchResult {
	return {
		result: { ...emptyResult('acct-1'), ...overrides },
		failedRawMessageIds: opts.failedRawMessageIds ?? [],
		exhausted: opts.exhausted
	};
}

const logService = { logAction: jest.fn() } as unknown as LogService;

describe('processOpportunitiesInBatches', () => {
	it('aggregates counters across batches and stops when exhausted', async () => {
		const { step, calls } = makeStep();
		const processBatch = jest
			.fn<OpportunitiesService['processBatch']>()
			.mockResolvedValueOnce(
				batchResult({ scanned: 25, classifiedPositive: 20, opportunitiesCreated: 20 }, { exhausted: false })
			)
			.mockResolvedValueOnce(
				batchResult(
					{ scanned: 25, classifiedPositive: 10, classifiedNegative: 15, opportunitiesCreated: 10 },
					{ exhausted: false }
				)
			)
			.mockResolvedValueOnce(
				batchResult(
					{ scanned: 7, classifiedPositive: 3, classifiedNegative: 4, opportunitiesCreated: 3 },
					{ exhausted: true }
				)
			);

		const aggregate = await processOpportunitiesInBatches({
			step,
			opportunities: { processBatch } as unknown as OpportunitiesService,
			logService,
			emailAccountId: 'acct-1',
			stepNamePrefix: 'test-batch',
			logContext: 'TestFn',
			correlation: { requestId: 'test-run' }
		});

		expect(processBatch).toHaveBeenCalledTimes(3);
		expect(calls).toEqual(['test-batch-0', 'test-batch-1', 'test-batch-2']);
		expect(aggregate).toMatchObject({
			emailAccountId: 'acct-1',
			scanned: 57,
			classifiedPositive: 33,
			classifiedNegative: 19,
			opportunitiesCreated: 33
		});
	});

	it('forwards failedRawMessageIds back into the next batch as excludedIds', async () => {
		const { step } = makeStep();
		const processBatch = jest
			.fn<OpportunitiesService['processBatch']>()
			.mockResolvedValueOnce(
				batchResult({ scanned: 1, failed: 1 }, { exhausted: false, failedRawMessageIds: ['raw-1'] })
			)
			.mockResolvedValueOnce(batchResult({ scanned: 0 }, { exhausted: true }));

		await processOpportunitiesInBatches({
			step,
			opportunities: { processBatch } as unknown as OpportunitiesService,
			logService,
			emailAccountId: 'acct-1',
			stepNamePrefix: 'test-batch',
			logContext: 'TestFn',
			correlation: { requestId: 'test-run' }
		});

		expect(processBatch).toHaveBeenNthCalledWith(1, 'acct-1', []);
		expect(processBatch).toHaveBeenNthCalledWith(2, 'acct-1', ['raw-1']);
	});

	it('bails after PROCESS_MAX_BATCHES_PER_RUN and warns rather than looping forever', async () => {
		const { step } = makeStep();
		// Always-have-more-work batch — would loop forever without the cap.
		const processBatch = jest
			.fn<OpportunitiesService['processBatch']>()
			.mockResolvedValue(batchResult({ scanned: 25 }, { exhausted: false }));
		const warnLogger = { logAction: jest.fn() } as unknown as LogService;

		const aggregate = await processOpportunitiesInBatches({
			step,
			opportunities: { processBatch } as unknown as OpportunitiesService,
			logService: warnLogger,
			emailAccountId: 'acct-1',
			stepNamePrefix: 'test-batch',
			logContext: 'TestFn',
			correlation: { requestId: 'test-run' }
		});

		expect(processBatch).toHaveBeenCalledTimes(PROCESS_MAX_BATCHES_PER_RUN);
		expect(aggregate.scanned).toBe(25 * PROCESS_MAX_BATCHES_PER_RUN);

		const warnCall = (warnLogger.logAction as jest.Mock).mock.calls.find(
			([arg]) => (arg as { action: string }).action === 'opportunity.pipeline.batch_cap_reached'
		);
		expect(warnCall).toBeDefined();
	});
});
