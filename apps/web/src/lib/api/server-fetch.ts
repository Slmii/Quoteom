import { getRequestHeader } from '@tanstack/react-start/server';

const API_URL = import.meta.env.VITE_API_URL;

/**
 * Server-side fetch wrapper for `createServerFn` handlers. Forwards the inbound request's
 * cookie header to the NestJS API so the session is preserved across the SSR boundary.
 *
 * Also forwards `x-forwarded-proto` and `x-forwarded-host` so Auth.js perceives the
 * request as the same protocol whether it's coming from the browser directly or from
 * Vite's SSR runtime. Without forwarding these, an HTTPS browser request that hits ngrok
 * gets the `__Secure-authjs.session-token` cookie set (Auth.js sees X-Forwarded-Proto:
 * https and goes into secure-cookie mode), but the SSR-side `fetch` to localhost:3001 has
 * no such header — Auth.js reverts to non-secure-cookie mode and looks for the WRONG
 * cookie name, returning `null` session. Manifests as "I just signed in, but the home
 * page bounces me back to /sign-in" during ngrok-tunneled dev testing.
 *
 * Use ONLY inside `createServerFn(...).handler(...)` — it depends on TanStack Start's
 * per-request `getRequestHeader` context, which only exists during a server handler call.
 */
export async function serverFetch(path: string, init: RequestInit = {}): Promise<Response> {
	const cookie = getRequestHeader('cookie');
	const forwardedProto = getRequestHeader('x-forwarded-proto');
	const forwardedHost = getRequestHeader('x-forwarded-host') ?? getRequestHeader('host');

	return fetch(`${API_URL}${path}`, {
		...init,
		headers: {
			...init.headers,
			...(cookie ? { cookie } : {}),
			...(forwardedProto ? { 'x-forwarded-proto': forwardedProto } : {}),
			...(forwardedHost ? { 'x-forwarded-host': forwardedHost } : {})
		}
	});
}
