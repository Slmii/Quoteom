import { EmailProvider } from '@/generated/prisma/enums';
import { EMAIL_ACCOUNT_NOT_FOUND } from '@/lib/errors';
import { EmailAccountsService } from '@/modules/email-accounts/email-accounts.service';
import { LogService } from '@/modules/logger/log.service';
import {
	MicrosoftDeltaTokenExpiredException,
	MicrosoftGraphApiService,
	type MicrosoftDeltaPage,
	type MicrosoftFullMessage
} from '@/modules/microsoft/microsoft-graph-api.service';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { Injectable, NotFoundException } from '@nestjs/common';

/** Safety cap — bounds runtime if a subscription was unattended for too long. */
const MAX_PAGES = 50;

export interface MicrosoftDeltaSyncResult {
	emailAccountId: string;
	pagesFetched: number;
	messagesInserted: number;
	messagesSkipped: number;
	/** New deltaLink persisted on the EmailAccount row. */
	deltaLink: string | null;
	/** True if the stored cursor was rejected (410 Gone) and we recovered. */
	deltaTokenExpired: boolean;
}

/**
 * W3.6 — incremental sync triggered by a Microsoft Graph push notification.
 *
 * Walks `/me/messages/delta` from `EmailAccount.deltaLink` (or a fresh delta walk if no
 * cursor exists yet), persists every new message as a `RawMessage` row, and advances the
 * cursor. Idempotent via the same `(emailAccountId, providerMessageId)` unique index the
 * backfill uses.
 *
 * **DeltaLink-expired recovery:** Graph retains delta tokens for ~30 days. If our stored
 * cursor has aged out, the next call returns 410 → we re-acquire by starting a fresh
 * delta walk. The gap (changes between our stale cursor and the new starting point) is
 * lost; the alternative would be backfilling by date range, which is much more complex
 * for a rare path (only fires if the app was offline >30 days).
 *
 * **Per-page commits + null-tolerant fetch:** carried over from the W3.5 audit lessons.
 * Mid-walk 410 leaves earlier pages safely in DB; messages deleted between push + fetch
 * are silently skipped instead of crashing the batch.
 *
 * Kept framework-agnostic (no Inngest types here) so unit tests don't need an Inngest
 * dev server. The Inngest function wrapper lives in `modules/inngest/functions/`.
 */
@Injectable()
export class MicrosoftDeltaSyncService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly accounts: EmailAccountsService,
		private readonly api: MicrosoftGraphApiService,
		private readonly logService: LogService
	) {}

	async run(emailAccountId: string): Promise<MicrosoftDeltaSyncResult> {
		const account = await this.prisma.emailAccount.findUnique({
			where: { id: emailAccountId },
			select: {
				id: true,
				organizationId: true,
				userId: true,
				email: true,
				provider: true,
				deltaLink: true
			}
		});
		if (!account || account.provider !== EmailProvider.MICROSOFT) {
			throw new NotFoundException(EMAIL_ACCOUNT_NOT_FOUND);
		}
		if (!account.userId) {
			// Orphan row — userId set null on user delete. Skip cleanly; not an error.
			this.logService.logAction({
				action: 'email.delta_sync.orphaned',
				message: `EmailAccount ${emailAccountId} has no userId — skipping delta sync`,
				metadata: { provider: account.provider, emailAccountId },
				level: 'warn',
				context: 'MicrosoftDeltaSyncService'
			});
			return {
				emailAccountId,
				pagesFetched: 0,
				messagesInserted: 0,
				messagesSkipped: 0,
				deltaLink: null,
				deltaTokenExpired: false
			};
		}

		const scope = {
			provider: EmailProvider.MICROSOFT,
			organizationId: account.organizationId,
			userId: account.userId
		};

		// State declared in the outer scope so the post-loop log + recovery branch can read
		// it. Reset at the top of `work` because `withFreshAccessToken` re-runs the whole
		// callback on a mid-call 401 — without reset, counters compound across the failed
		// attempt + the retry.
		let pagesFetched = 0;
		let messagesInserted = 0;
		let messagesSkipped = 0;
		let newDeltaLink: string | null = null;
		let deltaTokenExpired = false;

		const work = async (accessToken: string): Promise<void> => {
			pagesFetched = 0;
			messagesInserted = 0;
			messagesSkipped = 0;
			newDeltaLink = null;
			deltaTokenExpired = false;
			let cursor: string | null = account.deltaLink;

			while (pagesFetched < MAX_PAGES) {
				let page: MicrosoftDeltaPage;
				try {
					page = await this.api.getDelta(accessToken, cursor);
				} catch (error) {
					if (!(error instanceof MicrosoftDeltaTokenExpiredException)) {
						throw error;
					}
					// Cursor expired mid-walk (or on the first call). Mark + break;
					// earlier pages persisted stay in DB. Outer recovery re-acquires.
					deltaTokenExpired = true;
					break;
				}

				pagesFetched += 1;

				if (page.messages.length > 0) {
					// Per-page commits: a mid-walk failure (token expired, network error)
					// leaves earlier pages safely in the DB rather than discarding the
					// whole batch. Carried over from W3.5 audit fix #1.
					const inserted = await this.persistBatch(emailAccountId, account.organizationId, page.messages);
					messagesInserted += inserted;
					messagesSkipped += page.messages.length - inserted;
				}

				if (page.deltaLink) {
					// Final page of this walk — store the new cursor.
					newDeltaLink = page.deltaLink;
					break;
				}
				if (page.nextLink) {
					cursor = page.nextLink;
					continue;
				}
				// Neither deltaLink nor nextLink — shouldn't happen per Graph spec, but
				// guard against a malformed response.
				break;
			}
		};

		await this.accounts.withFreshAccessToken(scope, work);

		if (deltaTokenExpired) {
			// Re-acquire a fresh deltaLink by starting a clean walk from null. Don't
			// replay the gap — see service docstring.
			this.logService.logAction({
				action: 'email.delta_sync.delta_token_expired',
				message: `Microsoft delta cursor expired for ${account.email} — re-acquiring`,
				metadata: {
					provider: account.provider,
					emailAccountId,
					previousDeltaLink: account.deltaLink,
					pagesPersistedBeforeExpiry: pagesFetched
				},
				level: 'warn',
				context: 'MicrosoftDeltaSyncService'
			});
			const recoveredLink = await this.accounts.withFreshAccessToken(scope, async accessToken => {
				// Walk a fresh delta to its end to capture the new deltaLink. Discard the
				// messages — they're current-state, not deltas, and we don't want to flood
				// RawMessage with everything in the inbox.
				//
				// Capped at MAX_PAGES so a misbehaving Graph response (deltaLink never
				// returned, nextLink loops) can't spin forever.
				let cursor: string | null = null;
				for (let i = 0; i < MAX_PAGES; i += 1) {
					const page = await this.api.getDelta(accessToken, cursor);
					if (page.deltaLink) {
						return page.deltaLink;
					}
					if (page.nextLink) {
						cursor = page.nextLink;
						continue;
					}
					return null;
				}
				return null;
			});
			newDeltaLink = recoveredLink;
		}

		// Advance the cursor — even on token-expired we move forward so the next push
		// doesn't re-trip the same 410. Never write null over an existing cursor.
		if (newDeltaLink) {
			await this.prisma.emailAccount.update({
				where: { id: emailAccountId },
				data: { deltaLink: newDeltaLink }
			});
		}

		this.logService.logAction({
			action: 'email.delta_sync.completed',
			message: `Delta sync complete for ${account.email}: ${pagesFetched} pages, ${messagesInserted} new, ${messagesSkipped} already present`,
			metadata: {
				provider: account.provider,
				emailAccountId,
				pagesFetched,
				messagesInserted,
				messagesSkipped,
				deltaTokenExpired
			},
			context: 'MicrosoftDeltaSyncService'
		});

		return {
			emailAccountId,
			pagesFetched,
			messagesInserted,
			messagesSkipped,
			deltaLink: newDeltaLink,
			deltaTokenExpired
		};
	}

	/**
	 * Mirrors `MicrosoftBackfillService.persistBatch`. Same find-existing-then-createMany
	 * shape; deduplicated from backfill rather than shared because the two services
	 * may diverge later (e.g. delta-sync emitting `RawMessage.created` events for W4's
	 * AI extractor while backfill batches stay quiet).
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
