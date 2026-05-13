/**
 * Minimum scopes for the W3.2 inbox-connect flow against Microsoft Graph.
 *
 *  - `Mail.Read`     — list + fetch messages in any mail folder (inbox, sent, etc.).
 *  - `Mail.Send`     — send mail on behalf of the user (W5.5 one-tap send).
 *  - `User.Read`     — read profile to identify the connected mailbox (parallel to
 *                       Gmail's openid+email+profile bundle).
 *  - `offline_access` — REQUIRED for Microsoft to issue a refresh token. Without it
 *                       we'd lose access the moment the first access token expires.
 *  - `openid`/`email`/`profile` — id-token claims for the connected account identity.
 *
 * NOT requested:
 *  - `Mail.ReadWrite`: would let us mark-as-read / move / delete. Defer until needed
 *    — broader scope = more friction on the consent screen.
 *  - `Mail.Read.Shared` / `Mail.Send.Shared`: out of scope for individual mailboxes.
 *
 * Mail.* scopes are sensitive in Microsoft's classification — for personal accounts
 * they may require admin consent at the tenant level. For org users with their own
 * Entra tenant, the OWNER going through consent grants on their own behalf.
 */
export const MICROSOFT_OAUTH_SCOPES = [
	'openid',
	'email',
	'profile',
	'offline_access',
	'https://graph.microsoft.com/Mail.Read',
	'https://graph.microsoft.com/Mail.Send',
	'https://graph.microsoft.com/User.Read'
];

/**
 * Microsoft Entra (formerly Azure AD) OAuth 2.0 v2.0 endpoints.
 *
 * `/{tenant}/` is filled in by the OAuth service from `MICROSOFT_TENANT_ID` env. Use
 *   - `common`       — anyone with a Microsoft account (personal OR work) — DEFAULT
 *   - `consumers`    — personal Microsoft accounts only (outlook.com, hotmail.com)
 *   - `organizations` — work/school accounts only
 *   - `<tenant-uuid>` — a specific Entra tenant
 *
 * For Quoteom's SMB target audience, `common` is right — Dutch SMB owners have a mix
 * of personal Outlook + work Microsoft 365 accounts.
 */
export const MICROSOFT_OAUTH_AUTHORIZE_URL = 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize';
export const MICROSOFT_OAUTH_TOKEN_URL = 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token';

export const MICROSOFT_GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** Cookie carrying the signed OAuth state across the redirect. Distinct from Gmail's. */
export const MICROSOFT_STATE_COOKIE = 'q_ms_oauth_state';
