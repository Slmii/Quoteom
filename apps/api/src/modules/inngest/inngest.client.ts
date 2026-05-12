import { Inngest } from 'inngest';

/**
 * Singleton Inngest client. Imported by every function definition AND by the `serve()`
 * handler mounted at /api/inngest in main.ts.
 *
 * `id` identifies this app in the Inngest UI / cloud dashboard. Keep it stable — changing
 * it later orphans existing runs.
 *
 * **Auth in dev:** the Inngest dev server (`npx inngest-cli@latest dev`) handles the
 * localhost handshake automatically, so no keys are needed. Production reads
 * INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY from env via main.ts's `serve()` call.
 */
export const inngest = new Inngest({
	id: 'quoteom-api'
});
