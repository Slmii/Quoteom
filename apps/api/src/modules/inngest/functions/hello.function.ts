import { inngest } from '@/modules/inngest/inngest.client';
import { Logger } from '@nestjs/common';
import type { InngestFunction } from 'inngest';

const logger = new Logger('InngestFn:hello');

/**
 * W3.3 smoke function — event-triggered, runs once per event.
 *
 * Send the trigger from the Inngest dev UI (http://localhost:8288 → New event):
 *   { "name": "test/hello", "data": { "name": "Quoteom" } }
 *
 * Proves: function discovery via `/api/inngest`, event delivery, return-value capture in
 * the UI. Used as the end-to-end heartbeat in W3.3's manual smoke (TEST_CASES).
 *
 * Type annotation: `InngestFunction.Any`. The SDK's inferred return type pulls in a deep
 * internal path that `declaration: true` builds can't serialize portably.
 */
export const helloFn: InngestFunction.Any = inngest.createFunction(
	{
		id: 'hello',
		name: 'Hello (smoke)',
		triggers: [{ event: 'test/hello' }]
	},
	async ({ event, step }) => {
		const recipient = (event.data as { name?: string }).name ?? 'world';
		// Wrap in step.run so the return value is captured + replayable in the UI.
		const greeting = await step.run('compose-greeting', () => `Hello, ${recipient}!`);
		logger.log(`hello fn fired: ${greeting}`);
		return { greeting };
	}
);
