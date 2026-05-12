import { myMembershipQueryOptions } from '@/lib/queries/team.queries';
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';

/**
 * Billing is owner-only. Non-owners get bounced to the home page. The API enforces the
 * same rule (`OwnerGuard` on every billing endpoint) — this client check is just to keep
 * non-owners out of the UI so they don't see a permission-denied screen mid-action.
 */
export const Route = createFileRoute('/(app)/billing')({
	beforeLoad: async ({ context }) => {
		const me = await context.queryClient.ensureQueryData(myMembershipQueryOptions);
		if (me.role !== 'OWNER') {
			throw redirect({ to: '/' });
		}
	},
	component: () => <Outlet />
});
