import { MicrosoftBackfillService } from '@/modules/microsoft/microsoft-backfill.service';
import { inngest } from '@/modules/inngest/inngest.client';
import { InngestEvents, InngestFunctionIds, InngestSteps } from '@/modules/inngest/inngest.constants';
import { Injectable, Logger } from '@nestjs/common';
import type { InngestFunction } from 'inngest';

interface MicrosoftAccountConnectedData {
	emailAccountId: string;
}

/**
 * Inngest function wrapper around `MicrosoftBackfillService`. Mirrors `GmailBackfillFunction`
 * shape — `@Injectable()` so it receives `MicrosoftBackfillService` from DI; `main.ts`
 * resolves the class after `NestFactory.create()` and adds `.inngestFn` to the array
 * passed to `inngestServe()`.
 */
@Injectable()
export class MicrosoftBackfillFunction {
	readonly inngestFn: InngestFunction.Any;
	private readonly logger = new Logger('InngestFn:microsoft-backfill');

	constructor(private readonly backfill: MicrosoftBackfillService) {
		this.inngestFn = inngest.createFunction(
			{
				id: InngestFunctionIds.MicrosoftBackfill,
				name: 'Microsoft Graph backfill (last 90 days)',
				triggers: [{ event: InngestEvents.MicrosoftAccountConnected }],
				retries: 3
			},
			async ({ event, step }) => {
				const data = event.data as MicrosoftAccountConnectedData;
				if (!data?.emailAccountId) {
					this.logger.warn(`Missing emailAccountId in event: ${JSON.stringify(event.data)}`);
					return { skipped: true };
				}

				const result = await step.run(InngestSteps.MicrosoftBackfill.Backfill, () =>
					this.backfill.run(data.emailAccountId)
				);
				return result;
			}
		);
	}
}
