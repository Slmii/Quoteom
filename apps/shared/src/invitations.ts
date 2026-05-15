import type { MembershipRole } from './team.js';

/** `GET /api/invitations` row — one entry per pending invitation in the active org. */
export interface Invitation {
	id: string;
	email: string;
	role: MembershipRole;
	/** ISO timestamp (wire format). */
	expiresAt: string;
	/** ISO timestamp (wire format). */
	createdAt: string;
}

/** `POST /api/invitations` request body. Role defaults to MEMBER server-side if omitted. */
export interface CreateInvitationInput {
	email: string;
	role?: MembershipRole;
}

/** `POST /api/invitations/accept` request body. `token` is the magic-link token from the email. */
export interface AcceptInvitationInput {
	token: string;
}

/** `POST /api/invitations/accept` response. Sign-in completion happens via Auth.js next. */
export interface AcceptInvitationResponse {
	userId: string;
	email: string;
	organizationId: string;
	organizationName: string;
}
