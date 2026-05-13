import { MailboxUnauthorizedException } from '@/lib/oauth/oauth-errors';
import { GMAIL_API_BASE } from '@/modules/gmail/gmail.constants';
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';

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
 * Minimal Gmail v1 client. Direct fetch wrappers — no `googleapis` dep.
 *
 * 401 handling: every method throws `MailboxUnauthorizedException` on a 401 so the caller
 * (typically `EmailAccountsService.withFreshAccessToken`) can force a token refresh +
 * retry exactly once. Other non-2xx responses bubble as a generic 500.
 */
@Injectable()
export class GmailApiService {
	private readonly logger = new Logger(GmailApiService.name);

	/** List the N most recent message IDs (W3.1 smoke). No filter, no pagination. */
	async listRecentMessages(accessToken: string, maxResults: number): Promise<GmailMessageStub[]> {
		const url = `${GMAIL_API_BASE}/users/me/messages?maxResults=${maxResults}`;
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
	 */
	async getMessageFull(accessToken: string, id: string): Promise<GmailFullMessage> {
		const url = `${GMAIL_API_BASE}/users/me/messages/${id}?format=full`;
		return this.fetchOne<GmailFullMessage>(accessToken, url, 'messages.get(full)');
	}

	/**
	 * Fetch the mailbox profile. Cheapest way to grab the current `historyId` after a
	 * backfill so W3.5 push notifications know where to start delta sync. Quota cost: 1.
	 */
	async getProfile(accessToken: string): Promise<GmailProfile> {
		const url = `${GMAIL_API_BASE}/users/me/profile`;
		return this.fetchOne<GmailProfile>(accessToken, url, 'getProfile');
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
			this.logger.error(`messages.list failed: ${response.status} ${text}`);
			throw new InternalServerErrorException('Gmail API messages.list failed');
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
			this.logger.error(`${opName} failed: ${response.status} ${text}`);
			throw new InternalServerErrorException(`Gmail API ${opName} failed`);
		}

		return (await response.json()) as T;
	}
}
