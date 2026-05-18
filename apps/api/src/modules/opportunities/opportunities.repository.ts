import { Prisma } from '@/generated/prisma/client';
import {
	DismissReason as PrismaDismissReason,
	EmailProvider,
	OpportunityStatus as PrismaOpportunityStatus,
	Urgency as PrismaUrgency
} from '@/generated/prisma/enums';
import type { ClassifierResult } from '@/modules/ai/classifier/classifier.types';
import type { ExtractorResult, Urgency as ExtractorUrgency } from '@/modules/ai/extractor/extractor.types';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

/**
 * W4.6 — Server-side filter for whether `listByOrganization` includes dismissed rows.
 * Default `active` hides them (matches the workflow-funnel mental model). `dismissed`
 * is for the "Toon afgewezen" toggle on the list page. `all` is mostly for tests +
 * the future admin precision panel.
 */
export type OpportunityDismissedFilter = 'active' | 'dismissed' | 'all';

export interface RawMessageForOpportunityProcessing {
	id: string;
	emailAccountId: string;
	organizationId: string;
	internalDate: Date;
	subject: string | null;
	fromEmail: string | null;
	fromName: string | null;
	raw: unknown;
	provider: EmailProvider;
}

const OPPORTUNITY_INCLUDE = {
	rawMessage: {
		select: {
			internalDate: true,
			subject: true,
			fromEmail: true,
			fromName: true,
			threadId: true
		}
	}
} as const satisfies Prisma.OpportunityInclude;

/**
 * Shape returned by every read on this repository. Derived from the Prisma generated
 * types + `OPPORTUNITY_INCLUDE`, so adding a column to the Prisma model automatically
 * flows through to consumers without a separate interface to update.
 */
export type OpportunityRecord = Prisma.OpportunityGetPayload<{ include: typeof OPPORTUNITY_INCLUDE }>;

export interface CreateOpportunityFromRawMessageInput {
	rawMessage: RawMessageForOpportunityProcessing;
	classification: ClassifierResult;
	extraction: ExtractorResult;
	aiProvider: string;
	classifiedAiCallId: string | null;
	extractedAiCallId: string | null;
}

const EXTRACTOR_URGENCY_TO_PRISMA: Record<ExtractorUrgency, PrismaUrgency> = {
	emergency: PrismaUrgency.EMERGENCY,
	high: PrismaUrgency.HIGH,
	normal: PrismaUrgency.NORMAL,
	low: PrismaUrgency.LOW
};

@Injectable()
export class OpportunitiesRepository {
	constructor(private readonly prisma: PrismaService) {}

	async findPendingRawMessagesForAccount(
		emailAccountId: string,
		limit: number,
		excludedIds: readonly string[]
	): Promise<RawMessageForOpportunityProcessing[]> {
		const rawMessages = await this.prisma.rawMessage.findMany({
			where: {
				emailAccountId,
				classifiedAt: null,
				...(excludedIds.length > 0 ? { id: { notIn: [...excludedIds] } } : {})
			},
			orderBy: { internalDate: 'asc' },
			take: limit,
			select: {
				id: true,
				emailAccountId: true,
				organizationId: true,
				internalDate: true,
				subject: true,
				fromEmail: true,
				fromName: true,
				raw: true,
				emailAccount: { select: { provider: true } }
			}
		});

		return rawMessages.map(rawMessage => ({
			id: rawMessage.id,
			emailAccountId: rawMessage.emailAccountId,
			organizationId: rawMessage.organizationId,
			internalDate: rawMessage.internalDate,
			subject: rawMessage.subject,
			fromEmail: rawMessage.fromEmail,
			fromName: rawMessage.fromName,
			raw: rawMessage.raw,
			provider: rawMessage.emailAccount.provider
		}));
	}

	async findOrganizationIdForEmailAccount(emailAccountId: string): Promise<string | null> {
		const row = await this.prisma.emailAccount.findUnique({
			where: { id: emailAccountId },
			select: { organizationId: true }
		});
		return row?.organizationId ?? null;
	}

	async markRawMessageNegative(rawMessageId: string): Promise<void> {
		await this.prisma.rawMessage.update({
			where: { id: rawMessageId },
			data: { isQuoteRequest: false, classifiedAt: new Date() }
		});
	}

	async createOpportunityFromRawMessage(input: CreateOpportunityFromRawMessageInput): Promise<boolean> {
		const created = await this.prisma.$transaction(async tx => {
			const result = await tx.opportunity.createMany({
				data: [
					{
						organizationId: input.rawMessage.organizationId,
						emailAccountId: input.rawMessage.emailAccountId,
						rawMessageId: input.rawMessage.id,
						status: PrismaOpportunityStatus.NEW,
						aiProvider: input.aiProvider,
						classifiedAiCallId: input.classifiedAiCallId,
						extractedAiCallId: input.extractedAiCallId,
						classifierConfidence: input.classification.confidence,
						classifierReason: input.classification.reason,
						customerName: input.extraction.customerName,
						customerEmail: input.extraction.customerEmail,
						address: input.extraction.address,
						requestType: input.extraction.requestType,
						urgency: EXTRACTOR_URGENCY_TO_PRISMA[input.extraction.urgency],
						customerDeadline: parseDateOnly(input.extraction.customerDeadline),
						customerAppointment: parseDateOnly(input.extraction.customerAppointment),
						deliverableHints: input.extraction.deliverableHints
					}
				],
				skipDuplicates: true
			});

			await tx.rawMessage.update({
				where: { id: input.rawMessage.id },
				data: { isQuoteRequest: true, classifiedAt: new Date() }
			});

			return result.count > 0;
		});

		return created;
	}

	async listByOrganization(
		organizationId: string,
		options: {
			take: number;
			cursor: { createdAt: Date; id: string } | null;
			status: PrismaOpportunityStatus | null;
			search: string | null;
			/** W4.6 — defaults to `active` (hides dismissed) when omitted. */
			dismissed?: OpportunityDismissedFilter;
		}
	): Promise<OpportunityRecord[]> {
		// Keyset pagination on (createdAt DESC, id DESC) — id breaks createdAt ties so the
		// cursor is stable across rows created in the same millisecond. We over-fetch by 1
		// row so the service can tell whether a next page exists without a separate count.
		// Status filter + search OR-clause (optional) apply at SQL level so cursor + filters
		// cohabit cleanly. The two OR-clauses (search + keyset) live under `AND` so neither
		// overwrites the other in Prisma's where-shape merge.
		const search = options.search?.trim();
		const conditions: Prisma.OpportunityWhereInput[] = [];
		if (search) {
			conditions.push({
				OR: [
					{ customerName: { contains: search, mode: 'insensitive' } },
					{ address: { contains: search, mode: 'insensitive' } },
					{ requestType: { contains: search, mode: 'insensitive' } },
					{ rawMessage: { is: { fromName: { contains: search, mode: 'insensitive' } } } },
					{ rawMessage: { is: { subject: { contains: search, mode: 'insensitive' } } } }
				]
			});
		}
		if (options.cursor) {
			conditions.push({
				OR: [
					{ createdAt: { lt: options.cursor.createdAt } },
					{ createdAt: options.cursor.createdAt, id: { lt: options.cursor.id } }
				]
			});
		}

		const dismissedFilter = options.dismissed ?? 'active';

		return this.prisma.opportunity.findMany({
			where: {
				organizationId,
				...(options.status ? { status: options.status } : {}),
				...(dismissedFilter === 'active' ? { dismissedAt: null } : {}),
				...(dismissedFilter === 'dismissed' ? { dismissedAt: { not: null } } : {}),
				...(conditions.length > 0 ? { AND: conditions } : {})
			},
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
			take: options.take,
			include: OPPORTUNITY_INCLUDE
		});
	}

	/**
	 * Per-status counts for the org. Drives the segmented filter tabs ("New (12) ·
	 * Replied (8) · ..."). Single SQL aggregation across all 6 statuses.
	 *
	 * W4.6 — dismissed rows are excluded so the tab counts stay honest as a workflow
	 * funnel. Showing the "Toon afgewezen" view in the UI does not change these
	 * totals — that view filters the list, not the counts.
	 */
	async countByStatusForOrganization(organizationId: string): Promise<Record<PrismaOpportunityStatus, number>> {
		const rows = await this.prisma.opportunity.groupBy({
			by: ['status'],
			where: { organizationId, dismissedAt: null },
			_count: { _all: true }
		});
		const result = {
			[PrismaOpportunityStatus.NEW]: 0,
			[PrismaOpportunityStatus.REPLIED]: 0,
			[PrismaOpportunityStatus.WAITING]: 0,
			[PrismaOpportunityStatus.COLD]: 0,
			[PrismaOpportunityStatus.WON]: 0,
			[PrismaOpportunityStatus.LOST]: 0
		};
		for (const row of rows) {
			result[row.status] = row._count._all;
		}
		return result;
	}

	async findByIdForOrganization(organizationId: string, id: string): Promise<OpportunityRecord | null> {
		return this.prisma.opportunity.findFirst({
			where: { id, organizationId },
			include: OPPORTUNITY_INCLUDE
		});
	}

	async updateStatus(id: string, status: PrismaOpportunityStatus): Promise<OpportunityRecord> {
		return this.prisma.opportunity.update({
			where: { id },
			data: { status },
			include: OPPORTUNITY_INCLUDE
		});
	}

	/**
	 * W4.6 — Soft-disable the opportunity with a reason + actor. Idempotent at the
	 * write level — re-dismissing with the same reason still bumps `dismissedAt` so
	 * the audit timeline shows the latest decision, but the row is otherwise unchanged.
	 */
	async dismiss(id: string, reason: PrismaDismissReason, actorUserId: string): Promise<OpportunityRecord> {
		return this.prisma.opportunity.update({
			where: { id },
			data: {
				dismissedAt: new Date(),
				dismissReason: reason,
				dismissedById: actorUserId
			},
			include: OPPORTUNITY_INCLUDE
		});
	}

	/**
	 * W4.6 — Un-dismiss: clear all three columns atomically. Used when the owner
	 * regrets a dismiss action.
	 */
	async undismiss(id: string): Promise<OpportunityRecord> {
		return this.prisma.opportunity.update({
			where: { id },
			data: {
				dismissedAt: null,
				dismissReason: null,
				dismissedById: null
			},
			include: OPPORTUNITY_INCLUDE
		});
	}
}

function parseDateOnly(value: string | null): Date | null {
	if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return null;
	}

	const parsed = new Date(`${value}T00:00:00.000Z`);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}
