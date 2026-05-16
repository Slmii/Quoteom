import { AI_CLIENT, type AIClient } from '@/modules/ai/clients/ai-client.interface';
import {
	ClassifierResultSchema,
	type ClassifierInput,
	type ClassifierResult
} from '@/modules/ai/classifier/classifier.types';
import { buildClassifierPromptNL } from '@/modules/ai/classifier/prompts/nl';
import { Inject, Injectable } from '@nestjs/common';

/**
 * W4.2 — decides whether an inbound email is an offerteaanvraag (quote request).
 *
 * Internal service: no controller, no DTO. Consumed by W4.4's Opportunity creation flow,
 * which calls `classify()` on every new `RawMessage` and materializes an `Opportunity`
 * row only when `isQuote === true`. Negative classifications stay in `RawMessage` as the
 * archive (per [[project-horizontal-positioning]] — full corpus retained for re-classification
 * when prompt v2 ships).
 *
 * **Language routing (W4.2 → W4.3+):** today the only prompt is `buildClassifierPromptNL`.
 * When `Organization.locale` lands (D21), `classify()` will route to the matching prompt
 * builder. The classifier output stays language-agnostic — `isQuote` is a boolean, `reason`
 * is in whatever language the prompt was written in.
 */
@Injectable()
export class ClassifierService {
	constructor(@Inject(AI_CLIENT) private readonly ai: AIClient) {}

	async classify(input: ClassifierInput): Promise<ClassifierResult> {
		const prompt = buildClassifierPromptNL(input);
		return this.ai.generate({
			purpose: 'classifier',
			prompt,
			schema: ClassifierResultSchema,
			// Low temperature so repeated runs of the same email give the same classification
			// — important for the accuracy harness reproducibility, and for "did this email
			// flip categories overnight?" debugging in prod.
			temperature: 0
		});
	}
}
