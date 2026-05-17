import type { EnvSchema } from '@/config/env.schema';
import { AINotConfiguredError } from '@/modules/ai/clients/ai-client.interface';
import { ClassifierService } from '@/modules/ai/classifier/classifier.service';
import { ExtractorService } from '@/modules/ai/extractor/extractor.service';
import { OPPORTUNITY_NOT_FOUND, invalidOpportunityStatusTransition } from '@/lib/errors';
import { LogService } from '@/modules/logger/log.service';
import { OpportunityListResponseDto } from '@/modules/opportunities/dto/opportunity-list.response.dto';
import { OpportunityResponseDto } from '@/modules/opportunities/dto/opportunity.response.dto';
import {
	decodeOpportunityListCursor,
	encodeOpportunityListCursor
} from '@/modules/opportunities/opportunity-list-cursor';
import {
	OPPORTUNITY_STATUS_FROM_WIRE,
	OPPORTUNITY_STATUS_TO_WIRE,
	isOpportunityStatusTransitionAllowed
} from '@/modules/opportunities/opportunity-status.mapper';
import { OPPORTUNITY_URGENCY_TO_WIRE } from '@/modules/opportunities/opportunity-urgency.mapper';
import {
	OpportunitiesRepository,
	type OpportunityRecord,
	type RawMessageForOpportunityProcessing
} from '@/modules/opportunities/opportunities.repository';
import type {
	OpportunityProcessingBatchResult,
	OpportunityProcessingResult
} from '@/modules/opportunities/opportunities.types';
import { buildRawMessageAIInput } from '@/lib/email/raw-message-ai-input';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OpportunityStatus as WireOpportunityStatus } from '@quoteom/shared';

// Soft cap on rows scanned per Inngest `step.run` invocation. The cap is sized so that
// even at the upper end of provider latency (≈2 s/classification + ≈3 s/extraction on a
// long body) a single step finishes within Inngest's 5-minute step timeout, with margin.
// The opportunities pipeline scales horizontally by chunking through the Inngest function
// loop (see `gmail-backfill.function.ts` et al.) — each batch runs as its own resumable
// `step.run`, so a backfill that scans hundreds of rows survives partial failures and
// per-step retries without losing prior progress.
const PROCESS_BATCH_SIZE = 25;

// In-batch parallelism for the classify-then-extract work. Picked to stay well under
// gpt-4o's 30k-TPM default tier: the extractor burns ~2k tokens/call, so 5 concurrent
// extractions ≈ 10k tokens in flight — safe with margin for the SDK's retries. Higher
// values are faster but risk 429s the SDK can't ride through. Lower values are slower
// but never matter — we'd just be the limit instead of OpenAI.
const PROCESS_BATCH_CONCURRENCY = 5;

const LIST_DEFAULT_PAGE_SIZE = 25;
const LIST_MAX_PAGE_SIZE = 100;

@Injectable()
export class OpportunitiesService {
	constructor(
		private readonly repository: OpportunitiesRepository,
		private readonly classifier: ClassifierService,
		private readonly extractor: ExtractorService,
		private readonly config: ConfigService<EnvSchema, true>,
		private readonly logService: LogService
	) {}

	/**
	 * Resolve `Organization.id` from `EmailAccount.id`. Used by the Inngest pipeline
	 * scaffolding to populate `logContext.organizationId` before any AI/log call inside
	 * a worker run — otherwise `AICall`/`Log` rows from background jobs land with NULL
	 * `organizationId` (the AsyncLocalStorage context is only set by HTTP middleware).
	 */
	resolveOrganizationIdForEmailAccount(emailAccountId: string): Promise<string | null> {
		return this.repository.findOrganizationIdForEmailAccount(emailAccountId);
	}

	async list(
		organizationId: string,
		options: { cursor: string | null; limit: number | null } = { cursor: null, limit: null }
	): Promise<OpportunityListResponseDto> {
		const limit = clampLimit(options.limit);
		const decodedCursor = decodeOpportunityListCursor(options.cursor);

		// Over-fetch by one row to detect a next page without a follow-up count query.
		const rows = await this.repository.listByOrganization(organizationId, {
			take: limit + 1,
			cursor: decodedCursor
		});

		const hasMore = rows.length > limit;
		const page = hasMore ? rows.slice(0, limit) : rows;
		const last = page[page.length - 1];
		const nextCursor =
			hasMore && last ? encodeOpportunityListCursor({ createdAt: last.createdAt, id: last.id }) : null;

		return {
			opportunities: page.map(toOpportunityResponseDto),
			nextCursor
		};
	}

	async updateStatus(
		organizationId: string,
		opportunityId: string,
		status: WireOpportunityStatus
	): Promise<OpportunityResponseDto> {
		const opportunity = await this.repository.findByIdForOrganization(organizationId, opportunityId);
		if (!opportunity) {
			throw new NotFoundException(OPPORTUNITY_NOT_FOUND);
		}

		const nextStatus = OPPORTUNITY_STATUS_FROM_WIRE[status];
		if (!isOpportunityStatusTransitionAllowed(opportunity.status, nextStatus)) {
			throw new BadRequestException(
				invalidOpportunityStatusTransition(
					OPPORTUNITY_STATUS_TO_WIRE[opportunity.status],
					OPPORTUNITY_STATUS_TO_WIRE[nextStatus]
				)
			);
		}

		if (opportunity.status === nextStatus) {
			return toOpportunityResponseDto(opportunity);
		}

		const updated = await this.repository.updateStatus(opportunity.id, nextStatus);
		return toOpportunityResponseDto(updated);
	}

	/**
	 * Convenience wrapper that loops `processBatch` until the queue is exhausted. Used by
	 * unit tests + any callsite that doesn't need to interleave with Inngest's step
	 * checkpointing. **Inngest functions must use `processBatch` directly** so each batch
	 * gets its own `step.run` and the 5-minute step timeout doesn't fail a multi-hundred-
	 * message pass.
	 */
	async processRawMessagesForAccount(emailAccountId: string): Promise<OpportunityProcessingResult> {
		const aggregate: OpportunityProcessingResult = {
			emailAccountId,
			scanned: 0,
			classifiedPositive: 0,
			classifiedNegative: 0,
			opportunitiesCreated: 0,
			opportunitiesSkipped: 0,
			failed: 0
		};
		const excluded = new Set<string>();

		while (true) {
			const batch = await this.processBatch(emailAccountId, [...excluded]);
			mergeProcessingResults(aggregate, batch.result);
			for (const id of batch.failedRawMessageIds) {
				excluded.add(id);
			}
			if (batch.exhausted) {
				break;
			}
		}

		this.logService.logAction({
			action: 'opportunity.pipeline.completed',
			message: `Opportunity pipeline processed ${aggregate.scanned} raw messages for ${emailAccountId}`,
			metadata: { ...aggregate },
			context: 'OpportunitiesService'
		});

		return aggregate;
	}

	/**
	 * Single-batch processing pass. Scans up to `PROCESS_BATCH_SIZE` pending RawMessage
	 * rows for the account, classifies + (on positives) extracts + (on success) writes
	 * an Opportunity row. Designed to live inside one Inngest `step.run`:
	 *  - Caller owns the retry/loop policy (Inngest functions chain calls until exhausted).
	 *  - `failedRawMessageIds` is returned so the caller can pass them to subsequent
	 *    `processBatch` calls' `excludedRawMessageIds` and avoid re-processing rows that
	 *    just failed within the same pipeline run.
	 *  - `exhausted: true` means the next call would scan zero rows — caller stops the loop.
	 */
	async processBatch(
		emailAccountId: string,
		excludedRawMessageIds: readonly string[]
	): Promise<OpportunityProcessingBatchResult> {
		const result: OpportunityProcessingResult = {
			emailAccountId,
			scanned: 0,
			classifiedPositive: 0,
			classifiedNegative: 0,
			opportunitiesCreated: 0,
			opportunitiesSkipped: 0,
			failed: 0
		};
		const failedRawMessageIds = new Set<string>();

		const rawMessages = await this.repository.findPendingRawMessagesForAccount(
			emailAccountId,
			PROCESS_BATCH_SIZE,
			excludedRawMessageIds
		);

		if (rawMessages.length === 0) {
			return { result, failedRawMessageIds: [], exhausted: true };
		}

		// Chunked parallel: each chunk runs `PROCESS_BATCH_CONCURRENCY` messages in
		// parallel through `processOneRawMessage`, which mutates `result` + the failed-id
		// set in-place (single-threaded JS makes the `+= 1` and `Set.add` effectively
		// atomic, so no race on the shared state). Short-circuit on AINotConfigured
		// happens at chunk boundaries — a few in-flight calls may complete after the
		// terminal error, but their results are already accounted for in `result`.
		let aiNotConfigured = false;
		for (let i = 0; i < rawMessages.length; i += PROCESS_BATCH_CONCURRENCY) {
			const slice = rawMessages.slice(i, i + PROCESS_BATCH_CONCURRENCY);
			const outcomes = await Promise.all(
				slice.map(rawMessage => this.processOneRawMessage(rawMessage, result, failedRawMessageIds))
			);
			if (outcomes.some(shouldContinue => !shouldContinue)) {
				aiNotConfigured = true;
				break;
			}
		}

		return {
			result,
			failedRawMessageIds: [...failedRawMessageIds],
			// Stop the outer loop on AI-not-configured (terminal) OR when this batch
			// returned fewer rows than the batch size (no more work to do).
			exhausted: aiNotConfigured || rawMessages.length < PROCESS_BATCH_SIZE
		};
	}

	private async processOneRawMessage(
		rawMessage: RawMessageForOpportunityProcessing,
		result: OpportunityProcessingResult,
		failedRawMessageIds: Set<string>
	): Promise<boolean> {
		result.scanned += 1;

		try {
			const input = buildRawMessageAIInput({
				provider: rawMessage.provider,
				subject: rawMessage.subject,
				fromName: rawMessage.fromName,
				fromEmail: rawMessage.fromEmail,
				raw: rawMessage.raw
			});
			const classification = await this.classifier.classify(input);

			if (!classification.value.isQuote) {
				await this.repository.markRawMessageNegative(rawMessage.id);
				result.classifiedNegative += 1;
				return true;
			}

			const extraction = await this.extractor.extract(input, rawMessage.internalDate.toISOString().slice(0, 10));
			const created = await this.repository.createOpportunityFromRawMessage({
				rawMessage,
				classification: classification.value,
				extraction: extraction.value,
				// Composite `provider/model` identifies the exact SKU that produced the
				// structured fields. The classifier's provenance is still queryable via
				// `classifiedAiCallId` even though we don't materialise it on a column.
				aiProvider: `${extraction.provider}/${extraction.model}`,
				classifiedAiCallId: classification.callId,
				extractedAiCallId: extraction.callId
			});

			result.classifiedPositive += 1;
			if (created) {
				result.opportunitiesCreated += 1;
			} else {
				result.opportunitiesSkipped += 1;
			}
			return true;
		} catch (error) {
			result.failed += 1;
			failedRawMessageIds.add(rawMessage.id);

			this.logService.logAction({
				action: 'opportunity.pipeline.raw_message_failed',
				message: `Failed to process RawMessage ${rawMessage.id}: ${error instanceof Error ? error.message : 'unknown'}`,
				metadata: {
					rawMessageId: rawMessage.id,
					emailAccountId: rawMessage.emailAccountId,
					organizationId: rawMessage.organizationId
				},
				level: 'error',
				stack: error instanceof Error ? error.stack : undefined,
				context: 'OpportunitiesService'
			});

			return !(error instanceof AINotConfiguredError);
		}
	}
}

function clampLimit(raw: number | null): number {
	if (raw === null || Number.isNaN(raw)) {
		return LIST_DEFAULT_PAGE_SIZE;
	}
	const rounded = Math.trunc(raw);
	if (rounded <= 0) {
		return LIST_DEFAULT_PAGE_SIZE;
	}
	return Math.min(rounded, LIST_MAX_PAGE_SIZE);
}

function mergeProcessingResults(target: OpportunityProcessingResult, source: OpportunityProcessingResult): void {
	target.scanned += source.scanned;
	target.classifiedPositive += source.classifiedPositive;
	target.classifiedNegative += source.classifiedNegative;
	target.opportunitiesCreated += source.opportunitiesCreated;
	target.opportunitiesSkipped += source.opportunitiesSkipped;
	target.failed += source.failed;
}

function toOpportunityResponseDto(opportunity: OpportunityRecord): OpportunityResponseDto {
	return {
		id: opportunity.id,
		organizationId: opportunity.organizationId,
		emailAccountId: opportunity.emailAccountId,
		rawMessageId: opportunity.rawMessageId,
		status: OPPORTUNITY_STATUS_TO_WIRE[opportunity.status],
		aiProvider: opportunity.aiProvider,
		requestType: opportunity.requestType,
		urgency: OPPORTUNITY_URGENCY_TO_WIRE[opportunity.urgency],
		deliverableHints: toStringArray(opportunity.deliverableHints),
		createdAt: opportunity.createdAt.toISOString(),
		updatedAt: opportunity.updatedAt.toISOString(),
		internalDate: opportunity.rawMessage.internalDate.toISOString(),
		subject: opportunity.rawMessage.subject,
		fromEmail: opportunity.rawMessage.fromEmail,
		fromName: opportunity.rawMessage.fromName,
		threadId: opportunity.rawMessage.threadId,
		classifierConfidence: opportunity.classifierConfidence,
		classifierReason: opportunity.classifierReason,
		customerName: opportunity.customerName,
		customerEmail: opportunity.customerEmail,
		address: opportunity.address,
		customerDeadline: opportunity.customerDeadline?.toISOString() ?? null,
		customerAppointment: opportunity.customerAppointment?.toISOString() ?? null
	};
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.filter((item): item is string => typeof item === 'string');
}
