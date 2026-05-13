/**
 * Shared OAuth exceptions used by every mailbox provider (Gmail, Microsoft Graph, …).
 *
 * Each provider's API service throws these on the canonical "credentials no longer valid"
 * signals; the shared `EmailAccountsService.withFreshAccessToken` wrapper catches them
 * uniformly and either force-refreshes or deletes the local row.
 */

/**
 * Thrown when the OAuth provider rejects a refresh-token call with a "this token is dead"
 * response — Google's `invalid_grant`, Microsoft's `invalid_grant` / `AADSTS70008`, etc.
 *
 * Typical causes:
 *  - the user revoked our app (myaccount.google.com / account.microsoft.com)
 *  - the refresh token went idle past the provider's TTL (Google: 6 months; Microsoft: 90 days)
 *  - the user changed their password (some account configurations)
 *  - the OAuth client itself was rotated/deleted at the provider
 *
 * Distinct from generic OAuth failures because the recovery is different: the local
 * EmailAccount row is now garbage and should be deleted, NOT retried. Callers in
 * `EmailAccountsService` catch this specifically and self-heal by deleting the row.
 */
export class OAuthRefreshTokenInvalidException extends Error {
	constructor(message = 'Refresh token is no longer valid at the provider') {
		super(message);
		this.name = 'OAuthRefreshTokenInvalidException';
	}
}

/**
 * Thrown when a Microsoft Entra OAuth redirect comes back with an "admin consent required"
 * error code — the user attempted to connect a mailbox that lives in a work tenant whose
 * admin has disabled user-level consent for Mail.* scopes.
 *
 * Distinct from a generic OAuth `error` because the recovery is product-specific: the
 * tenant admin must approve our app once for the whole tenant via the `/adminconsent`
 * endpoint, after which any user in that tenant can connect. We surface a structured
 * code so the web client can render a "send your admin this link" CTA instead of the
 * generic "the provider returned an error" Alert.
 *
 * Detected by matching `error_description` against the known Entra error codes:
 *  - `AADSTS65001` — user or admin has not consented (org-wide user-consent disabled)
 *  - `AADSTS90094` — admin permission required for this scope
 *  - `AADSTS900971` — no reply address (admin-consent variant)
 *
 * Carries an `adminConsentUrl` so the controller doesn't have to rebuild it.
 */
export class MicrosoftAdminConsentRequiredException extends Error {
	readonly adminConsentUrl: string;

	constructor(adminConsentUrl: string, message = 'Microsoft Entra requires admin consent for this app') {
		super(message);
		this.name = 'MicrosoftAdminConsentRequiredException';
		this.adminConsentUrl = adminConsentUrl;
	}
}

/**
 * Thrown when a mailbox API call returns HTTP 401 (Invalid Credentials / Unauthorized).
 * The access token still looks fresh on our side (within its cached expiry window) but
 * the provider has revoked it upstream — most commonly because the user revoked our app
 * and the next API call is the first time we hear about it.
 *
 * Caught by `EmailAccountsService.withFreshAccessToken`, which forces a refresh (which
 * may surface `OAuthRefreshTokenInvalidException` → row deletion + 404) and retries the
 * call exactly once.
 *
 * Single class for all providers — the recovery path is identical and the type-narrowing
 * trick (re-throwing for inspection) would just be an `instanceof` check anyway.
 */
export class MailboxUnauthorizedException extends Error {
	constructor(message = 'Mailbox API rejected the access token (HTTP 401)') {
		super(message);
		this.name = 'MailboxUnauthorizedException';
	}
}
