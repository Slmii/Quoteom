import type { ZodType } from 'zod';

/**
 * Provider-agnostic interface for invoking an LLM and getting a Zod-typed structured
 * response. All AI work in the app (classifier, extractor, tone-learner, reply-drafter,
 * line-item proposer) flows through this single seam.
 *
 * Decoupling caller from provider lets us swap OpenAI for Mistral/Anthropic in one place
 * (the DI binding in `AiModule`) without touching downstream services. The W5.1 spike
 * compares providers by registering each concrete impl under this token and running the
 * same test corpus through each.
 */
export interface AIClient {
	/**
	 * Send `prompt` to the model and return a value that matches `schema`.
	 *
	 * Implementation contract:
	 *  - The provider must produce structured output matching `schema` (modern providers
	 *    do this via `response_format: { type: 'json_schema' }`; older models would need
	 *    a JSON-mode prompt + post-hoc parse, which we don't bother with).
	 *  - The response is validated with Zod's `schema.parse()`. Mismatch throws
	 *    `AISchemaInvalidError` — caller decides whether to fall back to a different
	 *    model, drop the result, or surface to the user.
	 *  - 429 / 5xx / network errors retry with exponential backoff (3 attempts total).
	 *    400 / 401 / 403 / Zod validation failures do NOT retry — they're terminal.
	 *  - Every call (success or failure) writes one `AICall` row via `AICallLogger`.
	 *    Best-effort: a DB log failure doesn't break the AI call's return path.
	 */
	generate<T>(opts: AIGenerateRequest<T>): Promise<T>;
}

export interface AIGenerateRequest<T> {
	/**
	 * Application-level intent tag. Stored on the AICall row for grouping queries.
	 * Examples: `'classifier'`, `'extractor'`, `'tone-learn'`, `'reply-draft'`,
	 * `'line-item-proposer'`. Free text — there's no enum because new purposes get added
	 * faster than we'd want to migrate the schema.
	 */
	purpose: string;
	/** The full prompt to send to the model. May include few-shot examples, instructions, etc. */
	prompt: string;
	/** Zod schema describing the expected response shape. Used both to encode the request's
	 *  `response_format` AND to validate the response on the way back. */
	schema: ZodType<T>;
	/**
	 * Optional model override. When unset, the implementation picks a default based on
	 * `purpose` (e.g. `gpt-4o-mini` for classifier, `gpt-4o` for extractor). Override
	 * only when you need something specific (cheaper for batch jobs, more capable for
	 * a hard prompt).
	 */
	model?: string;
	/** Defaults to provider's default. 0 = deterministic, 1.0 = creative. */
	temperature?: number;
	/** Cap on output tokens. Defaults to provider's default. */
	maxTokens?: number;
}

/**
 * DI token for the `AIClient` interface. Used in `@Inject(AI_CLIENT)` since interfaces
 * have no runtime representation. The concrete implementation (today: `OpenAIClient`;
 * later swappable via `AiModule.providers`) is bound under this token.
 */
export const AI_CLIENT = Symbol('AI_CLIENT');

/**
 * Thrown when the AI returns a response that doesn't match the requested Zod schema.
 * Terminal — never retried. Caller decides recovery strategy.
 */
export class AISchemaInvalidError extends Error {
	constructor(
		message: string,
		readonly rawResponse: string,
		readonly zodIssues: unknown
	) {
		super(message);
		this.name = 'AISchemaInvalidError';
	}
}

/** Thrown when the AI provider is not configured (no API key, no Azure endpoint). Terminal. */
export class AINotConfiguredError extends Error {
	constructor(message = 'AI provider not configured — set OPENAI_API_KEY (or AZURE_OPENAI_*)') {
		super(message);
		this.name = 'AINotConfiguredError';
	}
}

/** Thrown when the AI provider returned an error response that's not worth retrying (4xx). */
export class AIProviderError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body: string
	) {
		super(message);
		this.name = 'AIProviderError';
	}
}
