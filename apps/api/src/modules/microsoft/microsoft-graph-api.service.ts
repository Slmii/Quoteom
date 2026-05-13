import { MailboxUnauthorizedException } from '@/lib/oauth/oauth-errors';
import { MICROSOFT_GRAPH_BASE } from '@/modules/microsoft/microsoft.constants';
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';

export interface MicrosoftMessageStub {
	id: string;
	conversationId: string;
}

export interface MicrosoftMessageMetadata extends MicrosoftMessageStub {
	receivedDateTime: string;
	subject: string | null;
	from: { name: string | null; address: string } | null;
	bodyPreview: string;
}

/**
 * Microsoft Graph v1 `messages` payload — superset of the metadata fields plus full
 * MIME body. Persisted as-is into `RawMessage.raw` so the W4 extractor can walk the
 * structure without a fresh Graph call.
 */
export interface MicrosoftFullMessage {
	id: string;
	conversationId: string;
	internetMessageId?: string;
	receivedDateTime: string;
	subject: string | null;
	bodyPreview: string;
	from?: { emailAddress?: { name?: string | null; address?: string | null } | null } | null;
	toRecipients?: Array<{ emailAddress?: { name?: string | null; address?: string | null } | null }>;
	body?: { contentType?: 'text' | 'html'; content?: string };
	[key: string]: unknown;
}

export interface MicrosoftListPage {
	messages: MicrosoftFullMessage[];
	/** Present when there's another page. Pass back as `nextLink` to fetch it. */
	nextLink: string | null;
}

export interface MicrosoftProfile {
	id: string;
	mail: string | null;
	userPrincipalName: string;
	displayName?: string | null;
}

/**
 * Minimal Microsoft Graph client. Direct fetch wrappers — no Graph SDK dep.
 *
 * 401 handling: every method throws `MailboxUnauthorizedException` on a 401 so the caller
 * (typically `EmailAccountsService.withFreshAccessToken`) can force a token refresh +
 * retry exactly once. Same shape as `GmailApiService`.
 *
 * Pagination model differs from Gmail's: Graph returns a full `@odata.nextLink` URL
 * (already including query parameters) — we just fetch it as-is.
 */
@Injectable()
export class MicrosoftGraphApiService {
	private readonly logger = new Logger(MicrosoftGraphApiService.name);

	/**
	 * List the N most recent inbox messages (W3.2 smoke). Uses `$top` + `$select` to
	 * pull only the fields we need for the smoke list.
	 */
	async listRecentInboxMessages(accessToken: string, top: number): Promise<MicrosoftMessageMetadata[]> {
		const url = `${MICROSOFT_GRAPH_BASE}/me/mailFolders/Inbox/messages?$top=${top}&$select=id,conversationId,subject,from,receivedDateTime,bodyPreview&$orderby=receivedDateTime desc`;
		const page = await this.fetchListUrl(accessToken, url);
		return page.messages.map(m => ({
			id: m.id,
			conversationId: m.conversationId,
			receivedDateTime: m.receivedDateTime,
			subject: m.subject ?? null,
			from: extractFrom(m),
			bodyPreview: m.bodyPreview
		}));
	}

	/**
	 * Paginated list with `$filter` for date filtering (`receivedDateTime ge ISO`).
	 * Used by the W3.2 backfill — repeatedly call with the previous response's
	 * `nextLink` until it comes back `null`.
	 *
	 * Returns the full message payload (no separate `messages.get` round trip) — Graph
	 * lets us request the body up front via `$select`, which avoids the 100 individual
	 * GET calls per page that Gmail's API requires. Cheaper + faster.
	 */
	async listInboxMessagesPage(
		accessToken: string,
		opts: { filter?: string; top?: number; nextLink?: string }
	): Promise<MicrosoftListPage> {
		if (opts.nextLink) {
			// Graph's nextLink is fully-formed including query params. Use it as-is.
			return this.fetchListUrl(accessToken, opts.nextLink);
		}
		const params = new URLSearchParams();
		params.set('$top', String(opts.top ?? 50));
		params.set(
			'$select',
			'id,conversationId,internetMessageId,subject,from,toRecipients,receivedDateTime,bodyPreview,body'
		);
		params.set('$orderby', 'receivedDateTime desc');
		if (opts.filter) {
			params.set('$filter', opts.filter);
		}
		const url = `${MICROSOFT_GRAPH_BASE}/me/mailFolders/Inbox/messages?${params.toString()}`;
		return this.fetchListUrl(accessToken, url);
	}

	/** Fetch the current user's mailbox profile. Used to record the connected email. */
	async getProfile(accessToken: string): Promise<MicrosoftProfile> {
		const url = `${MICROSOFT_GRAPH_BASE}/me`;
		return this.fetchOne<MicrosoftProfile>(accessToken, url, 'me');
	}

	private async fetchListUrl(accessToken: string, url: string): Promise<MicrosoftListPage> {
		const response = await fetch(url, {
			headers: { authorization: `Bearer ${accessToken}` }
		});

		if (response.status === 401) {
			throw new MailboxUnauthorizedException();
		}

		if (!response.ok) {
			const text = await response.text();
			this.logger.error(`messages.list failed: ${response.status} ${text}`);
			throw new InternalServerErrorException('Microsoft Graph messages.list failed');
		}

		const data = (await response.json()) as {
			value: MicrosoftFullMessage[];
			'@odata.nextLink'?: string;
		};

		return {
			messages: data.value ?? [],
			nextLink: data['@odata.nextLink'] ?? null
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
			throw new InternalServerErrorException(`Microsoft Graph ${opName} failed`);
		}

		return (await response.json()) as T;
	}
}

function extractFrom(m: MicrosoftFullMessage): MicrosoftMessageMetadata['from'] {
	const addr = m.from?.emailAddress;
	if (!addr?.address) {
		return null;
	}
	return { name: addr.name ?? null, address: addr.address };
}
