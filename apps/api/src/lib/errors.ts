/**
 * Centralized error messages. Every `throw` in the API should source its message from this
 * file so we can find / rename / translate them in one place.
 *
 * - SCREAMING_SNAKE_CASE constants → static messages.
 * - camelCase functions → templates with interpolation (call them at the throw site).
 *
 * Messages marked `User-facing` go to clients in 4xx responses (treat as copy).
 * Messages marked `Dev-facing` only surface in logs / 5xx — usually config bugs.
 */

// ────────────────────────────────────────────────────────────────────────────
// Organization (User-facing)
// ────────────────────────────────────────────────────────────────────────────
export const ORGANIZATION_NOT_FOUND = 'Organization not found';
export const NO_ACTIVE_ORGANIZATION =
	'No active organization. You must be a member of an organization to access this route.';
export const MEMBERSHIP_NOT_FOUND = 'Membership not found in the active organization';

// ────────────────────────────────────────────────────────────────────────────
// Invitations (User-facing)
// ────────────────────────────────────────────────────────────────────────────
export const INVITATION_NOT_FOUND = 'Invitation not found';
export const INVITATION_EXPIRED = 'Invitation expired';
export const INVITATION_ALREADY_ACCEPTED = 'Invitation has already been accepted';
export const INVITATION_ALREADY_PENDING = 'An invitation for this email is already pending';
export const USER_ALREADY_MEMBER = 'This person is already a member of the organization';
export const OWNER_ROLE_NOT_INVITABLE =
	'Owner role cannot be assigned via invitation — every organization has exactly one owner';

// ────────────────────────────────────────────────────────────────────────────
// Auth
// ────────────────────────────────────────────────────────────────────────────
// User-facing
export const NOT_AUTHENTICATED = 'Not authenticated';
export const OWNER_ROLE_REQUIRED = 'Only the organization owner can access this resource';
// User-facing — surfaced when an EXTERNAL-role user hits a route that's reserved for
// primary members (OWNER/MEMBER). EXTERNAL is a consumer role, not a contributor.
export const MEMBER_ROLE_REQUIRED = 'External collaborators cannot perform this action.';
// User-facing — surfaced when /api/signup hits a duplicate email
export const ACCOUNT_ALREADY_EXISTS = 'An account with this email already exists. Sign in instead.';
export const DISPOSABLE_EMAIL_NOT_ALLOWED = 'Disposable email addresses are not allowed. Please use a work email.';
// Dev-facing — Auth.js's OAuth (Google/Microsoft) createUser path stays blocked.
// Self-signup goes through the explicit POST /api/signup endpoint with company name;
// OAuth providers are sign-in-only for already-provisioned users.
export const SELF_SIGNUP_DISABLED = 'OAuth self-signup is disabled. Use the email signup form.';

// ────────────────────────────────────────────────────────────────────────────
// Billing — config errors (Dev-facing; should never reach production)
// ────────────────────────────────────────────────────────────────────────────
export const STRIPE_SECRET_KEY_MISSING = 'STRIPE_SECRET_KEY is not set';
export const STRIPE_PRICE_ID_MISSING = 'STRIPE_PRICE_ID is not configured';
export const STRIPE_WEBHOOK_SECRET_MISSING = 'STRIPE_WEBHOOK_SECRET is not configured';

// ────────────────────────────────────────────────────────────────────────────
// Billing — webhook
// ────────────────────────────────────────────────────────────────────────────
export const STRIPE_SIGNATURE_HEADER_MISSING = 'Missing Stripe-Signature header';
export const STRIPE_RAW_BODY_MISSING = 'Raw body unavailable — check rawBody option in main.ts';
export const STRIPE_SIGNATURE_INVALID = 'Invalid signature';

// ────────────────────────────────────────────────────────────────────────────
// Billing — runtime (User-facing — surfaced in 5xx / 4xx responses)
// ────────────────────────────────────────────────────────────────────────────
export const STRIPE_CHECKOUT_URL_MISSING = 'Stripe did not return a checkout URL';
export const noStripeCustomerForOrg = (organizationId: string) =>
	`No Stripe customer exists for organization ${organizationId}`;

// ────────────────────────────────────────────────────────────────────────────
// Billing — entitlement (User-facing — paired with structured `code` fields)
// ────────────────────────────────────────────────────────────────────────────
// Generic message returned by EntitlementGuard for all non-entitled write attempts
// (trial expired, canceled, unpaid, etc.). The web client renders state-specific copy
// via `billingBlockedCopy()`; this string is the fallback for non-web callers.
export const SUBSCRIPTION_REQUIRED = 'An active subscription is required to make changes.';
export const MISSING_ORG_CONTEXT = 'Missing organization context.';
export const subscriptionAlreadyActive = (status: string) =>
	`Organization already has an active subscription (${status}). Use the Customer Portal to manage it.`;
export const trialSeatLimitReached = (cap: number) =>
	`Trial accounts are limited to ${cap} seats. Subscribe to invite more teammates.`;

// ────────────────────────────────────────────────────────────────────────────
// Gmail / email connection (Dev-facing config + User-facing OAuth failures)
// ────────────────────────────────────────────────────────────────────────────
export const GOOGLE_OAUTH_NOT_CONFIGURED =
	'Google OAuth is not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).';
export const MICROSOFT_OAUTH_NOT_CONFIGURED =
	'Microsoft OAuth is not configured (set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET).';
export const OAUTH_STATE_INVALID = 'OAuth state mismatch — possible CSRF, restart the connect flow.';
export const OAUTH_CODE_MISSING = 'OAuth callback is missing the authorization code.';
export const OAUTH_TOKEN_EXCHANGE_FAILED = 'Failed to exchange OAuth code for tokens.';
export const OAUTH_USERINFO_FAILED = 'Failed to fetch user info from the OAuth provider.';
export const EMAIL_ACCOUNT_NOT_FOUND = 'No connected mail account for this organization.';

// ────────────────────────────────────────────────────────────────────────────
// Microsoft Entra — admin-consent flow (User-facing — structured error code)
// ────────────────────────────────────────────────────────────────────────────
/**
 * Stable error identifier surfaced on `/settings/email?error=microsoft_admin_consent_required`.
 * The web client matches on this exact string to render the admin-consent CTA.
 */
export const MICROSOFT_ADMIN_CONSENT_REQUIRED = 'microsoft_admin_consent_required';

/**
 * Entra error codes that indicate the user's tenant admin must approve our app before any
 * user in that tenant can connect a mailbox. We match these against the `error_description`
 * query param Entra returns to our callback.
 *
 *  - AADSTS65001  — user/admin has not consented (org-wide user-consent disabled)
 *  - AADSTS90094  — admin permission required for this scope
 *  - AADSTS900971 — no reply address (admin-consent flow variant)
 */
export const MICROSOFT_ADMIN_CONSENT_ERROR_CODE_REGEX = /AADSTS(65001|90094|900971)\b/;

/**
 * Build the Entra admin-consent URL. The tenant admin opens this once; Entra grants the
 * app's requested permissions to the whole tenant. After that any user in the tenant
 * can complete the regular `/connect` flow without hitting the user-consent wall.
 *
 * Uses `common` as the tenant — Entra resolves the actual tenant from the admin's
 * sign-in, so we don't need to know it in advance.
 */
export const buildMicrosoftAdminConsentUrl = (clientId: string, redirectUri: string): string => {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri
	});
	return `https://login.microsoftonline.com/common/adminconsent?${params.toString()}`;
};
