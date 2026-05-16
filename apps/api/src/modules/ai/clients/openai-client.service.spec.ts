import type { EnvSchema } from '@/config/env.schema';
import {
	AINotConfiguredError,
	AIProviderError,
	AISchemaInvalidError
} from '@/modules/ai/clients/ai-client.interface';
import { OpenAIClient } from '@/modules/ai/clients/openai-client.service';
import type { AICallLogger } from '@/modules/ai/logging/ai-call-logger.service';
import type { LogService } from '@/modules/logger/log.service';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import { z } from 'zod';

const logServiceStub = { logAction: jest.fn() } as unknown as LogService;

function makeLogger(): { logger: AICallLogger; record: jest.Mock } {
	const record = jest.fn().mockReturnValue(Promise.resolve());
	return {
		logger: { record } as unknown as AICallLogger,
		record
	};
}

function makeConfig(values: Partial<EnvSchema>): ConfigService<EnvSchema, true> {
	const defaults: Partial<EnvSchema> = {
		OPENAI_MODEL_CLASSIFIER: 'gpt-4o-mini',
		OPENAI_MODEL_EXTRACTOR: 'gpt-4o',
		AZURE_OPENAI_API_VERSION: '2025-03-01-preview'
	};
	const merged = { ...defaults, ...values };
	return {
		get: jest.fn().mockImplementation((key: unknown) => (merged as Record<string, unknown>)[key as string])
	} as unknown as ConfigService<EnvSchema, true>;
}

/**
 * Test seam: replace the SDK's `responses.parse` method on the lazily-built client
 * instance with a controllable jest mock. Cleaner than `jest.mock('openai', ...)` —
 * the SDK exports many typed surfaces (APIError, etc.) we want the real implementations
 * of in assertions.
 */
async function withMockedParse(
	service: OpenAIClient,
	parseImpl: jest.Mock
): Promise<{ parse: jest.Mock }> {
	type Internal = { resolveClient: () => unknown; client: { responses: { parse: jest.Mock } } | null };
	const internal = service as unknown as Internal;
	const client = internal.resolveClient();
	if (!client) {
		throw new Error('test setup error: resolveClient() returned null (config missing API key?)');
	}
	(client as { responses: { parse: jest.Mock } }).responses.parse = parseImpl;
	return { parse: parseImpl };
}

/** Build a successful Responses-API result with `output_parsed` populated. */
function successResponse(parsed: unknown, opts: { rawText?: string; inputTokens?: number; outputTokens?: number } = {}) {
	const rawText = opts.rawText ?? JSON.stringify(parsed);
	return {
		output_parsed: parsed,
		output_text: rawText,
		output: [
			{
				type: 'message',
				content: [{ type: 'output_text', text: rawText }]
			}
		],
		usage: {
			input_tokens: opts.inputTokens ?? 100,
			output_tokens: opts.outputTokens ?? 30
		}
	};
}

/** Build a Responses-API result that contains a refusal item. */
function refusalResponse(refusalText: string) {
	return {
		output_parsed: null,
		output_text: '',
		output: [
			{
				type: 'message',
				content: [{ type: 'refusal', refusal: refusalText }]
			}
		],
		usage: { input_tokens: 50, output_tokens: 10 }
	};
}

describe('OpenAIClient.generate (Responses API)', () => {
	let originalFetch: typeof globalThis.fetch | undefined;

	beforeEach(() => {
		// Belt-and-suspenders: ensure no real HTTP can leak from the SDK even if a test misses
		// the parse-method override.
		originalFetch = globalThis.fetch;
		globalThis.fetch = jest.fn().mockImplementation(() => {
			throw new Error('test leak: unmocked SDK network call');
		}) as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		if (originalFetch) {
			globalThis.fetch = originalFetch;
		}
		jest.restoreAllMocks();
	});

	const classifierSchema = z.object({ isQuote: z.boolean(), confidence: z.number() });

	it('throws AINotConfiguredError when no API key + no Azure endpoint set', async () => {
		const { logger } = makeLogger();
		const client = new OpenAIClient(makeConfig({}), logger, logServiceStub);
		await expect(
			client.generate({ purpose: 'classifier', prompt: 'is this a quote?', schema: classifierSchema })
		).rejects.toBeInstanceOf(AINotConfiguredError);
	});

	it('returns the parsed structured output on success', async () => {
		const { logger, record } = makeLogger();
		const client = new OpenAIClient(makeConfig({ OPENAI_API_KEY: 'sk-test' }), logger, logServiceStub);
		const parse = jest.fn().mockReturnValue(Promise.resolve(successResponse({ isQuote: true, confidence: 0.9 })));
		await withMockedParse(client, parse);

		const result = await client.generate({
			purpose: 'classifier',
			prompt: 'is this a quote?',
			schema: classifierSchema
		});

		expect(result).toEqual({ isQuote: true, confidence: 0.9 });
		expect(parse).toHaveBeenCalledTimes(1);
		const callArgs = parse.mock.calls[0]?.[0] as {
			model: string;
			input: string;
			text: { format: unknown };
			store: boolean;
		};
		expect(callArgs.model).toBe('gpt-4o-mini'); // default for 'classifier' purpose
		expect(callArgs.input).toBe('is this a quote?');
		expect(callArgs.text.format).toBeDefined();
		// Privacy default: don't have OpenAI retain prompts/responses.
		expect(callArgs.store).toBe(false);
		expect(record).toHaveBeenCalledTimes(1);
		expect(record.mock.calls[0]?.[0]).toMatchObject({
			provider: 'openai',
			status: 'SUCCESS',
			promptTokens: 100,
			completionTokens: 30
		});
	});

	it('uses the extractor model when purpose is extractor', async () => {
		const { logger } = makeLogger();
		const client = new OpenAIClient(makeConfig({ OPENAI_API_KEY: 'sk-test' }), logger, logServiceStub);
		const parse = jest.fn().mockReturnValue(Promise.resolve(successResponse({ isQuote: true, confidence: 0.5 })));
		await withMockedParse(client, parse);

		await client.generate({ purpose: 'extractor', prompt: 'extract', schema: classifierSchema });
		expect((parse.mock.calls[0]?.[0] as { model: string }).model).toBe('gpt-4o');
	});

	it('honors an explicit model override', async () => {
		const { logger } = makeLogger();
		const client = new OpenAIClient(makeConfig({ OPENAI_API_KEY: 'sk-test' }), logger, logServiceStub);
		const parse = jest.fn().mockReturnValue(Promise.resolve(successResponse({ isQuote: false, confidence: 0.1 })));
		await withMockedParse(client, parse);

		await client.generate({
			purpose: 'classifier',
			prompt: 'x',
			schema: classifierSchema,
			model: 'o3-mini'
		});
		expect((parse.mock.calls[0]?.[0] as { model: string }).model).toBe('o3-mini');
	});

	it('uses AzureOpenAI when AZURE_OPENAI_ENDPOINT is set', async () => {
		const { logger, record } = makeLogger();
		const client = new OpenAIClient(
			makeConfig({
				OPENAI_API_KEY: 'shared',
				AZURE_OPENAI_ENDPOINT: 'https://quoteom.openai.azure.com',
				AZURE_OPENAI_API_KEY: 'azure-key',
				AZURE_OPENAI_API_VERSION: '2025-03-01-preview'
			}),
			logger,
			logServiceStub
		);
		const parse = jest.fn().mockReturnValue(Promise.resolve(successResponse({ isQuote: false, confidence: 0.2 })));
		await withMockedParse(client, parse);

		await client.generate({ purpose: 'extractor', prompt: 'extract', schema: classifierSchema });
		expect(record.mock.calls[0]?.[0]).toMatchObject({ provider: 'azure-openai' });
	});

	it('throws AISchemaInvalidError on model refusal', async () => {
		const { logger, record } = makeLogger();
		const client = new OpenAIClient(makeConfig({ OPENAI_API_KEY: 'sk-test' }), logger, logServiceStub);
		const parse = jest.fn().mockReturnValue(Promise.resolve(refusalResponse('I cannot answer that.')));
		await withMockedParse(client, parse);

		await expect(
			client.generate({ purpose: 'classifier', prompt: 'x', schema: classifierSchema })
		).rejects.toBeInstanceOf(AISchemaInvalidError);
		const logArg = record.mock.calls[0]?.[0] as { status: string; response: string | null };
		expect(logArg.status).toBe('SCHEMA_INVALID');
		expect(logArg.response).toBe('I cannot answer that.');
	});

	it('throws AISchemaInvalidError when output_parsed is null without a refusal', async () => {
		const { logger, record } = makeLogger();
		const client = new OpenAIClient(makeConfig({ OPENAI_API_KEY: 'sk-test' }), logger, logServiceStub);
		const parse = jest.fn().mockReturnValue(
			Promise.resolve({
				output_parsed: null,
				output_text: 'unexpected raw text',
				output: [{ type: 'message', content: [{ type: 'output_text', text: 'unexpected raw text' }] }],
				usage: { input_tokens: 10, output_tokens: 5 }
			})
		);
		await withMockedParse(client, parse);

		await expect(
			client.generate({ purpose: 'classifier', prompt: 'x', schema: classifierSchema })
		).rejects.toBeInstanceOf(AISchemaInvalidError);
		expect(record.mock.calls[0]?.[0]).toMatchObject({ status: 'SCHEMA_INVALID' });
	});

	it('wraps SDK APIError as AIProviderError with FAILED status', async () => {
		const { logger, record } = makeLogger();
		const { APIError } = await import('openai');
		const client = new OpenAIClient(makeConfig({ OPENAI_API_KEY: 'sk-bad' }), logger, logServiceStub);
		const parse = jest.fn().mockImplementation(() => {
			throw new APIError(401, { message: 'Invalid API key' }, 'Invalid API key', new Headers());
		});
		await withMockedParse(client, parse);

		await expect(
			client.generate({ purpose: 'classifier', prompt: 'x', schema: classifierSchema })
		).rejects.toBeInstanceOf(AIProviderError);
		expect(record.mock.calls[0]?.[0]).toMatchObject({ status: 'FAILED' });
	});

	it('records latency + prompt verbatim + token counts in the AICall row', async () => {
		const { logger, record } = makeLogger();
		const client = new OpenAIClient(makeConfig({ OPENAI_API_KEY: 'sk-test' }), logger, logServiceStub);
		const parse = jest.fn().mockReturnValue(
			Promise.resolve(
				successResponse({ isQuote: true, confidence: 0.95 }, {
					rawText: '{"isQuote":true,"confidence":0.95}',
					inputTokens: 42,
					outputTokens: 7
				})
			)
		);
		await withMockedParse(client, parse);

		await client.generate({ purpose: 'classifier', prompt: 'Is this a quote? Email: hello', schema: classifierSchema });

		const logArg = record.mock.calls[0]?.[0] as {
			prompt: string;
			response: string | null;
			parsed: unknown;
			promptTokens: number | null;
			completionTokens: number | null;
			latencyMs: number;
		};
		expect(logArg.prompt).toBe('Is this a quote? Email: hello');
		expect(logArg.response).toBe('{"isQuote":true,"confidence":0.95}');
		expect(logArg.parsed).toEqual({ isQuote: true, confidence: 0.95 });
		expect(logArg.promptTokens).toBe(42);
		expect(logArg.completionTokens).toBe(7);
		expect(typeof logArg.latencyMs).toBe('number');
	});
});
