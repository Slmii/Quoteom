const SERVER_API_URL = `${import.meta.env.VITE_API_URL}`;

/**
 * Base URL strategy:
 *  - In the browser: empty → relative paths → Vite proxy forwards /api/* to the NestJS API.
 *    From the browser's perspective everything is same-origin, so Auth.js cookies flow.
 *  - On the server (SSR): absolute → Node's fetch can't resolve relative URLs, so we target
 *    the API host directly. Cookies are forwarded from the incoming Request below.
 */
function baseUrl(): string {
	return typeof window === 'undefined' ? SERVER_API_URL : '';
}

/**
 * During SSR, forward the incoming user's cookies to the API so the server-side fetch
 * has the session credentials. Returns undefined on the client (browser handles its own).
 */
async function serverCookies(): Promise<string | undefined> {
	if (typeof window !== 'undefined') {
		return undefined;
	}

	try {
		const { getRequestHeader } = await import('@tanstack/react-start/server');
		return getRequestHeader('cookie') ?? undefined;
	} catch {
		return undefined;
	}
}

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

/** Fetch wrapper. Always credentialed; JSON-encodes the body if it's an object. */
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
	const { body, headers, ...rest } = options;
	const cookie = await serverCookies();

	const response = await fetch(`${baseUrl()}${path}`, {
		credentials: 'include',
		headers: {
			...(cookie && { cookie }),
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

/** Auth.js's signin/signout endpoints want application/x-www-form-urlencoded with a CSRF token. */
export async function postForm(path: string, fields: Record<string, string>): Promise<void> {
	const body = new URLSearchParams(fields);
	const cookie = await serverCookies();

	const response = await fetch(`${baseUrl()}${path}`, {
		method: 'POST',
		credentials: 'include',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			...(cookie && { cookie })
		},
		body,
		redirect: 'manual'
	});

	// Auth.js responds with a 302 to indicate success.
	//  - Browser fetch w/ redirect:'manual' → response.type === 'opaqueredirect'
	//  - Node fetch w/ redirect:'manual'    → response.status in [300..399]
	// Both signals indicate "the request worked, browser would have followed the redirect".
	const isManualRedirect = response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);

	if (isManualRedirect || response.ok) {
		return;
	}

	throw new WrapperApiError({
		code: response.status,
		message: await response.text().catch(() => 'Unknown error')
	});
}
