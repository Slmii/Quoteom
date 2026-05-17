import { MICROSOFT_GRAPH_API_CALL_FAILED } from '@/lib/errors';
import { MailboxUnauthorizedException } from '@/lib/oauth/oauth-errors';
import { MICROSOFT_GRAPH_BASE } from '@/modules/microsoft/microsoft.constants';
import { LogService } from '@/modules/logger/log.service';
import { Injectable, InternalServerErrorException } from '@nestjs/common';

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
 * One page of `/me/messages/delta` results.
 *
 * Graph's delta endpoint returns either:
 *  - `@odata.nextLink` — mid-walk, pass back to fetch the next page
 *  - `@odata.deltaLink` — end of walk, save this as the cursor for the next call
 *
 * Exactly one of the two is present on any given response (per Graph spec). We surface
 * both as nullable so the caller can branch.
 */
export interface MicrosoftDeltaPage {
	messages: MicrosoftFullMessage[];
	nextLink: string | null;
	deltaLink: string | null;
}

/**
 * Thrown when Graph returns 410 Gone on a delta query — means our stored `deltaLink`
 * has aged out (Graph retains them for ~30 days but reserves the right to invalidate
 * earlier). Recovery: re-acquire via a fresh `/me/messages/delta` (without a cursor),
 * which gives us a new starting point. Parallel to `GmailHistoryExpiredException`.
 */
export class MicrosoftDeltaTokenExpiredException extends Error {
	constructor(message = 'Microsoft Graph deltaLink expired (>30 days or invalidated)') {
		super(message);
		this.name = 'MicrosoftDeltaTokenExpiredException';
	}
}

/**
 * Thrown when Graph returns 404 on a `/subscriptions/{id}` PATCH or DELETE — means the
 * subscription was already deleted upstream (user revoked Quoteom, Graph aged it out, or
 * it never registered). Lets the renewal flow recover by recreating instead of bubbling
 * a generic InternalServerErrorException that the duck-typed sniffer would catch with
 * false positives.
 */
export class MicrosoftSubscriptionNotFoundException extends Error {
	constructor(subscriptionId: string) {
		super(`Microsoft Graph subscription not found: ${subscriptionId}`);
		this.name = 'MicrosoftSubscriptionNotFoundException';
	}
}

/** Body shape Graph requires when creating a subscription. */
export interface CreateSubscriptionParams {
	notificationUrl: string;
	expirationDateTime: string; // ISO 8601 — max ~4230 minutes from now for `messages`
	clientState: string;
	/**
	 * Graph resource to watch. Defaults to `/me/mailFolders/Inbox/messages` so we ONLY
	 * receive pushes for inbox arrivals. Without the folder scope, the default `/me/messages`
	 * fires for Sent items, drafts, Junk, etc. — wasteful (the downstream delta walk is
	 * Inbox-scoped anyway, so non-INBOX pushes wake the pipeline only to discard the
	 * result) and confusing in the Inngest UI.
	 */
	resource?: string;
}

/**
 * Subscription resource shape from Graph. We pull only the fields we persist; Graph
 * returns more (resource, changeType, etc.) but we don't need them downstream.
 */
export interface MicrosoftSubscription {
	id: string;
	expirationDateTime: string;
	clientState?: string;
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
	constructor(private readonly logService: LogService) {}

	private logApiError(operation: string, status: number, body: string): void {
		this.logService.logAction({
			action: 'microsoft.graph.api.error',
			message: `Microsoft Graph ${operation} failed: HTTP ${status}`,
			metadata: { operation, status, body: body.slice(0, 500) },
			level: 'error',
			context: 'MicrosoftGraphApiService'
		});
	}

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

	/**
	 * Walk `/me/messages/delta` from a stored `deltaLink`, OR start a fresh delta walk if
	 * no cursor exists yet. Used by the W3.6 push-handler's delta-sync.
	 *
	 * Three modes by `cursor` shape:
	 *  - `null` / undefined: start fresh — Graph returns a `deltaLink` immediately for an
	 *    empty inbox, or a `nextLink` to paginate through current state.
	 *  - A `@odata.nextLink` URL: mid-walk pagination.
	 *  - A `@odata.deltaLink` URL: changes since the last walk completed.
	 *
	 * Graph returns 410 Gone when the cursor has expired (~30 day retention). We surface
	 * this as `MicrosoftDeltaTokenExpiredException` so the caller can re-acquire by
	 * calling again with no cursor.
	 *
	 * `$select` requests the same fields as backfill so the persisted RawMessage rows
	 * have a consistent payload shape regardless of which path created them.
	 */
	async getDelta(accessToken: string, cursor: string | null = null): Promise<MicrosoftDeltaPage> {
		const url = cursor ?? this.buildInitialDeltaUrl();
		const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });

		if (response.status === 401) {
			throw new MailboxUnauthorizedException();
		}
		if (response.status === 410) {
			throw new MicrosoftDeltaTokenExpiredException();
		}
		if (!response.ok) {
			const text = await response.text();
			this.logApiError('messages.delta', response.status, text);
			throw new InternalServerErrorException(MICROSOFT_GRAPH_API_CALL_FAILED('messages.delta'));
		}

		const data = (await response.json()) as {
			value?: MicrosoftFullMessage[];
			'@odata.nextLink'?: string;
			'@odata.deltaLink'?: string;
		};

		return {
			messages: data.value ?? [],
			nextLink: data['@odata.nextLink'] ?? null,
			deltaLink: data['@odata.deltaLink'] ?? null
		};
	}

	/**
	 * Create a Graph subscription for inbox `created` notifications. The caller passes a
	 * freshly-generated `clientState` (stored encrypted on our side), which Graph echoes
	 * back on every push delivery so we can authenticate them.
	 *
	 * Resource defaults to `/me/mailFolders/Inbox/messages` — scopes pushes to inbox
	 * arrivals only, matching the backfill, recent-list, and delta walk so all four
	 * ingestion + display paths see the same INBOX-only slice of the mailbox. Both the
	 * OData "function-call" form (`/me/mailFolders('Inbox')/messages`) and the modern
	 * "key-as-segment" form used here are accepted by Graph; we standardize on the
	 * segment form for codebase consistency.
	 *
	 * Graph's expiration ceiling for messages is ~4230 minutes (~2.94 days). The caller
	 * computes the desired expiration and passes it in; Graph rejects out-of-bounds values
	 * with 400.
	 *
	 * Validation gotcha (W3.6 staged plan): Graph synchronously calls `notificationUrl`
	 * with `?validationToken=<random>` during this POST and expects the plaintext echoed
	 * back within ~5 seconds. The webhook handler MUST short-circuit on that query param
	 * before any auth/parsing logic, or subscription creation fails outright with 400 here.
	 */
	async createSubscription(accessToken: string, params: CreateSubscriptionParams): Promise<MicrosoftSubscription> {
		const url = `${MICROSOFT_GRAPH_BASE}/subscriptions`;
		const body = {
			changeType: 'created',
			notificationUrl: params.notificationUrl,
			resource: params.resource ?? '/me/mailFolders/Inbox/messages',
			expirationDateTime: params.expirationDateTime,
			clientState: params.clientState
		};

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${accessToken}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify(body)
		});

		if (response.status === 401) {
			throw new MailboxUnauthorizedException();
		}
		if (!response.ok) {
			const text = await response.text();
			this.logApiError('subscriptions.create', response.status, text);
			throw new InternalServerErrorException(MICROSOFT_GRAPH_API_CALL_FAILED('subscriptions.create'));
		}

		return (await response.json()) as MicrosoftSubscription;
	}

	/**
	 * Renew an existing subscription by pushing its `expirationDateTime` further out.
	 * Graph's renewal is a PATCH (vs Gmail's "call users.watch again" idempotent shape).
	 *
	 * If the subscription was already deleted upstream (user revoked our app at
	 * account.microsoft.com, or it aged out), Graph returns 404. Caller decides whether
	 * to recreate or log + drop.
	 */
	async renewSubscription(
		accessToken: string,
		subscriptionId: string,
		expirationDateTime: string
	): Promise<MicrosoftSubscription> {
		const url = `${MICROSOFT_GRAPH_BASE}/subscriptions/${subscriptionId}`;
		const response = await fetch(url, {
			method: 'PATCH',
			headers: {
				authorization: `Bearer ${accessToken}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({ expirationDateTime })
		});

		if (response.status === 401) {
			throw new MailboxUnauthorizedException();
		}
		if (response.status === 404) {
			throw new MicrosoftSubscriptionNotFoundException(subscriptionId);
		}
		if (!response.ok) {
			const text = await response.text();
			this.logApiError('subscriptions.renew', response.status, text);
			throw new InternalServerErrorException(MICROSOFT_GRAPH_API_CALL_FAILED('subscriptions.renew'));
		}

		return (await response.json()) as MicrosoftSubscription;
	}

	/**
	 * Delete a subscription. Best-effort — caller decides whether to throw on 404 (the
	 * subscription was already gone) or treat as "already disconnected, fine."
	 */
	async deleteSubscription(accessToken: string, subscriptionId: string): Promise<void> {
		const url = `${MICROSOFT_GRAPH_BASE}/subscriptions/${subscriptionId}`;
		const response = await fetch(url, {
			method: 'DELETE',
			headers: { authorization: `Bearer ${accessToken}` }
		});

		if (response.status === 401) {
			throw new MailboxUnauthorizedException();
		}
		if (response.status === 404) {
			// Already gone — caller can treat as success.
			return;
		}
		if (!response.ok && response.status !== 204) {
			const text = await response.text();
			this.logApiError('subscriptions.delete', response.status, text);
			throw new InternalServerErrorException(MICROSOFT_GRAPH_API_CALL_FAILED('subscriptions.delete'));
		}
	}

	private buildInitialDeltaUrl(): string {
		const params = new URLSearchParams();
		params.set(
			'$select',
			'id,conversationId,internetMessageId,subject,from,toRecipients,receivedDateTime,bodyPreview,body'
		);
		return `${MICROSOFT_GRAPH_BASE}/me/mailFolders/Inbox/messages/delta?${params.toString()}`;
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
			this.logApiError('messages.list', response.status, text);
			throw new InternalServerErrorException(MICROSOFT_GRAPH_API_CALL_FAILED('messages.list'));
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
			this.logApiError(opName, response.status, text);
			throw new InternalServerErrorException(MICROSOFT_GRAPH_API_CALL_FAILED(opName));
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
