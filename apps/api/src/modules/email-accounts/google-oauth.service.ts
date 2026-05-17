import type { EnvSchema } from '@/config/env.schema';
import { EmailConnectErrorCode, GOOGLE_OAUTH_NOT_CONFIGURED, OAUTH_TOKEN_EXCHANGE_FAILED } from '@/lib/errors';
import {
	GMAIL_OAUTH_SCOPES,
	GOOGLE_OAUTH_AUTHORIZE_URL,
	GOOGLE_OAUTH_REVOKE_URL,
	GOOGLE_OAUTH_TOKEN_URL,
	GOOGLE_OAUTH_USERINFO_URL
} from '@/modules/gmail/gmail.constants';
import { EmailConnectError, OAuthRefreshTokenInvalidException } from '@/lib/oauth/oauth-errors';
import { LogService } from '@/modules/logger/log.service';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface TokenSet {
	accessToken: string;
	refreshToken: string | null;
	scope: string;
	expiresAt: Date;
	idToken: string | null;
}

export interface GoogleUserInfo {
	sub: string;
	email: string;
	email_verified: boolean;
	name?: string;
}

/**
 * Wrapper around Google's OAuth2 token + userinfo endpoints. Hand-rolled rather than
 * dependent on `googleapis` because W3.1's needs are tiny — exchanging a code, refreshing
 * a token, and fetching userinfo. When W3.4 backfill needs richer Gmail API helpers
 * (parsing MIME parts, etc.), revisit and consider adding the library.
 */
@Injectable()
export class GoogleOAuthService {
	constructor(
		private readonly config: ConfigService<EnvSchema, true>,
		private readonly logService: LogService
	) {}

	private credentials(): { clientId: string; clientSecret: string; redirectUri: string } {
		const clientId = this.config.get('GOOGLE_CLIENT_ID', { infer: true });
		const clientSecret = this.config.get('GOOGLE_CLIENT_SECRET', { infer: true });
		if (!clientId || !clientSecret) {
			throw new InternalServerErrorException(GOOGLE_OAUTH_NOT_CONFIGURED);
		}
		const webOrigin = this.config.get('WEB_ORIGIN', { infer: true });
		// Web proxies /api/* to the API so the redirect URI lives on the web origin.
		// The same URI must be registered in the Google Cloud Console for this client.
		const redirectUri = `${webOrigin}/api/email/gmail/callback`;
		return { clientId, clientSecret, redirectUri };
	}

	/** Build the URL we redirect the user's browser to so they can grant scopes. */
	buildAuthorizeUrl(state: string): string {
		const { clientId, redirectUri } = this.credentials();
		const params = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			scope: GMAIL_OAUTH_SCOPES.join(' '),
			// `access_type=offline` is REQUIRED for Google to issue a refresh token.
			// Without it we'd lose access the moment the first access token expires.
			access_type: 'offline',
			// `select_account` shows the account picker even when the browser is already
			// signed in with a Google account — users connecting Quoteom may want to use a
			// work mailbox different from their primary signed-in account. `consent` then
			// forces the consent screen so reconnecting after a disconnect re-issues a
			// refresh token (Google returns `refresh_token` only on first consent unless we
			// force re-consent). Space-separated prompt values are valid per RFC 8252.
			prompt: 'select_account consent',
			// `include_granted_scopes=true` so this consent merges with any already-granted
			// scopes on the same client (e.g. the sign-in flow). Avoids stripping scopes.
			include_granted_scopes: 'true',
			state
		});
		return `${GOOGLE_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
	}

	/** Exchange the authorization code received on the callback for a token set. */
	async exchangeCode(code: string): Promise<TokenSet> {
		const { clientId, clientSecret, redirectUri } = this.credentials();
		const body = new URLSearchParams({
			code,
			client_id: clientId,
			client_secret: clientSecret,
			redirect_uri: redirectUri,
			grant_type: 'authorization_code'
		});

		const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body
		});

		if (!response.ok) {
			const text = await response.text();
			// Google's `invalid_grant` on a code exchange = code already used / expired /
			// wrong client. Same recovery as Microsoft's AADSTS70000: restart the flow.
			const isCodeInvalid = /\binvalid_grant\b/.test(text);
			const code = isCodeInvalid ? EmailConnectErrorCode.CodeReused : EmailConnectErrorCode.TokenExchangeFailed;
			this.logService.logAction({
				action: 'oauth.google.token_exchange_failed',
				message: `Google token exchange failed: HTTP ${response.status}`,
				metadata: { status: response.status, body: text.slice(0, 500), code },
				level: 'error',
				context: 'GoogleOAuthService'
			});
			throw new EmailConnectError(code, `Google token exchange failed (HTTP ${response.status})`);
		}

		const data = (await response.json()) as {
			access_token: string;
			refresh_token?: string;
			scope: string;
			expires_in: number;
			id_token?: string;
		};

		return {
			accessToken: data.access_token,
			refreshToken: data.refresh_token ?? null,
			scope: data.scope,
			expiresAt: new Date(Date.now() + data.expires_in * 1000),
			idToken: data.id_token ?? null
		};
	}

	/**
	 * Refresh an access token using a long-lived refresh token. Google does NOT rotate
	 * refresh tokens on this call (unlike some providers); the same refresh_token stays
	 * valid until the user revokes consent or six months of inactivity pass.
	 *
	 * Throws `OAuthRefreshTokenInvalidException` (caught by EmailAccountsService) when
	 * Google returns `invalid_grant` — that's Google's canonical "this token is dead"
	 * signal (revoked at myaccount.google.com, idle timeout, etc.) and the local row
	 * should be deleted, NOT retried.
	 *
	 * All other failures bubble as a generic 500 — likely a transient outage we can retry.
	 */
	async refreshAccessToken(refreshToken: string): Promise<TokenSet> {
		const { clientId, clientSecret } = this.credentials();
		const body = new URLSearchParams({
			refresh_token: refreshToken,
			client_id: clientId,
			client_secret: clientSecret,
			grant_type: 'refresh_token'
		});

		const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body
		});

		if (!response.ok) {
			const text = await response.text();
			this.logService.logAction({
				action: 'oauth.google.refresh_failed',
				message: `Google token refresh failed: HTTP ${response.status}`,
				metadata: { status: response.status, body: text.slice(0, 500) },
				level: 'error',
				context: 'GoogleOAuthService'
			});

			// Google encodes "the refresh token itself is no longer valid" as
			// `error: invalid_grant` in a 400 response. Match on the body, not just the
			// status — a 400 with a *different* `error` value (rare but possible — e.g.
			// `invalid_scope` after the consent screen drops a scope) should still bubble
			// as a generic error so we don't auto-delete on a recoverable misconfig.
			if (response.status === 400 && /\binvalid_grant\b/.test(text)) {
				throw new OAuthRefreshTokenInvalidException();
			}

			throw new InternalServerErrorException(OAUTH_TOKEN_EXCHANGE_FAILED);
		}

		const data = (await response.json()) as {
			access_token: string;
			scope: string;
			expires_in: number;
			id_token?: string;
		};

		return {
			accessToken: data.access_token,
			// Refresh-token rotation: Google reuses the same refresh token. Caller should
			// keep its existing one if this field is null.
			refreshToken: null,
			scope: data.scope,
			expiresAt: new Date(Date.now() + data.expires_in * 1000),
			idToken: data.id_token ?? null
		};
	}

	/** Fetch the connected account's email/name. Used right after `exchangeCode`. */
	async fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
		const response = await fetch(GOOGLE_OAUTH_USERINFO_URL, {
			headers: { authorization: `Bearer ${accessToken}` }
		});

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			this.logService.logAction({
				action: 'oauth.google.userinfo_failed',
				message: `Google userinfo failed: HTTP ${response.status}`,
				metadata: { status: response.status, body: text.slice(0, 500) },
				level: 'error',
				context: 'GoogleOAuthService'
			});
			throw new EmailConnectError(EmailConnectErrorCode.UserInfoFailed);
		}

		return (await response.json()) as GoogleUserInfo;
	}

	/**
	 * Revoke a refresh token at Google. Best-effort — we log + ignore failures because
	 * the user-facing disconnect should always succeed locally (clear our row) even if
	 * Google's endpoint is briefly unreachable. Worst case the user revokes manually at
	 * myaccount.google.com.
	 */
	async revoke(token: string): Promise<void> {
		try {
			const response = await fetch(GOOGLE_OAUTH_REVOKE_URL, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ token })
			});
			if (!response.ok) {
				this.logService.logAction({
					action: 'oauth.google.revoke_warn',
					message: `Google token revoke returned HTTP ${response.status} — proceeding anyway`,
					metadata: { status: response.status },
					level: 'warn',
					context: 'GoogleOAuthService'
				});
			}
		} catch (error) {
			this.logService.logAction({
				action: 'oauth.google.revoke_warn',
				message: `Google token revoke failed: ${error instanceof Error ? error.message : 'unknown'}`,
				metadata: { reason: error instanceof Error ? error.message : 'unknown' },
				level: 'warn',
				stack: error instanceof Error ? error.stack : undefined,
				context: 'GoogleOAuthService'
			});
		}
	}
}
