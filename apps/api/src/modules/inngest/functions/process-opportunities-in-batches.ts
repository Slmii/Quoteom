import { logContext as requestContext } from '@/modules/logger/log-context';
import type { LogService } from '@/modules/logger/log.service';
import type { OpportunitiesService } from '@/modules/opportunities/opportunities.service';
import {
	PROCESS_MAX_BATCHES_PER_RUN,
	type OpportunityProcessingBatchResult,
	type OpportunityProcessingResult
} from '@/modules/opportunities/opportunities.types';

/**
 * Run the opportunities pipeline for an `EmailAccount` across as many Inngest `step.run`
 * checkpoints as needed to exhaust the backlog. Each batch is its own resumable step so:
 *
 *  - Inngest's per-step 5-minute timeout caps work per checkpoint, not per function run.
 *  - A transient failure mid-pipeline retries only the failing batch, not the whole pass.
 *  - The dev UI shows individual batch outcomes, useful when chasing a misbehaving fixture.
 *
 * Shape mirrors `OpportunitiesService.processRawMessagesForAccount` but routed through
 * `step.run`. Returns the aggregated counters so callers (the Inngest function bodies)
 * can return them for run-history visibility.
 */
export interface ProcessOpportunitiesInBatchesArgs {
	step: { run<T>(name: string, handler: () => Promise<T>): Promise<T> };
	opportunities: OpportunitiesService;
	logService: LogService;
	emailAccountId: string;
	/** Inngest step-name prefix; each batch gets `${stepNamePrefix}-${i}`. */
	stepNamePrefix: string;
	/** Logger context (e.g. `'InngestFn:gmail-backfill'`) used for completion + warn logs. */
	logContext: string;
	/**
	 * ALS correlation pushed inside every `step.run` callback so `AICall` + `Log` rows
	 * written by the classifier/extractor/repository inherit them. Re-establishing the ALS
	 * context here (instead of relying on the caller's outer wrap) is load-bearing: Inngest
	 * schedules step callbacks on a different async chain than the function body, so the
	 * outer ALS frame doesn't propagate across the `step.run` boundary on its own.
	 */
	correlation: { requestId: string; organizationId?: string };
}

export async function processOpportunitiesInBatches(
	args: ProcessOpportunitiesInBatchesArgs
): Promise<OpportunityProcessingResult> {
	const aggregate: OpportunityProcessingResult = {
		emailAccountId: args.emailAccountId,
		scanned: 0,
		classifiedPositive: 0,
		classifiedNegative: 0,
		opportunitiesCreated: 0,
		opportunitiesSkipped: 0,
		failed: 0
	};
	const excluded = new Set<string>();

	for (let batchIndex = 0; batchIndex < PROCESS_MAX_BATCHES_PER_RUN; batchIndex++) {
		const batch: OpportunityProcessingBatchResult = await args.step.run(
			`${args.stepNamePrefix}-${batchIndex}`,
			() =>
				requestContext.run(
					{
						requestId: args.correlation.requestId,
						...(args.correlation.organizationId ? { organizationId: args.correlation.organizationId } : {})
					},
					() => args.opportunities.processBatch(args.emailAccountId, [...excluded])
				)
		);

		aggregate.scanned += batch.result.scanned;
		aggregate.classifiedPositive += batch.result.classifiedPositive;
		aggregate.classifiedNegative += batch.result.classifiedNegative;
		aggregate.opportunitiesCreated += batch.result.opportunitiesCreated;
		aggregate.opportunitiesSkipped += batch.result.opportunitiesSkipped;
		aggregate.failed += batch.result.failed;

		for (const id of batch.failedRawMessageIds) {
			excluded.add(id);
		}

		if (batch.exhausted) {
			args.logService.logAction({
				action: 'opportunity.pipeline.completed',
				message: `Opportunity pipeline processed ${aggregate.scanned} raw messages for ${args.emailAccountId}`,
				metadata: { ...aggregate, batches: batchIndex + 1 },
				context: args.logContext
			});
			return aggregate;
		}
	}

	// Hit the safety cap without exhausting the queue. Log a warning — the next sync run
	// will pick up the remainder. This shouldn't happen in practice for SMB mailboxes
	// (PROCESS_BATCH_SIZE × PROCESS_MAX_BATCHES_PER_RUN = 5,000 RawMessages per pass).
	args.logService.logAction({
		action: 'opportunity.pipeline.batch_cap_reached',
		message: `Opportunity pipeline hit the per-run batch cap for ${args.emailAccountId} after ${PROCESS_MAX_BATCHES_PER_RUN} batches`,
		metadata: { ...aggregate, batches: PROCESS_MAX_BATCHES_PER_RUN },
		level: 'warn',
		context: args.logContext
	});

	return aggregate;
}
