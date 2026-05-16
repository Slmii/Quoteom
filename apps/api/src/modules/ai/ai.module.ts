import { AI_CLIENT } from '@/modules/ai/clients/ai-client.interface';
import { OpenAIClient } from '@/modules/ai/clients/openai-client.service';
import { AICallLogger } from '@/modules/ai/logging/ai-call-logger.service';
import { Module } from '@nestjs/common';

/**
 * W4.1 — AI extraction pipeline foundation.
 *
 * Surface:
 *  - `AI_CLIENT` token bound to a concrete `AIClient` implementation (today: `OpenAIClient`,
 *    swappable later for Mistral/Anthropic in the W5.1 spike).
 *  - `AICallLogger` — exported so non-AI services can also log calls if they fire LLMs
 *    via custom paths (none today; future-proofing).
 *
 * Downstream consumers (`ClassifierService` in W4.2, `ExtractorService` in W4.3, etc.)
 * inject the interface via `@Inject(AI_CLIENT) private readonly ai: AIClient`. They don't
 * know or care which provider sits behind it.
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
		}
	],
	exports: [AI_CLIENT, AICallLogger]
})
export class AiModule {}
