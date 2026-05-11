import { routeTree } from '@/routeTree.gen';
import { QueryClient } from '@tanstack/react-query';
import { createRouter as createTanStackRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';

export function getRouter() {
	const queryClient = new QueryClient();

	const router = createTanStackRouter({
		routeTree,
		context: { queryClient },
		defaultPreload: 'intent',
		defaultNotFoundComponent: () => <>Not Found</>,
		scrollRestoration: true
	});

	setupRouterSsrQueryIntegration({
		router,
		queryClient
	});

	return router;
}

declare module '@tanstack/react-router' {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
