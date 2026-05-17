import { myMembershipQueryOptions } from '@/lib/queries/team.queries';
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';

/**
 * Parent layout for every `/admin/*` route. Gates the whole subtree behind the same
 * `ADMIN_EMAILS` allowlist the API enforces — surfaced via `myMembership.user.isAdmin`
 * (server-computed; the allowlist itself never reaches the browser bundle).
 *
 * Putting the gate at the parent route means a developer adding a new admin page under
 * `/admin/foo` gets the protection automatically — no per-route `beforeLoad` boilerplate
 * to remember.
 */
export const Route = createFileRoute('/(app)/admin')({
	beforeLoad: async ({ context }) => {
		const membership = await context.queryClient.ensureQueryData(myMembershipQueryOptions);
		if (!membership.user.isAdmin) {
			throw redirect({ to: '/' });
		}
	},
	component: AdminLayout
});

function AdminLayout() {
	return <Outlet />;
}
