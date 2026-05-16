import { getAuthSessionCookieOptions } from '@/lib/auth/session-cookie-options';
import { describe, expect, it } from '@jest/globals';
import type { Request } from 'express';

function makeRequest(params: { protocol: string; forwardedProto?: string }): Request {
	const headers: Record<string, string> = {};
	if (params.forwardedProto) {
		headers['x-forwarded-proto'] = params.forwardedProto;
	}

	return {
		headers,
		protocol: params.protocol
	} as unknown as Request;
}

describe('getAuthSessionCookieOptions', () => {
	it('uses the non-secure Auth.js session cookie for HTTP requests', () => {
		const cookie = getAuthSessionCookieOptions({
			request: makeRequest({ protocol: 'http' })
		});

		expect(cookie).toEqual({
			name: 'authjs.session-token',
			secure: false
		});
	});

	it('uses Auth.js secure-cookie mode for HTTPS forwarded requests', () => {
		const cookie = getAuthSessionCookieOptions({
			request: makeRequest({ protocol: 'http', forwardedProto: 'https' })
		});

		expect(cookie).toEqual({
			name: '__Secure-authjs.session-token',
			secure: true
		});
	});

	it('lets AUTH_URL take precedence over forwarded protocol like Auth.js does', () => {
		const cookie = getAuthSessionCookieOptions({
			authUrl: 'http://localhost:3000/api/auth',
			request: makeRequest({ protocol: 'http', forwardedProto: 'https' })
		});

		expect(cookie).toEqual({
			name: 'authjs.session-token',
			secure: false
		});
	});
});
