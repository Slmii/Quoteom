import type { EnvSchema } from '@/config/env.schema';
import {
	AINotConfiguredError,
	AIProviderError,
	AISchemaInvalidError,
	type AIClient,
	type AIGenerateRequest,
	type AIGenerateResult
} from '@/modules/ai/clients/ai-client.interface';
import { AICallLogger } from '@/modules/ai/logging/ai-call-logger.service';
import { LogService } from '@/modules/logger/log.service';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { APIError, AzureOpenAI } from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';

/**
 * Default purpose → model mapping. Caller can override per-call via `request.model`.
 *  - `classifier`: cheap + fast model, runs on every incoming email
 *  - `extractor`: higher-quality model, runs only on classifier positives
 *  - default fallback: same as extractor (safer not cheaper when purpose is unknown)
 */
function defaultModelFor(purpose: string, config: ConfigService<EnvSchema, true>): string {
	switch (purpose) {
		case 'classifier':
			return config.get('OPENAI_MODEL_CLASSIFIER', { infer: true });
		case 'extractor':
			return config.get('OPENAI_MODEL_EXTRACTOR', { infer: true });
		default:
			return config.get('OPENAI_MODEL_EXTRACTOR', { infer: true });
	}
}

/**
 * Wraps the official `openai` SDK using the **Responses API** (`/v1/responses`), which
 * OpenAI recommends for all new projects per `developers.openai.com/api/docs/guides/migrate-to-responses`.
 * Chat Completions remains supported but Responses is the forward path — built-in tools,
 * better structured-output ergonomics via `text.format`, cleaner request/response shape.
 *
 * Same class covers both OpenAI direct and Azure OpenAI: presence of `AZURE_OPENAI_ENDPOINT`
 * flips the constructor to `AzureOpenAI`. Azure's Responses-API support requires API version
 * `2025-03-01-preview` or newer.
 *
 * **Privacy default: `store: false`.** OpenAI's default is to retain response data for 30
 * days for abuse monitoring; opting out reduces the customer-data surface area sitting on
 * OpenAI servers. Important for our Dutch SMB audience under GDPR/UAVG. Means we can't use
 * Responses chaining (`previous_response_id`) but that doesn't matter for our one-shot
 * extraction calls.
 *
 * Provider lock-in (W5.1) still goes through the `AI_CLIENT` token in `AiModule` —
 * replacing `useExisting: OpenAIClient` with `useExisting: MistralClient` swaps providers
 * without touching downstream code.
 */
@Injectable()
export class OpenAIClient implements AIClient {
	/**
	 * SDK instance, lazily constructed once per process. Null when no API key is configured —
	 * `generate()` then throws `AINotConfiguredError` with a clear message rather than
	 * masking the misconfiguration behind an obscure auth error.
	 */
	private client: OpenAI | null = null;

	constructor(
		private readonly config: ConfigService<EnvSchema, true>,
		private readonly logger: AICallLogger,
		private readonly logService: LogService
	) {}

	async generate<T>(request: AIGenerateRequest<T>): Promise<AIGenerateResult<T>> {
		const client = this.resolveClient();
		if (!client) {
			throw new AINotConfiguredError();
		}

		const model = request.model ?? defaultModelFor(request.purpose, this.config);
		const azureEndpoint = this.config.get('AZURE_OPENAI_ENDPOINT', { infer: true });
		const provider = azureEndpoint ? 'azure-openai' : 'openai';

		const startedAt = Date.now();
		try {
			// `responses.parse` is the SDK's structured-outputs wrapper for the Responses API:
			// sends `text.format: { type: 'json_schema', ... }`, JSON-parses + Zod-validates
			// the response, surfaces the parsed value via `output_parsed`. Refusals appear as
			// a refusal content item (not in `output_parsed`) and we handle them below.
			const response = await client.responses.parse({
				model,
				input: request.prompt,
				text: {
					format: zodTextFormat(request.schema, this.schemaNameFor(request.purpose))
				},
				temperature: request.temperature,
				max_output_tokens: request.maxTokens,
				// Don't have OpenAI retain prompts/responses for abuse monitoring — customer
				// data minimization. See class docstring for rationale.
				store: false
			});

			const latencyMs = Date.now() - startedAt;
			const inputTokens = response.usage?.input_tokens ?? null;
			const outputTokens = response.usage?.output_tokens ?? null;
			const rawText = response.output_text || null;

			// Refusal path: the model declined to produce structured output (policy violation,
			// ambiguity, etc.). `output_parsed` will be null + a refusal content item appears
			// in the output array. Surface as `AISchemaInvalidError` — caller asked for a
			// structured value and didn't get one.
			const refusal = findRefusal(response.output);
			if (refusal) {
				const err = new AISchemaInvalidError(
					`${provider} refused to produce structured output: ${refusal}`,
					refusal,
					{ refusal: true }
				);
				await this.logger.record({
					provider,
					model,
					purpose: request.purpose,
					prompt: request.prompt,
					response: refusal,
					parsed: null,
					status: 'SCHEMA_INVALID',
					errorMessage: err.message,
					promptTokens: inputTokens,
					completionTokens: outputTokens,
					latencyMs
				});
				throw err;
			}

			if (response.output_parsed === null || response.output_parsed === undefined) {
				const err = new AISchemaInvalidError(`${provider} returned no parsed content`, rawText ?? '', {
					noParsed: true
				});
				await this.logger.record({
					provider,
					model,
					purpose: request.purpose,
					prompt: request.prompt,
					response: rawText,
					parsed: null,
					status: 'SCHEMA_INVALID',
					errorMessage: err.message,
					promptTokens: inputTokens,
					completionTokens: outputTokens,
					latencyMs
				});
				throw err;
			}

			const callId = await this.logger.record({
				provider,
				model,
				purpose: request.purpose,
				prompt: request.prompt,
				response: rawText,
				parsed: response.output_parsed as object,
				status: 'SUCCESS',
				errorMessage: null,
				promptTokens: inputTokens,
				completionTokens: outputTokens,
				latencyMs
			});

			return { value: response.output_parsed as T, provider, model, callId };
		} catch (error) {
			// Re-throw our own typed errors without re-wrapping (the refusal/no-parsed branches
			// above already recorded an AICall row before throwing).
			if (error instanceof AISchemaInvalidError) {
				throw error;
			}

			const latencyMs = Date.now() - startedAt;

			// SDK's `APIError` exposes status + message. Default retry budget (2 retries on
			// 429/5xx with backoff) is already exhausted by the time we land here, so this
			// is a final failure.
			if (error instanceof APIError) {
				const wrapped = new AIProviderError(
					`${provider} returned ${error.status ?? 'unknown'}: ${error.message}`,
					error.status ?? 0,
					error.message
				);
				await this.logger.record({
					provider,
					model,
					purpose: request.purpose,
					prompt: request.prompt,
					response: null,
					parsed: null,
					status: 'FAILED',
					errorMessage: wrapped.message,
					promptTokens: null,
					completionTokens: null,
					latencyMs
				});
				throw wrapped;
			}

			// Network failure, JSON parse inside the SDK, anything else — log as FAILED and
			// rethrow the original error for the caller's stack trace.
			await this.logger.record({
				provider,
				model,
				purpose: request.purpose,
				prompt: request.prompt,
				response: null,
				parsed: null,
				status: 'FAILED',
				errorMessage: error instanceof Error ? error.message : String(error),
				promptTokens: null,
				completionTokens: null,
				latencyMs
			});
			throw error;
		}
	}

	/**
	 * Build the OpenAI / AzureOpenAI client lazily on first use. Cached for the lifetime
	 * of the process. Returns null when no key is configured so `generate()` can throw
	 * a clean `AINotConfiguredError`.
	 */
	private resolveClient(): OpenAI | null {
		if (this.client) {
			return this.client;
		}

		const azureEndpoint = this.config.get('AZURE_OPENAI_ENDPOINT', { infer: true });
		const azureKey = this.config.get('AZURE_OPENAI_API_KEY', { infer: true });
		const openaiKey = this.config.get('OPENAI_API_KEY', { infer: true });

		if (azureEndpoint) {
			// Azure mode. Prefer the Azure-specific key, fall back to OPENAI_API_KEY for
			// setups where the same key is reused.
			const apiKey = azureKey || openaiKey;
			if (!apiKey) {
				return null;
			}
			this.client = new AzureOpenAI({
				endpoint: azureEndpoint,
				apiKey,
				apiVersion: this.config.get('AZURE_OPENAI_API_VERSION', { infer: true })
			});
			return this.client;
		}

		if (!openaiKey) {
			return null;
		}
		this.client = new OpenAI({ apiKey: openaiKey });
		return this.client;
	}

	/**
	 * Structured-outputs requires a `name` for the schema (used in error messages + OpenAI
	 * telemetry). Use the purpose tag, sanitized. Must be ≤64 chars and match `[a-zA-Z0-9_-]+`.
	 */
	private schemaNameFor(purpose: string): string {
		return purpose.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'quoteom_output';
	}
}

/**
 * Scan the Responses API output array for a refusal content item. The Responses API
 * surfaces refusals as content items with `type: 'refusal'` inside an output message,
 * rather than a top-level `refusal` field like Chat Completions does. Returns the
 * refusal text if found, else null.
 */
function findRefusal(
	output: ReadonlyArray<{ type: string; content?: ReadonlyArray<{ type: string; refusal?: string }> }>
): string | null {
	for (const item of output) {
		if (item.type !== 'message' || !item.content) {
			continue;
		}
		for (const part of item.content) {
			if (part.type === 'refusal' && part.refusal) {
				return part.refusal;
			}
		}
	}
	return null;
}
