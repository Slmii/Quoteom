/**
 * Auth.js session payload returned by `GET /api/auth/session`. Auth.js owns this shape —
 * Quoteom doesn't define a NestJS DTO for it because the endpoint is mounted by
 * `@auth/express`, not Nest.
 */
export interface Session {
	user?: SessionUser;
	expires: string;
}

export interface SessionUser {
	id: string;
	email?: string | null;
	name?: string | null;
	image?: string | null;
}

/** OAuth providers supported on the sign-in page. Driven by `apps/api/src/modules/auth/auth.config.ts`. */
export type OAuthProviderId = 'google' | 'microsoft-entra-id';

/** `POST /api/signup` request body (self-signup, Pattern A — creates User + Organization). */
export interface SignupInput {
	email: string;
	companyName: string;
}

/**
 * `POST /api/signup` response. `email` is the normalized form — pass it to Auth.js's
 * `signin/resend` to trigger the magic-link email (the FE doesn't get back the new
 * userId/organizationId because the user hasn't signed in yet at this point).
 */
export interface SignupResponse {
	ok: boolean;
	email: string;
}
