import { processOpportunitiesInBatches } from '@/modules/inngest/functions/process-opportunities-in-batches';
import { inngest } from '@/modules/inngest/inngest.client';
import type { InngestEventName } from '@/modules/inngest/inngest.constants';
// Imported under an alias to avoid colliding with the config field `logContext` below
// (which is a *string* identifier — the named context for logger output, not the ALS).
import { logContext as requestContext } from '@/modules/logger/log-context';
import type { LogService } from '@/modules/logger/log.service';
import type { OpportunitiesService } from '@/modules/opportunities/opportunities.service';
import type { InngestFunction } from 'inngest';

/**
 * Inngest's `createFunction` first-arg type, derived from the SDK directly. Inngest
 * narrows fields like `retries` (literal union 0…20) and `debounce.period` (template
 * literal like `${number}s`), so a hand-rolled local type is always too wide.
 */
type InngestFunctionOptions = NonNullable<Parameters<typeof inngest.createFunction>[0]>;

/**
 * Shared shape of every mailbox-triggered pipeline function: backfill or delta-sync,
 * Gmail or Microsoft. Four call sites that all do the same dance:
 *
 *   1. validate the inbound `emailAccountId` in the event payload (guard against bad senders)
 *   2. `step.run(sync)` — provider-specific work (fetch + persist RawMessage rows)
 *   3. process pending RawMessages → Opportunities, chunked across resumable steps
 *   4. (optional) `step.run(postSync)` — start a watch / subscription after backfill
 *
 * Each step is independently retryable; an Inngest retry on (3) or (4) doesn't re-run
 * (2)'s expensive provider walk.
 */

export interface MailboxPipelineFunctionConfig<TSyncResult> {
	/** Inngest function id (kebab-case slug — appears in URLs/dev-UI). */
	functionId: string;
	/** Human-readable name in the dev UI. */
	functionName: string;
	/** Event name that triggers this function. */
	triggerEvent: InngestEventName;
	/** Number of retries Inngest grants on step failure. Inngest caps this at 20. */
	retries: NonNullable<InngestFunctionOptions['retries']>;
	/** Optional per-mailbox concurrency limit (use on delta-sync; not on backfill). */
	concurrency?: InngestFunctionOptions['concurrency'];
	/** Optional debounce window (use on delta-sync to coalesce push bursts). */
	debounce?: InngestFunctionOptions['debounce'];
	/** Inngest step name for the provider sync work. */
	syncStepName: string;
	/** The provider-specific sync — Gmail/Graph backfill or delta walk. */
	runSync: (emailAccountId: string) => Promise<TSyncResult>;
	/** Inngest step-name prefix for the per-batch opportunities-processing checkpoints. */
	processOpportunitiesStepPrefix: string;
	opportunities: OpportunitiesService;
	logService: LogService;
	/** Used for log `context` field on completion / warn logs. */
	logContext: string;
	/**
	 * Optional post-processing step. Used by backfill to start the Pub/Sub watch
	 * (Gmail) or Graph subscription (Microsoft) once the initial fetch + classification
	 * is done. Delta-sync omits this.
	 *
	 * Errors are swallowed + logged via `LogService` so a watch/subscription failure
	 * doesn't re-trigger the (expensive, idempotent-but-slow) sync step on retry. The
	 * renewal cron picks up orphans nightly.
	 */
	postSyncStep?: {
		stepName: string;
		run: (emailAccountId: string) => Promise<unknown>;
		failureAction: string;
		failureMessage: (emailAccountId: string) => string;
	};
}

export function defineMailboxPipelineFunction<TSyncResult>(
	config: MailboxPipelineFunctionConfig<TSyncResult>
): InngestFunction.Any {
	// Build the options inline so TypeScript infers against Inngest's generic
	// `createFunction` signature directly — a hand-rolled local type strips away
	// optional fields the SDK expects and triggers an assignability error.
	return inngest.createFunction(
		{
			id: config.functionId,
			name: config.functionName,
			triggers: [{ event: config.triggerEvent }],
			retries: config.retries,
			...(config.concurrency ? { concurrency: config.concurrency } : {}),
			...(config.debounce ? { debounce: config.debounce } : {})
		},
		async ({ event, step, runId }) => {
			const data = event.data as { emailAccountId?: unknown; organizationId?: unknown } | undefined;
			const emailAccountId = typeof data?.emailAccountId === 'string' ? data.emailAccountId : null;

			if (!emailAccountId) {
				config.logService.logAction({
					action: 'inngest.event.invalid_payload',
					message: `${config.triggerEvent} event missing emailAccountId`,
					metadata: { event: config.triggerEvent, payload: event.data },
					level: 'warn',
					context: config.logContext
				});
				return { skipped: true };
			}

			// Prefer organizationId from the event payload (every emit site now includes
			// it). Fall back to a DB lookup so legacy events without the field still work,
			// and so a forgotten emit site is non-fatal — we just lose correlation for it.
			const payloadOrgId = typeof data?.organizationId === 'string' ? data.organizationId : null;
			const organizationId =
				payloadOrgId ?? (await config.opportunities.resolveOrganizationIdForEmailAccount(emailAccountId));

			if (!organizationId) {
				config.logService.logAction({
					action: 'inngest.event.unknown_email_account',
					message: `${config.triggerEvent}: emailAccount ${emailAccountId} not found; AICall correlation will be NULL`,
					metadata: { event: config.triggerEvent, emailAccountId },
					level: 'warn',
					context: config.logContext
				});
			}

			// Correlation that every `step.run` callback re-establishes via `logContext.run`
			// just-before-actual-work. This is load-bearing: Inngest schedules step callbacks
			// on a different async chain than the function body, so an outer `logContext.run`
			// wrapping the whole handler doesn't propagate across the step boundary — we
			// have to set it INSIDE each callback. `runId` is from Inngest's `BaseContext`
			// (the dev-UI Run ID); `organizationId` comes from the event payload (preferred)
			// or a DB lookup fallback.
			const correlation: { requestId: string; organizationId?: string } = {
				requestId: runId,
				...(organizationId ? { organizationId } : {})
			};

			const syncResult = await step.run(config.syncStepName, () =>
				requestContext.run(correlation, () => config.runSync(emailAccountId))
			);

			await processOpportunitiesInBatches({
				step,
				opportunities: config.opportunities,
				logService: config.logService,
				emailAccountId,
				stepNamePrefix: config.processOpportunitiesStepPrefix,
				logContext: config.logContext,
				correlation
			});

			if (config.postSyncStep) {
				await step.run(config.postSyncStep.stepName, () =>
					requestContext.run(correlation, async () => {
						try {
							await config.postSyncStep!.run(emailAccountId);
						} catch (error) {
							config.logService.logAction({
								action: config.postSyncStep!.failureAction,
								message: `${config.postSyncStep!.failureMessage(emailAccountId)}: ${error instanceof Error ? error.message : 'unknown'}`,
								metadata: { emailAccountId },
								level: 'error',
								stack: error instanceof Error ? error.stack : undefined,
								context: config.logContext
							});
						}

						return { ok: true };
					})
				);
			}

			return syncResult;
		}
	);
}
