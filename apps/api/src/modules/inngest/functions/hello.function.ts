import { inngest } from '@/modules/inngest/inngest.client';
import { InngestFunctionIds, InngestSteps } from '@/modules/inngest/inngest.constants';
import { Logger } from '@nestjs/common';
import type { InngestFunction } from 'inngest';

const logger = new Logger('InngestFn:hello');

/**
 * W3.3 smoke function — event-triggered, runs once per event.
 *
 * Send the trigger from the Inngest dev UI (http://localhost:8288 → New event):
 *   { "name": "test/hello", "data": { "name": "Quoteom" } }
 *
 * The `test/hello` event name is intentionally a literal — it's a developer-only smoke,
 * not a real domain event. Promote to `InngestEvents` if app code ever fires it.
 *
 * Type annotation: `InngestFunction.Any`. The SDK's inferred return type pulls in a deep
 * internal path that `declaration: true` builds can't serialize portably.
 */
export const helloFn: InngestFunction.Any = inngest.createFunction(
	{
		id: InngestFunctionIds.Hello,
		name: 'Hello (smoke)',
		triggers: [{ event: 'test/hello' }]
	},
	async ({ event, step }) => {
		const recipient = (event.data as { name?: string }).name ?? 'world';
		// Wrap in step.run so the return value is captured + replayable in the UI.
		const greeting = await step.run(InngestSteps.Hello.ComposeGreeting, () => `Hello, ${recipient}!`);
		logger.log(`hello fn fired: ${greeting}`);
		return { greeting };
	}
);
