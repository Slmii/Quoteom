/**
 * Mirrors Prisma's `MembershipRole` enum. Declared as a string union here (not re-exported
 * from Prisma) because Prisma's generated client lives inside `apps/api` and shouldn't
 * leak into `@quoteom/shared` — that would pull the Prisma runtime into the web bundle.
 */
export type MembershipRole = 'OWNER' | 'MEMBER' | 'EXTERNAL';

/** Minimal user shape included in membership responses (no PII beyond what the UI needs). */
export interface MembershipUser {
	id: string;
	email: string;
	name: string | null;
}

/** Minimal organization shape included in membership responses. */
export interface MembershipOrganization {
	id: string;
	name: string;
}

/** `GET /api/me/memberships` row + `GET /api/me/membership` + the org switcher's `GET /api/me/organizations`. */
export interface Membership {
	id: string;
	userId: string;
	organizationId: string;
	role: MembershipRole;
	/** ISO timestamp (wire format). */
	createdAt: string;
	/** ISO timestamp (wire format). */
	updatedAt: string;
	user: MembershipUser;
	organization: MembershipOrganization;
}

/** `POST /api/me/switch-organization` request body. */
export interface SwitchOrganizationInput {
	organizationId: string;
}
