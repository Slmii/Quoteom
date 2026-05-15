import { serverFetch } from '@/lib/api/server-fetch';
import type { Invitation, Membership } from '@quoteom/shared';
import { createServerFn } from '@tanstack/react-start';

/** GET /api/me/memberships — active members of the user's current org. */
export const getMembershipsServer = createServerFn({ method: 'GET' }).handler(async (): Promise<Membership[]> => {
	const response = await serverFetch('/api/me/memberships');
	if (!response.ok) {
		throw new Error(`Failed to load memberships (${response.status})`);
	}
	return (await response.json()) as Membership[];
});

/** GET /api/me/membership — the current user's single membership in the active org. */
export const getMyMembershipServer = createServerFn({ method: 'GET' }).handler(async (): Promise<Membership> => {
	const response = await serverFetch('/api/me/membership');
	if (!response.ok) {
		throw new Error(`Failed to load current membership (${response.status})`);
	}
	return (await response.json()) as Membership;
});

/** GET /api/me/organizations — all orgs the current user is a member of (for the org switcher). */
export const getMyOrganizationsServer = createServerFn({ method: 'GET' }).handler(async (): Promise<Membership[]> => {
	const response = await serverFetch('/api/me/organizations');
	if (!response.ok) {
		throw new Error(`Failed to load organizations (${response.status})`);
	}
	return (await response.json()) as Membership[];
});

/** GET /api/invitations — pending invitations on the user's current org. */
export const getInvitationsServer = createServerFn({ method: 'GET' }).handler(async (): Promise<Invitation[]> => {
	const response = await serverFetch('/api/invitations');
	if (!response.ok) {
		throw new Error(`Failed to load invitations (${response.status})`);
	}
	return (await response.json()) as Invitation[];
});
