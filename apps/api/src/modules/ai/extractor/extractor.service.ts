import { AI_CLIENT, type AIClient } from '@/modules/ai/clients/ai-client.interface';
import {
	ExtractorResultSchema,
	type ExtractorInput,
	type ExtractorResult
} from '@/modules/ai/extractor/extractor.types';
import { buildExtractorPromptNL } from '@/modules/ai/extractor/prompts/nl';
import { Inject, Injectable } from '@nestjs/common';

/**
 * W4.3 — pulls structured fields out of a classified-positive offerteaanvraag.
 *
 * Internal service: no controller, no DTO. Consumed by W4.4's Opportunity creation flow,
 * which calls `extract()` only when `ClassifierService.classify()` returned `isQuote: true`.
 * Output populates the new `Opportunity` row's customer + scope columns.
 *
 * **Why a separate service from the classifier:** the two are coupled in production (you
 * always classify before extracting) but they have different cost profiles (extractor is
 * lower-volume + higher-quality model) and different failure modes (classifier's hard
 * failure is "false negative on a real quote"; extractor's hard failure is "wrong customer
 * data on an Opportunity row"). Separate services + separate fixtures + separate accuracy
 * targets lets us iterate on each independently.
 *
 * **referenceDateIso** is the time anchor for relative-date resolution. In production this
 * should be the email's received timestamp (so replays over `AICall` rows give stable
 * results); in W4.4 the caller passes `rawMessage.internalDate.toISOString().slice(0, 10)`.
 * The harness today uses a fixed reference so the accuracy assertions are deterministic
 * regardless of when the test runs.
 *
 * **Language routing (D21):** today only `buildExtractorPromptNL` exists. When
 * `Organization.locale` lands, `extract()` will route to the matching prompt builder.
 */
@Injectable()
export class ExtractorService {
	constructor(@Inject(AI_CLIENT) private readonly ai: AIClient) {}

	async extract(input: ExtractorInput, referenceDateIso: string): Promise<ExtractorResult> {
		const prompt = buildExtractorPromptNL(input, referenceDateIso);
		return this.ai.generate({
			purpose: 'extractor',
			prompt,
			schema: ExtractorResultSchema,
			// Same as classifier: low temperature for reproducibility. The extractor has
			// more degrees of freedom (multiple text fields) so any non-zero temperature
			// would make per-fixture accuracy assertions flap.
			temperature: 0
		});
	}
}
