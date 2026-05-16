import { z } from 'zod';

/**
 * Input to `ClassifierService.classify()`. Plain-text shape — deliberately decoupled from
 * `RawMessage` so the classifier can run on synthetic fixtures (today's tests), W4.4's
 * RawMessage-derived production calls (later), or any future channel like WhatsApp
 * (W6.4). Caller is responsible for extracting plain text from the provider payload.
 */
export interface ClassifierInput {
	subject: string | null;
	fromName: string | null;
	fromEmail: string | null;
	/**
	 * Plain text body, HTML already stripped by the caller. Keep ≤ ~4kB to stay within
	 * the cheap-model context budget. Anything longer should be truncated by the caller —
	 * the classifier doesn't need the full thread, just enough to make a yes/no decision.
	 */
	bodyText: string;
}

/**
 * Zod schema for the model's structured response. Used both to (a) tell OpenAI what shape
 * to produce via `text.format: zodTextFormat(...)`, and (b) validate the response on the
 * way back. Mismatch surfaces as `AISchemaInvalidError` from the wrapper.
 *
 * - `isQuote`: the binary decision the caller cares about.
 * - `confidence`: model's self-reported confidence 0-1. Useful for filtering: at confidence
 *   < 0.5 the caller may want to flag for manual review rather than auto-create an
 *   Opportunity in W4.4.
 * - `reason`: one short user-facing sentence in the email's language explaining the
 *   decision. Persisted on the AICall row for debugging. Field name is deliberately
 *   `reason`, not `reasoning` — we don't want chain-of-thought; we want one explanation.
 */
export const ClassifierResultSchema = z.object({
	isQuote: z.boolean(),
	confidence: z.number().min(0).max(1),
	reason: z.string()
});

export type ClassifierResult = z.infer<typeof ClassifierResultSchema>;
