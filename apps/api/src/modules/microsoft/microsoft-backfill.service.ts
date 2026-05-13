import { EmailProvider } from '@/generated/prisma/enums';
import { EMAIL_ACCOUNT_NOT_FOUND } from '@/lib/errors';
import { EmailAccountsService } from '@/modules/email-accounts/email-accounts.service';
import type { MicrosoftFullMessage } from '@/modules/microsoft/microsoft-graph-api.service';
import { MicrosoftGraphApiService } from '@/modules/microsoft/microsoft-graph-api.service';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';

/**
 * W3.2 — same backfill window as Gmail. See `gmail-backfill.service.ts` for rationale.
 */
const BACKFILL_DAYS = 90;

/** Graph's per-page max is 1000; we keep parity with Gmail's chosen page size. */
const PAGE_SIZE = 100;

/** Safety cap — same as Gmail. ~10k messages worst case. */
const MAX_PAGES = 100;

export interface MicrosoftBackfillResult {
	emailAccountId: string;
	pagesFetched: number;
	messagesInserted: number;
	messagesSkipped: number;
}

/**
 * Backfills a freshly-connected Microsoft mailbox: walks Graph's `/me/mailFolders/Inbox/
 * messages` for the last `BACKFILL_DAYS`, persisting each one as a `RawMessage` row.
 * Same idempotency contract as `GmailBackfillService` — re-runs hit the same unique
 * index on `(emailAccountId, providerMessageId)` and skip duplicates.
 *
 * Key differences from Gmail's backfill (encapsulated in `MicrosoftGraphApiService`):
 *  - Graph returns the full message body in `messages.list` (no per-message GET call needed)
 *  - Pagination via `@odata.nextLink` (full URL), not a token
 *  - `$filter=receivedDateTime ge ISO` instead of Gmail's `q=after:YYYY/MM/DD` syntax
 *  - No equivalent of Gmail's `historyId` — Graph push subscriptions (W3.6) use a
 *    different cursor model. We leave `EmailAccount.historyId` null for Microsoft.
 */
@Injectable()
export class MicrosoftBackfillService {
	private readonly logger = new Logger(MicrosoftBackfillService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly accounts: EmailAccountsService,
		private readonly api: MicrosoftGraphApiService
	) {}

	async run(emailAccountId: string): Promise<MicrosoftBackfillResult> {
		const account = await this.prisma.emailAccount.findUnique({
			where: { id: emailAccountId },
			select: { id: true, organizationId: true, userId: true, email: true, provider: true }
		});
		if (!account || account.provider !== EmailProvider.MICROSOFT) {
			throw new NotFoundException(EMAIL_ACCOUNT_NOT_FOUND);
		}
		if (!account.userId) {
			this.logger.warn(`EmailAccount ${emailAccountId} has no userId — skipping backfill`);
			return { emailAccountId, pagesFetched: 0, messagesInserted: 0, messagesSkipped: 0 };
		}

		const scope = {
			provider: EmailProvider.MICROSOFT,
			organizationId: account.organizationId,
			userId: account.userId
		};
		const cutoff = new Date(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000).toISOString();
		// Graph's $filter expects ISO 8601 with single-quoted strings, no spaces in the
		// comparison — `receivedDateTime ge 2026-02-12T00:00:00Z`. Already-Z-suffixed.
		const filter = `receivedDateTime ge ${cutoff}`;

		let nextLink: string | undefined;
		let pagesFetched = 0;
		let messagesInserted = 0;
		let messagesSkipped = 0;

		await this.accounts.withFreshAccessToken(scope, async accessToken => {
			while (pagesFetched < MAX_PAGES) {
				const page = await this.api.listInboxMessagesPage(accessToken, {
					filter: nextLink ? undefined : filter,
					top: PAGE_SIZE,
					nextLink
				});
				pagesFetched += 1;

				if (page.messages.length === 0) {
					break;
				}

				const inserted = await this.persistBatch(emailAccountId, account.organizationId, page.messages);
				messagesInserted += inserted;
				messagesSkipped += page.messages.length - inserted;

				if (!page.nextLink) {
					break;
				}
				nextLink = page.nextLink;
			}
		});

		this.logger.log(
			`Backfill complete for ${account.email}: ${pagesFetched} pages, ${messagesInserted} new, ${messagesSkipped} already present`
		);

		return {
			emailAccountId,
			pagesFetched,
			messagesInserted,
			messagesSkipped
		};
	}

	/**
	 * Persist a page's worth of messages. Same find-existing-then-createMany pattern as
	 * Gmail's backfill — avoids N upserts when most messages are new.
	 */
	private async persistBatch(
		emailAccountId: string,
		organizationId: string,
		messages: readonly MicrosoftFullMessage[]
	): Promise<number> {
		if (messages.length === 0) {
			return 0;
		}

		const incomingIds = messages.map(m => m.id);
		const existing = await this.prisma.rawMessage.findMany({
			where: { emailAccountId, providerMessageId: { in: incomingIds } },
			select: { providerMessageId: true }
		});
		const existingSet = new Set(existing.map(r => r.providerMessageId));
		const toInsert = messages.filter(m => !existingSet.has(m.id));

		if (toInsert.length === 0) {
			return 0;
		}

		const result = await this.prisma.rawMessage.createMany({
			data: toInsert.map(m => {
				const fromAddr = m.from?.emailAddress;
				return {
					emailAccountId,
					organizationId,
					providerMessageId: m.id,
					threadId: m.conversationId ?? null,
					internalDate: new Date(m.receivedDateTime),
					subject: m.subject ?? null,
					fromEmail: fromAddr?.address?.toLowerCase() ?? null,
					fromName: fromAddr?.name ?? null,
					raw: m as unknown as object
				};
			}),
			skipDuplicates: true
		});

		return result.count;
	}
}
