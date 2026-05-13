/**
 * Single source of truth for every Inngest "magic string" the app uses: event names
 * (in `inngest.send` + function `triggers:`), function ids (used by the dev UI and
 * Inngest's internal routing), and step names (passed to `step.run()` for durable
 * checkpointing and dev-UI display).
 *
 * Rules:
 *  - Add new strings here BEFORE referencing them in code. A typo in one place + a
 *    matching typo in another silently breaks the trigger; centralizing forces both
 *    sides to refer to the same constant.
 *  - Event names use Inngest's recommended `domain/action.qualifier` format.
 *  - Function ids are short kebab-case slugs; they appear in URLs in the dev UI.
 *  - Step names are short kebab-case strings, scoped under their owning function.
 *
 * Pattern mirrors `billing.constants.ts` / `gmail.constants.ts` — flat, grouped by
 * concern, `as const` for literal-type narrowing at call sites.
 */

export const InngestEvents = {
	/** Fired by `EmailAccountsService.upsertEmailAccount` after a successful Gmail OAuth handshake. */
	GmailAccountConnected: 'gmail/account.connected',
	/** Fired by `EmailAccountsService.upsertEmailAccount` after a successful Microsoft OAuth handshake. */
	MicrosoftAccountConnected: 'microsoft/account.connected'
} as const;

export type InngestEventName = (typeof InngestEvents)[keyof typeof InngestEvents];

export const InngestFunctionIds = {
	/** W3.3 smoke — event-triggered (`test/hello`). */
	Hello: 'hello',
	/** W3.3 smoke — cron-scheduled `0 * * * *`. */
	Heartbeat: 'heartbeat',
	/** W3.4 backfill — fetches last 90 days into `RawMessage` on `GmailAccountConnected`. */
	GmailBackfill: 'gmail-backfill',
	/** W3.2 backfill — same shape as Gmail's, against Microsoft Graph. */
	MicrosoftBackfill: 'microsoft-backfill'
} as const;

/**
 * Step names grouped under their owning function. The grouping prevents accidental
 * collisions (two functions can both have a `fetch-page` step without ambiguity) and
 * makes the dev-UI run timeline scannable.
 */
export const InngestSteps = {
	Hello: {
		ComposeGreeting: 'compose-greeting'
	},
	Heartbeat: {
		RecordTick: 'record-tick'
	},
	GmailBackfill: {
		/** The whole 90-day fetch + persist loop. One step today; split later if it timeouts. */
		Backfill: 'backfill'
	},
	MicrosoftBackfill: {
		Backfill: 'backfill'
	}
} as const;
