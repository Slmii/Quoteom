import { GmailWatchService } from '@/modules/gmail/gmail-watch.service';
import { inngest } from '@/modules/inngest/inngest.client';
import { InngestFunctionIds, InngestSteps } from '@/modules/inngest/inngest.constants';
import { Injectable } from '@nestjs/common';
import type { InngestFunction } from 'inngest';

/**
 * Daily cron — re-watches any Gmail mailbox whose 7-day Pub/Sub watch is within 24 h of
 * expiry. Wraps `GmailWatchService.renewExpiringWatches()` which does the actual work.
 *
 * Cron `0 6 * * *` (06:00 UTC daily): early enough to catch overnight expiries, late
 * enough to avoid colliding with the weekly-digest cron we'll add in W7.3.
 *
 * If `GOOGLE_PUBSUB_TOPIC` isn't configured (typical dev), `renewExpiringWatches()` no-ops
 * with a structured log instead of throwing — keeps the cron registration valid without
 * forcing every dev to provision a GCP topic.
 */
@Injectable()
export class GmailWatchRenewalFunction {
	readonly inngestFn: InngestFunction.Any;

	constructor(private readonly watch: GmailWatchService) {
		this.inngestFn = inngest.createFunction(
			{
				id: InngestFunctionIds.GmailWatchRenewal,
				name: 'Gmail watch renewal (daily)',
				triggers: [{ cron: '0 6 * * *' }],
				retries: 3
			},
			async ({ step }) => {
				const result = await step.run(InngestSteps.GmailWatchRenewal.Renew, () =>
					this.watch.renewExpiringWatches()
				);
				return result;
			}
		);
	}
}
