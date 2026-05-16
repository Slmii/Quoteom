import { z } from 'zod';

/**
 * Input to `ExtractorService.extract()`. Same shape as `ClassifierInput` — deliberately
 * parallel so a caller can pipe a classified-positive directly into the extractor without
 * shape transformation.
 */
export interface ExtractorInput {
	subject: string | null;
	fromName: string | null;
	fromEmail: string | null;
	/** Plain text body, HTML stripped. Kept ≤ ~6kB — extractor needs more context than the
	 *  classifier (it's pulling specific fields like address + deliverables out of the email)
	 *  but unbounded inputs blow up cost on long forwarded threads. */
	bodyText: string;
}

/**
 * Urgency enum — driven by the customer's signaled time pressure, not our internal SLA.
 *  - `emergency`: water leak, no heat in winter, broken essential system, "spoed"
 *  - `high`: explicit short-window deadline (this week, before Friday)
 *  - `normal`: stated multi-week deadline, no time pressure language
 *  - `low`: explicitly "no rush", "geen haast", or quote-shopping with no date
 */
export const UrgencyEnum = z.enum(['emergency', 'high', 'normal', 'low']);
export type Urgency = z.infer<typeof UrgencyEnum>;

/**
 * Cap on `deliverableHints` array length. Long forwarded emails or detailed RFPs can
 * yield 30+ "hints" — most of which are just incidental nouns, not actual deliverables.
 * Forcing a cap keeps the array signal-dense.
 */
const DELIVERABLE_HINTS_CAP = 10;

/**
 * Zod schema for the extractor output. Enforced server-side by OpenAI's Responses API
 * via `zodTextFormat(...)`; the model is constrained to produce schema-matching JSON.
 *
 * Field semantics:
 *  - `customerName`: best-guess name (sender display name if available, else parsed from
 *    signature block, else null). Preserve capitalization the email used.
 *  - `customerEmail`: lowercase email. Null only if no email is detectable anywhere in
 *    the email (rare — the `From` header is usually present).
 *  - `address`: free-form, preserves whatever level of detail the email gave ("Utrecht-
 *    Noord", "Amsterdam De Pijp", a full street address, etc.). Null when no address
 *    hint at all.
 *  - `requestType`: one short noun-phrase describing the work ("CV-ketel vervangen",
 *    "Bruiloftsfotografie", "Migratie naar Microsoft 365"). The extractor's job is to
 *    summarize, not paraphrase verbatim.
 *  - `urgency`: enum, see above.
 *  - `customerDeadline`: ISO date string (YYYY-MM-DD) for the project / delivery /
 *    completion deadline. Null when no project-completion date is derivable. Inspection
 *    or visit dates do NOT go here — see `customerAppointment`.
 *  - `customerAppointment`: ISO date string (YYYY-MM-DD) for a customer-proposed
 *    inspection / opname / visit / overleg appointment. Distinct from `customerDeadline`
 *    so the UI can show "customer wants you to visit on X" separately from "customer
 *    wants the work done by Y." Null when no appointment date is proposed.
 *  - `deliverableHints`: short list of mentioned deliverables ("dakkapel", "funderings-
 *    platen", "houten vlonder ~40 m²"). Capped to keep arrays signal-dense.
 */
export const ExtractorResultSchema = z.object({
	customerName: z.string().nullable(),
	customerEmail: z.string().nullable(),
	address: z.string().nullable(),
	requestType: z.string(),
	urgency: UrgencyEnum,
	customerDeadline: z.string().nullable(),
	customerAppointment: z.string().nullable(),
	deliverableHints: z.array(z.string()).max(DELIVERABLE_HINTS_CAP)
});

export type ExtractorResult = z.infer<typeof ExtractorResultSchema>;
