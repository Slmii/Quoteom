import type { EnvSchema } from '@/config/env.schema';
import {
	buildMicrosoftAdminConsentUrl,
	MICROSOFT_OAUTH_NOT_CONFIGURED,
	OAUTH_TOKEN_EXCHANGE_FAILED,
	OAUTH_USERINFO_FAILED
} from '@/lib/errors';
import { OAuthRefreshTokenInvalidException } from '@/lib/oauth/oauth-errors';
import {
	MICROSOFT_GRAPH_BASE,
	MICROSOFT_OAUTH_AUTHORIZE_URL,
	MICROSOFT_OAUTH_SCOPES,
	MICROSOFT_OAUTH_TOKEN_URL
} from '@/modules/microsoft/microsoft.constants';
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface TokenSet {
	accessToken: string;
	refreshToken: string | null;
	scope: string;
	expiresAt: Date;
	idToken: string | null;
}

export interface MicrosoftUserInfo {
	/** Graph's stable user id (`oid` in id token; also `id` field on /me). */
	id: string;
	/** Primary email — `mail` field on /me. May be null for accounts that haven't set one. */
	mail: string | null;
	/** Fallback: the UPN often is the email-shaped sign-in. */
	userPrincipalName: string;
	displayName?: string | null;
}

/**
 * Wrapper around Microsoft Entra's OAuth 2.0 v2.0 token + Graph `/me` endpoints.
 *
 * Mirrors `GoogleOAuthService`'s public surface so `EmailAccountsService` can swap them
 * via a provider dispatch. Key differences from Google:
 *
 *  - **Tenant in URL path.** Microsoft's endpoints carry the tenant: `/{tenant}/oauth2/v2.0/...`.
 *    We use `common` by default (any Microsoft account); configurable via env.
 *  - **Refresh-token ROTATION.** Microsoft issues a NEW refresh token on every refresh,
 *    unlike Google. Caller MUST persist the rotated value, or future refreshes 401.
 *  - **No revoke endpoint.** Microsoft doesn't provide a programmatic revoke (the user
 *    revokes via account.microsoft.com). Our `revoke()` is a no-op for parity.
 *  - **`invalid_grant` detection.** Same response shape on a dead refresh token, so we
 *    reuse the same exception class.
 */
@Injectable()
export class MicrosoftOAuthService {
	private readonly logger = new Logger(MicrosoftOAuthService.name);

	constructor(private readonly config: ConfigService<EnvSchema, true>) {}

	private credentials(): {
		clientId: string;
		clientSecret: string;
		redirectUri: string;
		tenant: string;
	} {
		const clientId = this.config.get('MICROSOFT_CLIENT_ID', { infer: true });
		const clientSecret = this.config.get('MICROSOFT_CLIENT_SECRET', { infer: true });
		if (!clientId || !clientSecret) {
			throw new InternalServerErrorException(MICROSOFT_OAUTH_NOT_CONFIGURED);
		}
		const tenant = this.config.get('MICROSOFT_TENANT_ID', { infer: true }) ?? 'common';
		const webOrigin = this.config.get('WEB_ORIGIN', { infer: true });
		// Web proxies /api/* to the API so the redirect URI lives on the web origin.
		// The same URI must be registered in the Entra portal for this app registration.
		const redirectUri = `${webOrigin}/api/email/microsoft/callback`;
		return { clientId, clientSecret, redirectUri, tenant };
	}

	private endpoint(template: string, tenant: string): string {
		return template.replace('{tenant}', tenant);
	}

	/**
	 * Build the admin-consent URL for a tenant admin to one-shot approve our app for their
	 * whole tenant. Called by the callback handler when Entra returns one of the
	 * admin-consent-required error codes. The redirect URI must be the same one registered
	 * in the Entra portal so the admin lands back on our /settings/email page after
	 * granting consent.
	 */
	buildAdminConsentUrl(): string {
		const { clientId, redirectUri } = this.credentials();
		return buildMicrosoftAdminConsentUrl(clientId, redirectUri);
	}

	buildAuthorizeUrl(state: string): string {
		const { clientId, redirectUri, tenant } = this.credentials();
		const params = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			response_mode: 'query',
			scope: MICROSOFT_OAUTH_SCOPES.join(' '),
			state,
			// `select_account` shows the account picker even when the browser is already
			// signed in with a Microsoft account — users may want to connect a different
			// mailbox than their primary signed-in account. `consent` then forces the
			// consent screen so reconnecting after disconnect always re-issues a refresh
			// token. Space-separated prompt values are valid per OIDC core 1.0 §3.1.2.1.
			prompt: 'select_account'
		});
		return `${this.endpoint(MICROSOFT_OAUTH_AUTHORIZE_URL, tenant)}?${params.toString()}`;
	}

	async exchangeCode(code: string): Promise<TokenSet> {
		const { clientId, clientSecret, redirectUri, tenant } = this.credentials();
		const body = new URLSearchParams({
			code,
			client_id: clientId,
			client_secret: clientSecret,
			redirect_uri: redirectUri,
			grant_type: 'authorization_code',
			scope: MICROSOFT_OAUTH_SCOPES.join(' ')
		});

		const response = await fetch(this.endpoint(MICROSOFT_OAUTH_TOKEN_URL, tenant), {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body
		});

		if (!response.ok) {
			const text = await response.text();
			this.logger.error(`Token exchange failed: ${response.status} ${text}`);
			throw new InternalServerErrorException(OAUTH_TOKEN_EXCHANGE_FAILED);
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
	 * Refresh an access token. **Microsoft rotates the refresh token on every refresh** —
	 * the returned `refreshToken` is a NEW value and the caller MUST persist it. The
	 * previous refresh token becomes immediately invalid.
	 *
	 * Throws `OAuthRefreshTokenInvalidException` on `invalid_grant`. Same response shape
	 * as Google, same downstream handling (delete the local row, surface as not-connected).
	 */
	async refreshAccessToken(refreshToken: string): Promise<TokenSet> {
		const { clientId, clientSecret, tenant } = this.credentials();
		const body = new URLSearchParams({
			refresh_token: refreshToken,
			client_id: clientId,
			client_secret: clientSecret,
			grant_type: 'refresh_token',
			scope: MICROSOFT_OAUTH_SCOPES.join(' ')
		});

		const response = await fetch(this.endpoint(MICROSOFT_OAUTH_TOKEN_URL, tenant), {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body
		});

		if (!response.ok) {
			const text = await response.text();
			this.logger.error(`Refresh failed: ${response.status} ${text}`);

			// Microsoft returns `error: invalid_grant` for dead refresh tokens (revoked,
			// expired, password change, etc.) — same exception as the Google path.
			if (response.status === 400 && /\binvalid_grant\b/.test(text)) {
				throw new OAuthRefreshTokenInvalidException();
			}

			throw new InternalServerErrorException(OAUTH_TOKEN_EXCHANGE_FAILED);
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
			// Rotation: capture the new refresh token. Unlike Google, this is REQUIRED for
			// the next refresh to work.
			refreshToken: data.refresh_token ?? null,
			scope: data.scope,
			expiresAt: new Date(Date.now() + data.expires_in * 1000),
			idToken: data.id_token ?? null
		};
	}

	async fetchUserInfo(accessToken: string): Promise<MicrosoftUserInfo> {
		const response = await fetch(`${MICROSOFT_GRAPH_BASE}/me`, {
			headers: { authorization: `Bearer ${accessToken}` }
		});

		if (!response.ok) {
			throw new InternalServerErrorException(OAUTH_USERINFO_FAILED);
		}

		return (await response.json()) as MicrosoftUserInfo;
	}

	/**
	 * Microsoft doesn't expose a programmatic revoke endpoint. Returns a resolved promise
	 * to keep the interface parity with `GoogleOAuthService.revoke()`. Users revoke via
	 * https://account.microsoft.com/privacy → "Apps and services that can access your data".
	 *
	 * On disconnect, we just delete the local row; the next time Microsoft sees the
	 * refresh token in use the user-side state is the same as if we'd revoked. If the
	 * user manually revokes upstream first, our refresh fires `invalid_grant` and the
	 * self-heal path deletes the row anyway.
	 */
	async revoke(_token: string): Promise<void> {
		this.logger.log('Microsoft has no programmatic revoke — relying on local row delete.');
	}
}
