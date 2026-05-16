import { AI_CLIENT } from '@/modules/ai/clients/ai-client.interface';
import { OpenAIClient } from '@/modules/ai/clients/openai-client.service';
import { ClassifierService } from '@/modules/ai/classifier/classifier.service';
import { AICallLogger } from '@/modules/ai/logging/ai-call-logger.service';
import { Module } from '@nestjs/common';

/**
 * W4.1+W4.2 — AI extraction pipeline.
 *
 * Surface:
 *  - `AI_CLIENT` token bound to a concrete `AIClient` implementation (today: `OpenAIClient`,
 *    swappable later for Mistral/Anthropic in the W5.1 spike).
 *  - `AICallLogger` — exported so non-AI services can also log calls if they fire LLMs
 *    via custom paths (none today; future-proofing).
 *  - `ClassifierService` (W4.2) — "is this an offerteaanvraag?" decision. Consumed by W4.4's
 *    Opportunity creation flow once that ships.
 *
 * Downstream consumers (`ClassifierService`, `ExtractorService` in W4.3, etc.) inject the
 * AI client via `@Inject(AI_CLIENT) private readonly ai: AIClient`. They don't know or
 * care which provider sits behind it.
 *
 * Provider lock-in (W5.1) is mechanical: swap `useClass: OpenAIClient` for `useClass:
 * MistralClient` or `useClass: AnthropicClient`. Caller code doesn't change.
 */
@Module({
	providers: [
		AICallLogger,
		OpenAIClient,
		{
			provide: AI_CLIENT,
			useExisting: OpenAIClient
		},
		ClassifierService
	],
	exports: [AI_CLIENT, AICallLogger, ClassifierService]
})
export class AiModule {}
