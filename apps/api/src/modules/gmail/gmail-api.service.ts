import { GMAIL_API_CALL_FAILED } from '@/lib/errors';
import { MailboxUnauthorizedException } from '@/lib/oauth/oauth-errors';
import { GMAIL_API_BASE } from '@/modules/gmail/gmail.constants';
import { LogService } from '@/modules/logger/log.service';
import { Injectable, InternalServerErrorException } from '@nestjs/common';

export interface GmailMessageHeader {
	name: string;
	value: string;
}

export interface GmailMessageStub {
	id: string;
	threadId: string;
}

export interface GmailMessageMetadata extends GmailMessageStub {
	internalDate: string;
	snippet: string;
	subject: string | null;
	from: string | null;
}

/**
 * Gmail v1 `users.messages.get` payload — full JSON shape with headers + (optional)
 * MIME body parts. We persist this as-is in `RawMessage.raw` so the W4 extractor can
 * walk the structure later without re-fetching from Google.
 */
export interface GmailFullMessage {
	id: string;
	threadId: string;
	internalDate: string;
	snippet: string;
	historyId?: string;
	labelIds?: string[];
	payload?: {
		headers?: GmailMessageHeader[];
		mimeType?: string;
		body?: { data?: string; size?: number };
		parts?: unknown[];
	};
	[key: string]: unknown;
}

export interface GmailListPage {
	messages: GmailMessageStub[];
	/** Present when there's another page. Pass back as `pageToken` to fetch it. */
	nextPageToken: string | null;
	/** Approximate count of messages matching the query. Just for logging. */
	resultSizeEstimate: number;
}

export interface GmailProfile {
	emailAddress: string;
	messagesTotal: number;
	threadsTotal: number;
	/** Monotonically-increasing cursor for delta sync (W3.5). */
	historyId: string;
}

/**
 * One entry from `users.history.list`. `messagesAdded` is the only field we use today —
 * `messagesDeleted` / `labelsAdded` / `labelsRemoved` are also returned but ignored.
 * Defer if we ever need to track read-state changes (probably never for Quoteom).
 */
export interface GmailHistoryRecord {
	id: string;
	messagesAdded?: { message: GmailMessageStub }[];
}

export interface GmailHistoryPage {
	history: GmailHistoryRecord[];
	/** Present when there's another page. */
	nextPageToken: string | null;
	/** Mailbox's current historyId at the time of the response. Used to advance the cursor. */
	historyId: string;
}

/**
 * Thrown when Gmail returns 404 from `users.history.list` because the requested
 * `startHistoryId` is too old (Gmail retains only ~7 days of history). Recovery path:
 * trigger a fresh backfill so we re-acquire a current cursor.
 */
export class GmailHistoryExpiredException extends Error {
	constructor(message = 'Gmail history cursor expired (>7 days old)') {
		super(message);
		this.name = 'GmailHistoryExpiredException';
	}
}

export interface GmailWatchResponse {
	historyId: string;
	/** Epoch milliseconds (as a string per Gmail's API). Typically ~7 days in the future. */
	expiration: string;
}

/**
 * Minimal Gmail v1 client. Direct fetch wrappers — no `googleapis` dep.
 *
 * 401 handling: every method throws `MailboxUnauthorizedException` on a 401 so the caller
 * (typically `EmailAccountsService.withFreshAccessToken`) can force a token refresh +
 * retry exactly once. Other non-2xx responses bubble as a generic 500.
 */
@Injectable()
export class GmailApiService {
	constructor(private readonly logService: LogService) {}

	/** Persist a low-level HTTP failure with structured context. Used by every method below
	 * before throwing the generic 500 so the audit trail has the actual failure detail.
	 */
	private logApiError(operation: string, status: number, body: string): void {
		this.logService.logAction({
			action: 'gmail.api.error',
			message: `Gmail API ${operation} failed: HTTP ${status}`,
			metadata: { operation, status, body: body.slice(0, 500) },
			level: 'error',
			context: 'GmailApiService'
		});
	}

	/**
	 * List the N most recent INBOX message IDs. Used by the `/settings/email` recent-list
	 * UI. Scoped to INBOX via `labelIds=INBOX` so Sent / Drafts / Spam never appear in the
	 * preview — matches the backfill (`q=in:inbox`), watch (`labelIds: ['INBOX']`), and
	 * history walk (`labelId=INBOX`) so all four ingestion + display paths see the same
	 * slice of the mailbox.
	 *
	 * Renamed from `listRecentMessages` (the W3.1 smoke leftover with no filter) — the
	 * old name was misleading and produced UI lists that didn't match `RawMessage` rows.
	 */
	async listRecentInboxMessages(accessToken: string, maxResults: number): Promise<GmailMessageStub[]> {
		const params = new URLSearchParams();
		params.set('maxResults', String(maxResults));
		params.set('labelIds', 'INBOX');
		const url = `${GMAIL_API_BASE}/users/me/messages?${params.toString()}`;
		return (await this.fetchMessagesList(accessToken, url)).messages;
	}

	/**
	 * Paginated list with optional Gmail search query (`q`) and `pageToken`. Used by the
	 * W3.4 backfill — repeatedly call with the previous response's `nextPageToken` until
	 * it comes back `null`.
	 *
	 * Gmail's max `maxResults` is 500. Default 100 is fine; bigger pages don't reduce
	 * total quota cost (per-page is 5 units regardless of size) but do reduce wall-clock.
	 */
	async listMessagesPage(
		accessToken: string,
		opts: { q?: string; pageToken?: string; maxResults?: number } = {}
	): Promise<GmailListPage> {
		const params = new URLSearchParams();
		params.set('maxResults', String(opts.maxResults ?? 100));
		if (opts.q) {
			params.set('q', opts.q);
		}
		if (opts.pageToken) {
			params.set('pageToken', opts.pageToken);
		}
		const url = `${GMAIL_API_BASE}/users/me/messages?${params.toString()}`;
		return this.fetchMessagesList(accessToken, url);
	}

	/**
	 * Fetch metadata for one message. `format=metadata` keeps the response small —
	 * we only need a few headers (subject, from) and the snippet for the smoke UI.
	 */
	async getMessageMetadata(accessToken: string, id: string): Promise<GmailMessageMetadata> {
		const url = `${GMAIL_API_BASE}/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`;
		const data = await this.fetchOne<{
			id: string;
			threadId: string;
			internalDate: string;
			snippet: string;
			payload?: { headers?: GmailMessageHeader[] };
		}>(accessToken, url, 'messages.get(metadata)');

		const headers = data.payload?.headers ?? [];
		const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value ?? null;
		const from = headers.find(h => h.name.toLowerCase() === 'from')?.value ?? null;

		return {
			id: data.id,
			threadId: data.threadId,
			internalDate: data.internalDate,
			snippet: data.snippet,
			subject,
			from
		};
	}

	/**
	 * Fetch the full message payload — headers + MIME body parts. Persisted into
	 * `RawMessage.raw` by the W3.4 backfill so the W4 AI extractor can walk the structure
	 * without a fresh Google call.
	 *
	 * Quota cost is identical to `format=metadata` (5 units) — Google doesn't charge more
	 * for a bigger response. We pay in bandwidth instead.
	 *
	 * Returns `null` on 404. Real scenario: between Gmail firing a history notification
	 * and our delta-sync fetching the message, the user deletes it. Without this branch
	 * the 404 would crash the whole batch, exhaust Inngest retries, and leave the
	 * `EmailAccount.historyId` cursor permanently stuck at that delete point. Skipping
	 * the deleted message keeps the cursor moving and the rest of the batch intact.
	 */
	async getMessageFull(accessToken: string, id: string): Promise<GmailFullMessage | null> {
		const url = `${GMAIL_API_BASE}/users/me/messages/${id}?format=full`;
		const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });

		if (response.status === 401) {
			throw new MailboxUnauthorizedException();
		}
		if (response.status === 404) {
			return null;
		}
		if (!response.ok) {
			const text = await response.text();
			this.logApiError('messages.get(full)', response.status, text);
			throw new InternalServerErrorException(GMAIL_API_CALL_FAILED('messages.get(full)'));
		}

		return (await response.json()) as GmailFullMessage;
	}

	/**
	 * Fetch the mailbox profile. Cheapest way to grab the current `historyId` after a
	 * backfill so W3.5 push notifications know where to start delta sync. Quota cost: 1.
	 */
	async getProfile(accessToken: string): Promise<GmailProfile> {
		const url = `${GMAIL_API_BASE}/users/me/profile`;
		return this.fetchOne<GmailProfile>(accessToken, url, 'getProfile');
	}

	/**
	 * Walk the history since a previously-stored cursor. Used by the W3.5 push-handler's
	 * delta-sync — for each `messagesAdded` entry, we then `getMessageFull` to fetch the
	 * payload and persist a `RawMessage`.
	 *
	 * Gmail only retains ~7 days of history. If `startHistoryId` is older we get a 404
	 * with `errors[0].reason = 'notFound'`. We surface this as `GmailHistoryExpiredException`
	 * so the caller can fall back to a fresh backfill instead of a half-broken sync.
	 *
	 * Two server-side filters keep the payload tight and the corpus consistent with
	 * backfill (`q=after:... in:inbox`) + watch (`labelIds: ['INBOX']`):
	 *  - `historyTypes=messageAdded` — we don't process label changes or deletions, asking
	 *    only for what we use keeps the response small.
	 *  - `labelId=INBOX` — defense in depth. Even if a push slips through for a non-INBOX
	 *    event (Gmail's labelIds filter on watch isn't always tight in practice — e.g. a
	 *    Sent item that gets a label added while INBOX is also briefly touched), we never
	 *    ingest Sent/Drafts/Spam messages here. Keeps `RawMessage` strictly inbox-scoped.
	 */
	async listHistoryPage(
		accessToken: string,
		opts: { startHistoryId: string; pageToken?: string; maxResults?: number }
	): Promise<GmailHistoryPage> {
		const params = new URLSearchParams();
		params.set('startHistoryId', opts.startHistoryId);
		params.set('historyTypes', 'messageAdded');
		params.set('labelId', 'INBOX');
		if (opts.pageToken) {
			params.set('pageToken', opts.pageToken);
		}
		if (opts.maxResults) {
			params.set('maxResults', String(opts.maxResults));
		}
		const url = `${GMAIL_API_BASE}/users/me/history?${params.toString()}`;

		const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });

		if (response.status === 401) {
			throw new MailboxUnauthorizedException();
		}
		if (response.status === 404) {
			// startHistoryId older than Gmail's ~7-day retention window. Caller must
			// re-establish a cursor (typically by re-backfilling).
			throw new GmailHistoryExpiredException();
		}
		if (!response.ok) {
			const text = await response.text();
			this.logApiError('history.list', response.status, text);
			throw new InternalServerErrorException(GMAIL_API_CALL_FAILED('history.list'));
		}

		const data = (await response.json()) as {
			history?: GmailHistoryRecord[];
			nextPageToken?: string;
			historyId: string;
		};

		return {
			history: data.history ?? [],
			nextPageToken: data.nextPageToken ?? null,
			historyId: data.historyId
		};
	}

	/**
	 * Start a Pub/Sub push subscription for this mailbox. Gmail delivers a notification
	 * to the configured Pub/Sub topic whenever the mailbox changes; the topic forwards
	 * to our HTTPS webhook.
	 *
	 * `labelIds: ['INBOX']` scopes the trigger to inbox-bound mail only — outgoing mail,
	 * drafts, etc. don't fire pushes. Matches the backfill's `in:inbox` filter so the
	 * push + backfill corpora stay consistent.
	 *
	 * Watch subscriptions expire after 7 days. The renewal cron re-calls this method on
	 * any row with `watchExpiresAt < NOW() + 24h`.
	 */
	async startWatch(accessToken: string, topicName: string): Promise<GmailWatchResponse> {
		const url = `${GMAIL_API_BASE}/users/me/watch`;
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${accessToken}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				topicName,
				labelIds: ['INBOX']
			})
		});

		if (response.status === 401) {
			throw new MailboxUnauthorizedException();
		}
		if (!response.ok) {
			const text = await response.text();
			this.logApiError('users.watch', response.status, text);
			throw new InternalServerErrorException(GMAIL_API_CALL_FAILED('users.watch'));
		}

		return (await response.json()) as GmailWatchResponse;
	}

	/**
	 * Stop the Pub/Sub push subscription. Best-effort — used by disconnect. Gmail
	 * returns 204 No Content on success.
	 */
	async stopWatch(accessToken: string): Promise<void> {
		const url = `${GMAIL_API_BASE}/users/me/stop`;
		const response = await fetch(url, {
			method: 'POST',
			headers: { authorization: `Bearer ${accessToken}` }
		});

		if (response.status === 401) {
			throw new MailboxUnauthorizedException();
		}
		if (!response.ok && response.status !== 204) {
			const text = await response.text();
			this.logApiError('users.stop', response.status, text);
			throw new InternalServerErrorException(GMAIL_API_CALL_FAILED('users.stop'));
		}
	}

	private async fetchMessagesList(accessToken: string, url: string): Promise<GmailListPage> {
		const response = await fetch(url, {
			headers: { authorization: `Bearer ${accessToken}` }
		});

		if (response.status === 401) {
			throw new MailboxUnauthorizedException();
		}

		if (!response.ok) {
			const text = await response.text();
			this.logApiError('messages.list', response.status, text);
			throw new InternalServerErrorException(GMAIL_API_CALL_FAILED('messages.list'));
		}

		const data = (await response.json()) as {
			messages?: GmailMessageStub[];
			nextPageToken?: string;
			resultSizeEstimate?: number;
		};

		return {
			messages: data.messages ?? [],
			nextPageToken: data.nextPageToken ?? null,
			resultSizeEstimate: data.resultSizeEstimate ?? 0
		};
	}

	private async fetchOne<T>(accessToken: string, url: string, opName: string): Promise<T> {
		const response = await fetch(url, {
			headers: { authorization: `Bearer ${accessToken}` }
		});

		if (response.status === 401) {
			throw new MailboxUnauthorizedException();
		}

		if (!response.ok) {
			const text = await response.text();
			this.logApiError(opName, response.status, text);
			throw new InternalServerErrorException(`Gmail API ${opName} failed`);
		}

		return (await response.json()) as T;
	}
}
