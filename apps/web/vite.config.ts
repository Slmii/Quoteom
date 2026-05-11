import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import tsConfigPaths from 'vite-tsconfig-paths';

export default defineConfig(({ mode }) => {
	// Vite only injects env into `import.meta.env` for client code — not `process.env`.
	// Use loadEnv() to read .env into a real object for server-side config like the proxy.
	const env = loadEnv(mode, process.cwd(), '');
	const API_TARGET = env.VITE_API_URL;

	return {
		server: {
			port: 3000,
			// Dev proxy: anything under /api gets forwarded to the NestJS API. From the browser's
			// perspective every request is same-origin (localhost:3000), so Auth.js cookies are set
			// and sent without SameSite gymnastics.
			proxy: {
				'/api': {
					target: API_TARGET,
					// IMPORTANT: keep the original Host header (localhost:3000) so Auth.js
					// (with trustHost: true) builds redirect URLs pointing at the web origin
					// instead of the API origin. Otherwise expired/reused magic links
					// redirect to localhost:3001/sign-in (404 — API has no /sign-in route).
					changeOrigin: false
				}
			}
		},
		plugins: [
			tanstackStart(),
			// react's vite plugin must come after start's vite plugin
			viteReact(),
			tsConfigPaths({ projects: ['./tsconfig.json'] })
		]
	};
});
