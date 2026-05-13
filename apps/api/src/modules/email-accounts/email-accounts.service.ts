import { EmailProvider } from '@/generated/prisma/enums';
import { decrypt, encrypt } from '@/lib/crypto/token-encryption';
import { EMAIL_ACCOUNT_NOT_FOUND } from '@/lib/errors';
import { MailboxUnauthorizedException, OAuthRefreshTokenInvalidException } from '@/lib/oauth/oauth-errors';
import { GoogleOAuthService, type TokenSet as GoogleTokenSet } from '@/modules/email-accounts/google-oauth.service';
import { inngest } from '@/modules/inngest/inngest.client';
import { InngestEvents } from '@/modules/inngest/inngest.constants';
import { MicrosoftOAuthService, type TokenSet as MicrosoftTokenSet } from '@/modules/email-accounts/microsoft-oauth.service';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';

/**
 * Refresh tokens that are within this window of expiring are refreshed proactively
 * BEFORE a call. Tighter than the access token's full TTL so we don't fail an API call
 * mid-flight when the token expires while the request is in flight.
 */
const REFRESH_HEAD_START_MS = 60_000;

/** Common shape from any provider's OAuth service. */
type ProviderTokenSet = GoogleTokenSet | MicrosoftTokenSet;

interface UpsertInput {
	provider: EmailProvider;
	organizationId: string;
	userId: string;
	providerAccountId: string;
	email: string;
	tokens: ProviderTokenSet;
}

/** Identifies which connected mailbox a caller is talking about. */
export interface MailboxScope {
	provider: EmailProvider;
	organizationId: string;
	userId: string;
}

/**
 * Owns the EmailAccount Prisma row + the encrypt-on-write / decrypt-on-read invariant
 * for every mail provider (Gmail today, Microsoft Graph in W3.2). Every method is keyed
 * on `(provider, organizationId, userId)` — each user manages their own mailbox per
 * provider inside an org; members can't see/disconnect each other's mailboxes.
 *
 * Provider-specific behavior (refresh, revoke, refresh-token rotation) is dispatched to
 * the appropriate OAuth service via the private `oauthFor()` resolver. The Prisma layer
 * and the encryption layer are 100% provider-agnostic.
 */
@Injectable()
export class EmailAccountsService {
	private readonly logger = new Logger(EmailAccountsService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly google: GoogleOAuthService,
		private readonly microsoft: MicrosoftOAuthService
	) {}

	private oauthFor(provider: EmailProvider): GoogleOAuthService | MicrosoftOAuthService {
		switch (provider) {
			case EmailProvider.GMAIL:
				return this.google;
			case EmailProvider.MICROSOFT:
				return this.microsoft;
		}
	}

	/**
	 * Emit the matching `<provider>/account.connected` event. Fire-and-forget — failed
	 * enqueue is logged but does not fail the connect handshake.
	 */
	private async emitConnectedEvent(provider: EmailProvider, emailAccountId: string): Promise<void> {
		const name =
			provider === EmailProvider.GMAIL
				? InngestEvents.GmailAccountConnected
				: InngestEvents.MicrosoftAccountConnected;
		try {
			await inngest.send({ name, data: { emailAccountId } });
		} catch (error) {
			this.logger.error(
				`Failed to enqueue backfill for ${emailAccountId}: ${error instanceof Error ? error.message : 'unknown'}`
			);
		}
	}

	/**
	 * Persist a freshly-completed OAuth handshake. Upserts on
	 * `(organizationId, provider, providerAccountId)` so reconnecting the same mailbox
	 * inside the same org replaces the old tokens rather than duplicating the row.
	 *
	 * **Refresh-token handling differs by provider:**
	 *  - Gmail: refresh_token typically not re-issued on subsequent consents. We fall
	 *    back to the existing encrypted value if the new exchange didn't include one.
	 *  - Microsoft: refresh_token rotates on every exchange. Always trust the new one.
	 *
	 * Either way, the stored ciphertext is `v1:<base64(iv ‖ tag ‖ ct)>`.
	 */
	async upsertEmailAccount(input: UpsertInput): Promise<{ id: string }> {
		const existing = await this.prisma.emailAccount.findUnique({
			where: {
				organizationId_provider_providerAccountId: {
					organizationId: input.organizationId,
					provider: input.provider,
					providerAccountId: input.providerAccountId
				}
			}
		});

		const refreshTokenCipher = input.tokens.refreshToken
			? encrypt(input.tokens.refreshToken)
			: (existing?.refreshToken ?? null);

		if (!refreshTokenCipher) {
			throw new Error('No refresh token in token exchange response and no existing one on file');
		}

		const data = {
			email: input.email,
			scope: input.tokens.scope,
			accessToken: encrypt(input.tokens.accessToken),
			refreshToken: refreshTokenCipher,
			accessTokenExpiresAt: input.tokens.expiresAt,
			userId: input.userId
		};

		const row = await this.prisma.emailAccount.upsert({
			where: {
				organizationId_provider_providerAccountId: {
					organizationId: input.organizationId,
					provider: input.provider,
					providerAccountId: input.providerAccountId
				}
			},
			create: {
				organizationId: input.organizationId,
				provider: input.provider,
				providerAccountId: input.providerAccountId,
				...data
			},
			update: data,
			select: { id: true }
		});

		this.logger.log(
			`${input.provider} ${input.email} connected to org ${input.organizationId} by user ${input.userId}`
		);

		await this.emitConnectedEvent(input.provider, row.id);

		return row;
	}

	/**
	 * Return THIS user's connected mailbox for the given provider, or null.
	 *
	 * **Side effect:** if the stored access token has already expired (we'd need to
	 * refresh anyway on the next API call), proactively attempt a refresh. If the
	 * provider rejects with `invalid_grant` we delete the row and return null — so the
	 * status endpoint correctly reports "not connected" instead of staying stuck on
	 * stale state after a user revokes our app upstream.
	 */
	async findEmailAccount(scope: MailboxScope) {
		const row = await this.prisma.emailAccount.findFirst({
			where: {
				organizationId: scope.organizationId,
				userId: scope.userId,
				provider: scope.provider
			}
		});
		if (!row) {
			return null;
		}

		const expiresAt = row.accessTokenExpiresAt;
		const isFresh = expiresAt && expiresAt.getTime() - Date.now() > REFRESH_HEAD_START_MS;

		if (!isFresh) {
			try {
				await this.getAccessToken(scope);
			} catch (error) {
				if (error instanceof NotFoundException) {
					return null;
				}
				throw error;
			}
		}

		return this.prisma.emailAccount.findFirst({
			where: {
				organizationId: scope.organizationId,
				userId: scope.userId,
				provider: scope.provider
			},
			select: {
				id: true,
				email: true,
				scope: true,
				createdAt: true,
				accessTokenExpiresAt: true
			}
		});
	}

	/**
	 * Return a usable access token for THIS user's mailbox. Refreshes via the provider's
	 * `/token` endpoint if the stored token is past (or near) expiry. Writes the new
	 * access token (and rotated refresh token, for Microsoft) back to the row.
	 *
	 * Pass `{ forceRefresh: true }` to bypass the freshness check — required when the
	 * cached token already failed at the provider.
	 *
	 * **Self-healing on revoke:** `invalid_grant` from refresh → delete row + throw
	 * `NotFoundException`. Same shape regardless of provider.
	 */
	async getAccessToken(scope: MailboxScope, opts: { forceRefresh?: boolean } = {}): Promise<string> {
		const row = await this.prisma.emailAccount.findFirst({
			where: {
				organizationId: scope.organizationId,
				userId: scope.userId,
				provider: scope.provider
			}
		});

		if (!row) {
			throw new NotFoundException(EMAIL_ACCOUNT_NOT_FOUND);
		}

		const expiresAt = row.accessTokenExpiresAt;
		const isFresh = expiresAt && expiresAt.getTime() - Date.now() > REFRESH_HEAD_START_MS;
		if (isFresh && !opts.forceRefresh) {
			return decrypt(row.accessToken);
		}

		const refreshToken = decrypt(row.refreshToken);

		let refreshed: ProviderTokenSet;
		try {
			refreshed = await this.oauthFor(scope.provider).refreshAccessToken(refreshToken);
		} catch (error) {
			if (error instanceof OAuthRefreshTokenInvalidException) {
				this.logger.warn(
					`${scope.provider} ${row.email} refresh token rejected — deleting row for org ${scope.organizationId} / user ${scope.userId}`
				);
				await this.prisma.emailAccount.delete({ where: { id: row.id } });
				throw new NotFoundException(EMAIL_ACCOUNT_NOT_FOUND);
			}
			throw error;
		}

		// Microsoft rotates the refresh token; Gmail does not. Always write the new access
		// token; only write a new refresh token if the provider issued one.
		await this.prisma.emailAccount.update({
			where: { id: row.id },
			data: {
				accessToken: encrypt(refreshed.accessToken),
				...(refreshed.refreshToken ? { refreshToken: encrypt(refreshed.refreshToken) } : {}),
				accessTokenExpiresAt: refreshed.expiresAt,
				scope: refreshed.scope
			}
		});

		return refreshed.accessToken;
	}

	/**
	 * Run a callback with a working access token, transparently retrying once if the
	 * provider rejects the cached token with HTTP 401. Use this from any code that
	 * actually calls the mailbox API — it papers over the "cached token looks fresh on
	 * our side but was revoked upstream" gap.
	 *
	 * Flow:
	 *   1. Get a token via `getAccessToken` (cached unless expired).
	 *   2. Run `fn(token)`. If it succeeds → done.
	 *   3. If `fn` throws `MailboxUnauthorizedException`, force a refresh and retry once.
	 *      A second 401 indicates a deeper problem — bubble it up.
	 */
	async withFreshAccessToken<T>(scope: MailboxScope, fn: (accessToken: string) => Promise<T>): Promise<T> {
		const token = await this.getAccessToken(scope);
		try {
			return await fn(token);
		} catch (error) {
			if (!(error instanceof MailboxUnauthorizedException)) {
				throw error;
			}

			this.logger.warn(
				`${scope.provider} returned 401 for org ${scope.organizationId} / user ${scope.userId} — forcing refresh + retry`
			);
			const refreshed = await this.getAccessToken(scope, { forceRefresh: true });
			return await fn(refreshed);
		}
	}

	/**
	 * Disconnect THIS user's mailbox. Best-effort revoke at the provider (Microsoft is a
	 * no-op), then delete the local row. Cascade clears any `RawMessage` rows tied to
	 * this connection.
	 *
	 * Idempotent — returns silently if there's no connected account for this user.
	 */
	async disconnectEmailAccount(scope: MailboxScope): Promise<void> {
		const row = await this.prisma.emailAccount.findFirst({
			where: {
				organizationId: scope.organizationId,
				userId: scope.userId,
				provider: scope.provider
			}
		});
		if (!row) {
			return;
		}

		const refreshToken = decrypt(row.refreshToken);
		await this.oauthFor(scope.provider).revoke(refreshToken);

		await this.prisma.emailAccount.delete({ where: { id: row.id } });
		this.logger.log(
			`${scope.provider} ${row.email} disconnected from org ${scope.organizationId} by user ${scope.userId}`
		);
	}
}
