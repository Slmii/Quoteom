import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import tsConfigPaths from 'vite-tsconfig-paths';

const API_TARGET = `${process.env.VITE_API_URL}`;

export default defineConfig({
	server: {
		port: 3000,
		// Dev proxy: anything under /api gets forwarded to the NestJS API. From the browser's
		// perspective every request is same-origin (localhost:3000), so Auth.js cookies are set
		// and sent without SameSite gymnastics.
		proxy: {
			'/api': {
				target: API_TARGET,
				changeOrigin: true
			}
		}
	},
	plugins: [
		tanstackStart(),
		// react's vite plugin must come after start's vite plugin
		viteReact(),
		tsConfigPaths({ projects: ['./tsconfig.json'] })
	]
});
