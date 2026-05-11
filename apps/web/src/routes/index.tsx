import { createFileRoute } from '@tanstack/react-router';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

interface HelloResponse {
	message: string;
	timestamp: string;
}

export const Route = createFileRoute('/')({
	loader: async (): Promise<HelloResponse> => {
		const res = await fetch(`${API_URL}/api/hello`);
		if (!res.ok) {
			throw new Error(`API responded with ${res.status}`);
		}

		return (await res.json()) as HelloResponse;
	},
	component: IndexComponent
});

function IndexComponent() {
	const data = Route.useLoaderData();

	return (
		<main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '60ch' }}>
			<h1>Quoteom</h1>
			<p>Stack check — response from the API:</p>
			<pre
				style={{
					background: '#f4f4f5',
					padding: '1rem',
					borderRadius: '0.5rem',
					overflowX: 'auto'
				}}
			>
				{JSON.stringify(data, null, 2)}
			</pre>
			<p style={{ color: '#6b7280', fontSize: '0.875rem' }}>
				If you can read this with a JSON payload above, the full stack is wired up: TanStack Start SSR → fetch →
				NestJS API → JSON response → hydration.
			</p>
		</main>
	);
}
