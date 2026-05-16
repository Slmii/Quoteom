import { AICallStatus } from '@/generated/prisma/enums';
import { logContext } from '@/modules/logger/log-context';
import { LogService } from '@/modules/logger/log.service';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

export interface AICallRecord {
	provider: string;
	model: string;
	purpose: string;
	prompt: string;
	response: string | null;
	parsed: object | null;
	status: 'SUCCESS' | 'FAILED' | 'SCHEMA_INVALID' | 'TIMEOUT';
	errorMessage: string | null;
	promptTokens: number | null;
	completionTokens: number | null;
	latencyMs: number;
}

/**
 * Persists one `AICall` row per `AIClient.generate(...)` call. Reads correlation IDs
 * (requestId, userId, organizationId) from the `logContext` AsyncLocalStorage so AI
 * calls fired inside a request boundary are automatically tied back to the user/org.
 *
 * **Best-effort persistence:** a DB write failure here is logged via `LogService` but
 * never rethrown — the AI call itself has already succeeded (or failed) and the caller
 * needs its result regardless. Losing a single audit row is preferable to dropping a
 * legitimate AI response on the floor.
 */
@Injectable()
export class AICallLogger {
	constructor(
		private readonly prisma: PrismaService,
		private readonly logService: LogService
	) {}

	async record(input: AICallRecord): Promise<void> {
		const context = logContext.get();

		try {
			await this.prisma.aICall.create({
				data: {
					provider: input.provider,
					model: input.model,
					purpose: input.purpose,
					prompt: input.prompt,
					response: input.response,
					parsed: input.parsed === null ? undefined : input.parsed,
					status: input.status as AICallStatus,
					errorMessage: input.errorMessage,
					promptTokens: input.promptTokens,
					completionTokens: input.completionTokens,
					latencyMs: input.latencyMs,
					requestId: context?.requestId,
					userId: context?.userId,
					organizationId: context?.organizationId
				}
			});
		} catch (error) {
			// Don't rethrow — the AI call's caller already has its result (or its error).
			// Surface the persistence failure for ops visibility but don't break the flow.
			this.logService.logAction({
				action: 'ai.call.log.persist_failed',
				message: `Failed to persist AICall row: ${error instanceof Error ? error.message : 'unknown'}`,
				metadata: {
					provider: input.provider,
					model: input.model,
					purpose: input.purpose,
					status: input.status
				},
				level: 'error',
				stack: error instanceof Error ? error.stack : undefined,
				context: 'AICallLogger'
			});
		}
	}
}
