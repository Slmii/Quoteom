import { myOrganizationsQueryOptions } from '@/lib/queries/team.queries';
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';

const NO_ORGANIZATION_PATH = '/no-organization';

export const Route = createFileRoute('/(app)')({
	beforeLoad: async ({ context, location }) => {
		if (!context.session) {
			throw redirect({ to: '/sign-in' });
		}

		// Skip the org-presence check when the destination IS `/no-organization`. Otherwise
		// the redirect below would loop forever on that route.
		if (location.pathname === NO_ORGANIZATION_PATH) {
			return;
		}

		// A signed-in user whose `currentOrganizationId` is null (e.g. they were the last
		// removed member of their only org) would otherwise hit a 403 on every
		// `/api/me/membership`-shaped route in the app. Front-run that error with a friendly
		// empty-state page.
		//
		// `ensureQueryData` (not `fetchQuery`) so the loaded data is reused by the
		// `/no-organization` route's own loader without a second round-trip.
		const organizations = await context.queryClient.ensureQueryData(myOrganizationsQueryOptions);
		if (organizations.length === 0) {
			throw redirect({ to: NO_ORGANIZATION_PATH });
		}
	},
	component: RouteComponent
});

function RouteComponent() {
	return <Outlet />;
}
