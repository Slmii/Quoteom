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
// Dev-facing (raised inside Auth.js signIn callback; never surfaces in a response)
export const SELF_SIGNUP_DISABLED = 'User self-signup is disabled. Users must be invited.';

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
export const TRIAL_ENDED = 'Your trial has ended. Subscribe to continue.';
export const MISSING_ORG_CONTEXT = 'Missing organization context.';
export const subscriptionAlreadyActive = (status: string) =>
	`Organization already has an active subscription (${status}). Use the Customer Portal to manage it.`;
export const trialSeatLimitReached = (cap: number) =>
	`Trial accounts are limited to ${cap} seats. Subscribe to invite more teammates.`;
