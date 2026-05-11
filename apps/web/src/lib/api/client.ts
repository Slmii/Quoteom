/**
 * Browser-only fetch wrapper for client-side HTTP to the API.
 *
 * Always uses relative URLs (the Vite dev proxy / prod reverse proxy forwards /api/*
 * to the NestJS API). Always credentialed. JSON-encodes object bodies.
 *
 * For server-side data fetching (SSR, loaders), use `createServerFn` handlers in
 * `src/server/*.server.ts` instead — they have access to the incoming Request and
 * can forward cookies, which a generic browser fetch cannot.
 */

interface ApiError {
	code: number;
	// API may return either a single string or class-validator array of messages.
	message: string | string[];
}

export class WrapperApiError extends Error {
	code: number;

	constructor(error: { code: number; message: string }) {
		super(error.message);
		this.code = error.code;
		this.name = 'WrapperApiError';
	}
}

function flattenMessage(input: string | string[] | undefined, fallback: string): string {
	if (Array.isArray(input)) {
		return input.join('; ');
	}

	if (typeof input === 'string') {
		return input;
	}

	return fallback;
}

interface ApiOptions extends Omit<RequestInit, 'body'> {
	body?: unknown;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
	const { body, headers, ...rest } = options;

	const response = await fetch(path, {
		credentials: 'include',
		headers: {
			...(body !== undefined && { 'Content-Type': 'application/json' }),
			...headers
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
		...rest
	});

	if (!response.ok) {
		const errorBody = (await response.json().catch(() => null)) as ApiError | null;
		throw new WrapperApiError({
			code: response.status,
			message: flattenMessage(errorBody?.message, response.statusText || 'Unknown error')
		});
	}

	if (response.status === 204) {
		return undefined as T;
	}

	return (await response.json()) as T;
}

/**
 * Auth.js's signin/signout endpoints expect application/x-www-form-urlencoded with a CSRF
 * token, and respond with 302 redirects. Browser fetch with `redirect: 'manual'` returns
 * an `opaqueredirect` response on success.
 */
export async function postForm(path: string, fields: Record<string, string>): Promise<void> {
	const body = new URLSearchParams(fields);

	const response = await fetch(path, {
		method: 'POST',
		credentials: 'include',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body,
		redirect: 'manual'
	});

	if (response.type === 'opaqueredirect' || response.ok) {
		return;
	}

	throw new WrapperApiError({
		code: response.status,
		message: await response.text().catch(() => 'Unknown error')
	});
}
