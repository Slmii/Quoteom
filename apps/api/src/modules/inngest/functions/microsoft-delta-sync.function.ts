import { defineMailboxPipelineFunction } from '@/modules/inngest/functions/define-mailbox-pipeline-function';
import { InngestEvents, InngestFunctionIds, InngestSteps } from '@/modules/inngest/inngest.constants';
import { LogService } from '@/modules/logger/log.service';
import { MicrosoftDeltaSyncService } from '@/modules/microsoft/microsoft-delta-sync.service';
import { OpportunitiesService } from '@/modules/opportunities/opportunities.service';
import { Injectable } from '@nestjs/common';
import type { InngestFunction } from 'inngest';

/**
 * Microsoft delta-sync mirror of `GmailDeltaSyncFunction`: triggered by
 * `microsoft/delta.changed` (W3.6 webhook), walks `/me/messages/delta` from the stored
 * cursor, persists new RawMessage rows, then processes them. Same per-mailbox
 * concurrency-1 + debounce as Gmail to coalesce push bursts.
 */
@Injectable()
export class MicrosoftDeltaSyncFunction {
	readonly inngestFn: InngestFunction.Any;

	constructor(deltaSync: MicrosoftDeltaSyncService, opportunities: OpportunitiesService, logService: LogService) {
		this.inngestFn = defineMailboxPipelineFunction({
			functionId: InngestFunctionIds.MicrosoftDeltaSync,
			functionName: 'Microsoft delta sync (push notification)',
			triggerEvent: InngestEvents.MicrosoftDeltaChanged,
			retries: 3,
			concurrency: { limit: 1, key: 'event.data.emailAccountId' },
			debounce: { period: '2s', key: 'event.data.emailAccountId' },
			syncStepName: InngestSteps.MicrosoftDeltaSync.Sync,
			runSync: emailAccountId => deltaSync.run(emailAccountId),
			processOpportunitiesStepPrefix: InngestSteps.MicrosoftDeltaSync.ProcessOpportunitiesBatch,
			opportunities,
			logService,
			logContext: 'InngestFn:microsoft-delta-sync'
		});
	}
}
