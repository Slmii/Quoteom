import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/(app)')({
	beforeLoad: ({ context, location }) => {
		if (!context.session) {
			throw redirect({
				to: '/sign-in',
				search: {
					redirect: location.href
				}
			});
		}
	},
	component: RouteComponent
});

function RouteComponent() {
	return <Outlet />;
}
